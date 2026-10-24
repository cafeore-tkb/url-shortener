import type { UrlRow } from "../types";
import { formatJst, parseJstDateTime } from "../views/admin/time";
import { formatCsv, parseCsv } from "./csv";
import { generateSlug } from "./slug-generator";
import { validateSlug, validateTargetUrl } from "./validation";

/**
 * 管理画面の CSV インポート（短縮 URL の一括作成）。
 *
 * ほかの管理画面の操作と違って /api/* を経由せず D1 を直接使う。/api/shorten を行数分呼ぶと
 * 1 回の Worker 実行で発行できるクエリ数の上限（Free: 50 / Paid: 1,000）にすぐ届くうえ、
 * 途中で失敗したときに作成済みの行が残るため。検証は /api/shorten と同じ関数を使い、
 * 登録は db.batch() で 1 回にまとめる（batch は上限に対して 1 クエリと数えられ、
 * 1 つでも失敗すると全体がロールバックされる）。
 *
 * 流れ: アップロード → readImportCsv → validateImport → assignSlugs（確認画面）
 *       → 登録: readImportCsv → applySlugs → validateImport → insertImport
 * スラッグが空の行のスラッグは確認画面の時点で決め、確認画面から CSV と一緒に送り返してもらう。
 * 登録時には全行がスラッグ指定済みとして検証されるので、同じ登録を 2 回送っても重複エラーになる。
 */

export const IMPORT_COLUMNS = ["url", "slug", "domain", "expires_at", "note", "folder"] as const;
export type ImportColumn = (typeof IMPORT_COLUMNS)[number];

/** 結果 CSV の列。インポートの列に作成した短縮 URL を加えたもの（そのまま読み直せる形式で書く） */
export const RESULT_COLUMNS = ["short_url", ...IMPORT_COLUMNS] as const;

/** 1 回に取り込める行数（見出し行・空行を除く） */
export const MAX_IMPORT_ROWS = 500;
/** アップロードできるファイルの大きさ */
export const MAX_IMPORT_BYTES = 1024 * 1024;

const MAX_NOTE_LENGTH = 500;
/** D1 の 1 クエリあたりのバインド上限（100）から domain の分を引いた数 */
const SLUGS_PER_QUERY = 99;
const SLUG_ATTEMPTS = 5;

/** CSV の 1 行（見出しに対応付けた値。前後の空白は除く） */
export type ImportInput = {
	line: number;
	values: Record<ImportColumn, string>;
	/** 見出しの無い列に値がある */
	extra: boolean;
	/** values.slug が自動生成したものか */
	generated: boolean;
};

/** 検証した 1 行。errors が空なら登録できる */
export type ImportRow = ImportInput & {
	/** domain 列が空なら既定のドメイン */
	domain: string;
	/** UTC の ISO 8601。null = 期限なし、undefined = 形式が不正 */
	expires_at: string | null | undefined;
	folder_id: number | null;
	errors: string[];
};

export type ReadResult = { ok: true; inputs: ImportInput[] } | { ok: false; error: string };

export type ImportResult = { ok: true } | { ok: false; error: string };

type FolderNode = { id: number; name: string; parent_id: number | null };

export type UrlKey = { domain: string; slug: string };

function urlKey(domain: string, slug: string): string {
	return `${domain}\n${slug}`;
}

/** フォルダのパス（"親 / 子"）を、区切りの前後の空白と空の階層を除いた形にそろえる */
function normalizeFolderPath(path: string): string {
	return path
		.split("/")
		.map((s) => s.trim())
		.filter((s) => s !== "")
		.join("/");
}

/** フォルダ ID → "親 / 子" 形式のパス */
function folderPaths(folders: FolderNode[]): Map<number, string> {
	const byId = new Map(folders.map((f) => [f.id, f]));
	const paths = new Map<number, string>();
	for (const folder of folders) {
		const names: string[] = [];
		// parent_id が循環していても止まるよう、たどったフォルダを覚えておく
		const seen = new Set<number>();
		let current: FolderNode | undefined = folder;
		while (current && !seen.has(current.id)) {
			seen.add(current.id);
			names.unshift(current.name);
			current = current.parent_id === null ? undefined : byId.get(current.parent_id);
		}
		paths.set(folder.id, names.join(" / "));
	}
	return paths;
}

/** そろえたパス → フォルダ ID。名前に "/" を含むフォルダがあると同じパスに複数の ID が入りうる */
function folderPathIndex(folders: FolderNode[]): Map<string, number[]> {
	const index = new Map<string, number[]>();
	for (const [id, path] of folderPaths(folders)) {
		const key = normalizeFolderPath(path);
		index.set(key, [...(index.get(key) ?? []), id]);
	}
	return index;
}

async function loadFolders(db: D1Database): Promise<FolderNode[]> {
	const result = await db.prepare("SELECT id, name, parent_id FROM folders").all<FolderNode>();
	return result.results;
}

/** 見出し行で列を対応付け、データ行を取り出す。ファイル全体に関わる問題はここでエラーにする */
export function readImportCsv(text: string): ReadResult {
	const parsed = parseCsv(text);
	if (!parsed.ok) {
		return { ok: false, error: `${parsed.line} 行目: ${parsed.error}` };
	}
	const records = parsed.records.filter((r) => r.cells.some((cell) => cell.trim() !== ""));
	const [header, ...rows] = records;
	if (!header) {
		return { ok: false, error: "CSV が空です。" };
	}

	const names = header.cells.map((cell) => cell.trim().toLowerCase());
	const unknown = names.filter((n) => n !== "" && !IMPORT_COLUMNS.includes(n as ImportColumn));
	if (unknown.length > 0) {
		return {
			ok: false,
			error: `${header.line} 行目（見出し行）に不明な列があります: ${unknown.join(", ")}（使える列: ${IMPORT_COLUMNS.join(", ")}）`,
		};
	}
	const duplicated = names.filter((n, i) => n !== "" && names.indexOf(n) !== i);
	if (duplicated.length > 0) {
		return {
			ok: false,
			error: `${header.line} 行目（見出し行）で列が重複しています: ${[...new Set(duplicated)].join(", ")}`,
		};
	}
	if (!names.includes("url")) {
		return { ok: false, error: `${header.line} 行目（見出し行）に url 列がありません。` };
	}
	if (rows.length === 0) {
		return { ok: false, error: "データ行がありません。" };
	}
	if (rows.length > MAX_IMPORT_ROWS) {
		return {
			ok: false,
			error: `行数が多すぎます（${rows.length} 行）。1 回に取り込めるのは ${MAX_IMPORT_ROWS} 行までです。`,
		};
	}

	const inputs = rows.map((row): ImportInput => {
		const values = Object.fromEntries(IMPORT_COLUMNS.map((col) => [col, ""])) as Record<
			ImportColumn,
			string
		>;
		let extra = false;
		row.cells.forEach((cell, i) => {
			const name = names[i];
			if (name) {
				values[name as ImportColumn] = cell.trim();
			} else if (cell.trim() !== "") {
				extra = true;
			}
		});
		return { line: row.line, values, extra, generated: false };
	});
	return { ok: true, inputs };
}

/** 既に urls にある (domain, slug) の組（削除済みを含む） */
async function existingUrlKeys(db: D1Database, keys: UrlKey[]): Promise<Set<string>> {
	const rows = await findUrls(db, keys, "domain, slug");
	return new Set(rows.map((row) => urlKey(row.domain, row.slug)));
}

/** (domain, slug) の組で urls を引く。バインド上限に収まるよう分けて 1 回の batch で送る */
async function findUrls<T extends Pick<UrlRow, "domain" | "slug">>(
	db: D1Database,
	keys: UrlKey[],
	columns: string,
): Promise<T[]> {
	const byDomain = new Map<string, Set<string>>();
	for (const { domain, slug } of keys) {
		const slugs = byDomain.get(domain) ?? new Set<string>();
		slugs.add(slug);
		byDomain.set(domain, slugs);
	}
	const statements: D1PreparedStatement[] = [];
	for (const [domain, slugSet] of byDomain) {
		const slugs = [...slugSet];
		for (let i = 0; i < slugs.length; i += SLUGS_PER_QUERY) {
			const chunk = slugs.slice(i, i + SLUGS_PER_QUERY);
			statements.push(
				db
					.prepare(
						`SELECT ${columns} FROM urls WHERE domain = ? AND slug IN (${chunk.map(() => "?").join(", ")})`,
					)
					.bind(domain, ...chunk),
			);
		}
	}
	if (statements.length === 0) return [];
	const results = await db.batch<T>(statements);
	return results.flatMap((r) => r.results);
}

/**
 * 各行を検証する。/api/shorten と同じ検査に加えて、CSV の中でのスラッグの重複も見る。
 * defaultDomain は domain 列が空の行に使うドメイン。
 */
export async function validateImport(
	db: D1Database,
	inputs: ImportInput[],
	defaultDomain: string,
): Promise<ImportRow[]> {
	const [domainResult, folderResult] = await db.batch<Record<string, unknown>>([
		db.prepare("SELECT domain FROM domains"),
		db.prepare("SELECT id, name, parent_id FROM folders"),
	]);
	const domains = new Set((domainResult.results as { domain: string }[]).map((d) => d.domain));
	const folderIndex = folderPathIndex(folderResult.results as FolderNode[]);

	const rows = inputs.map((input): ImportRow => {
		const { values } = input;
		const errors: string[] = [];
		if (input.extra) {
			errors.push('見出しの無い列に値があります（値にカンマを含む場合は " で囲んでください）。');
		}

		if (values.url === "") {
			errors.push("url が空です。");
		} else {
			const result = validateTargetUrl(values.url);
			if (!result.valid) errors.push(`url が正しくありません: ${result.reason}`);
		}

		if (values.slug !== "") {
			const result = validateSlug(values.slug);
			if (!result.valid) errors.push(`slug が正しくありません: ${result.reason}`);
		}

		const domain = values.domain || defaultDomain;
		if (!domains.has(domain)) {
			errors.push(`ドメイン ${domain} は登録されていません。`);
		}

		const expiresAt = parseJstDateTime(values.expires_at);
		if (expiresAt === undefined) {
			errors.push(
				"expires_at の形式が正しくありません（例: 2026-12-31 23:59。日付だけでなく時刻も書いてください）。",
			);
		}

		if (values.note.length > MAX_NOTE_LENGTH) {
			errors.push(`note は ${MAX_NOTE_LENGTH} 文字以内にしてください。`);
		}

		let folderId: number | null = null;
		if (values.folder !== "") {
			const ids = folderIndex.get(normalizeFolderPath(values.folder)) ?? [];
			if (ids.length === 1) {
				folderId = ids[0];
			} else if (ids.length === 0) {
				errors.push(`フォルダ「${values.folder}」が見つかりません。`);
			} else {
				errors.push(`フォルダ「${values.folder}」が複数あり、どれか決められません。`);
			}
		}

		return { ...input, domain, expires_at: expiresAt, folder_id: folderId, errors };
	});

	// スラッグを指定した行の重複（CSV の中・登録済みの URL）
	const checkable = rows.filter(
		(r) => r.values.slug !== "" && validateSlug(r.values.slug).valid && domains.has(r.domain),
	);
	const firstLine = new Map<string, number>();
	for (const row of checkable) {
		const key = urlKey(row.domain, row.values.slug);
		const first = firstLine.get(key);
		if (first === undefined) {
			firstLine.set(key, row.line);
		} else {
			row.errors.push(`${first} 行目と同じ短縮 URL です。`);
		}
	}
	const existing = await existingUrlKeys(
		db,
		checkable.map((r) => ({ domain: r.domain, slug: r.values.slug })),
	);
	for (const row of checkable) {
		if (existing.has(urlKey(row.domain, row.values.slug))) {
			row.errors.push(`${row.domain}/${row.values.slug} は既に使われています（削除済みを含む）。`);
		}
	}

	return rows;
}

/**
 * スラッグが空の行にランダムなスラッグを割り当てる（rows を書き換える）。
 * 登録済みの URL・ほかの行と重ならないものを選ぶ。
 */
export async function assignSlugs(db: D1Database, rows: ImportRow[]): Promise<ImportResult> {
	const taken = new Set(
		rows.filter((r) => r.values.slug !== "").map((r) => urlKey(r.domain, r.values.slug)),
	);
	let pending = rows.filter((r) => r.values.slug === "");

	for (let attempt = 0; attempt < SLUG_ATTEMPTS && pending.length > 0; attempt++) {
		for (const row of pending) {
			let slug = generateSlug();
			while (taken.has(urlKey(row.domain, slug))) slug = generateSlug();
			row.values.slug = slug;
			row.generated = true;
			taken.add(urlKey(row.domain, slug));
		}
		const existing = await existingUrlKeys(
			db,
			pending.map((r) => ({ domain: r.domain, slug: r.values.slug })),
		);
		pending = pending.filter((r) => existing.has(urlKey(r.domain, r.values.slug)));
	}
	if (pending.length > 0) {
		return { ok: false, error: "スラッグを生成できませんでした。もう一度お試しください。" };
	}
	return { ok: true };
}

/** 確認画面に持たせる、自動生成したスラッグの一覧（行の順、指定済みの行は空） */
export function generatedSlugsField(rows: ImportInput[]): string {
	return rows.map((r) => (r.generated ? r.values.slug : "")).join("\n");
}

/**
 * 確認画面から送り返された自動生成のスラッグを、スラッグが空の行に入れる（inputs を書き換える）。
 * 行数やスラッグの有無が CSV と合わなければ false。
 */
export function applySlugs(inputs: ImportInput[], field: string): boolean {
	const slugs = field.split(/\r?\n/);
	if (slugs.length !== inputs.length) return false;
	for (const [i, input] of inputs.entries()) {
		const slug = slugs[i].trim();
		if ((input.values.slug === "") !== (slug !== "")) return false;
		if (slug !== "") {
			input.values.slug = slug;
			input.generated = true;
		}
	}
	return true;
}

/** スラッグがすべて決まった検証済みの行（errors がすべて空）を 1 つのトランザクションで登録する */
export async function insertImport(db: D1Database, rows: ImportRow[]): Promise<ImportResult> {
	const insert = db.prepare(
		"INSERT INTO urls (domain, slug, target_url, expires_at, note, folder_id) VALUES (?, ?, ?, ?, ?, ?)",
	);
	try {
		await db.batch(
			rows.map((r) =>
				insert.bind(
					r.domain,
					r.values.slug,
					r.values.url,
					r.expires_at ?? null,
					r.values.note || null,
					r.folder_id,
				),
			),
		);
	} catch (e) {
		// 確認してから登録するまでの間に、同じスラッグの URL が作られた・フォルダが消されたなど
		const reason = e instanceof Error ? e.message : String(e);
		return { ok: false, error: `登録できませんでした。1 件も登録していません（${reason}）。` };
	}
	return { ok: true };
}

/**
 * 指定した URL を結果 CSV（RESULT_COLUMNS）にする。並びは keys の順で、見つからないものは省く。
 * 日時は日本時間、フォルダはパスで書くので、列を削ればそのままインポートに使える。
 */
export async function resultCsv(db: D1Database, keys: UrlKey[]): Promise<string> {
	const [urls, folders] = await Promise.all([findUrls<UrlRow>(db, keys, "*"), loadFolders(db)]);
	const byKey = new Map(urls.map((u) => [urlKey(u.domain, u.slug), u]));
	const paths = folderPaths(folders);
	const lines: string[][] = [[...RESULT_COLUMNS]];
	for (const { domain, slug } of keys) {
		const u = byKey.get(urlKey(domain, slug));
		if (!u) continue;
		lines.push([
			`https://${u.domain}/${u.slug}`,
			u.target_url,
			u.slug,
			u.domain,
			u.expires_at ? formatJst(u.expires_at) : "",
			u.note ?? "",
			u.folder_id === null ? "" : (paths.get(u.folder_id) ?? ""),
		]);
	}
	return formatCsv(lines);
}
