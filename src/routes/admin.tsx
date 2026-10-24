import { type Context, Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { csrf } from "hono/csrf";
import { createMiddleware } from "hono/factory";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { type ApiRequestOptions, type ApiResult, callApi, createApiApp } from "../internal-api";
import { CSV_BOM, decodeCsv, formatCsv } from "../lib/csv";
import { notFound } from "../lib/errors";
import {
	IMPORT_COLUMNS,
	MAX_IMPORT_BYTES,
	MAX_IMPORT_ROWS,
	applySlugs,
	assignSlugs,
	generatedSlugsField,
	insertImport,
	readImportCsv,
	resultCsv,
	validateImport,
} from "../lib/url-import";
import type { AppEnv, UrlRow } from "../types";
import {
	type DomainCreateValues,
	DomainEditPage,
	type DomainEditValues,
	DomainsPage,
} from "../views/admin/domains";
import { FolderEditPage, type FolderValues, FoldersPage } from "../views/admin/folders";
import { ImportPage, ImportPreviewPage, ImportResultPage } from "../views/admin/import";
import type { Flash } from "../views/admin/layout";
import { parseJstInput } from "../views/admin/time";
import {
	type Pagination,
	URL_STATUS_FILTERS,
	type UrlCreateValues,
	UrlEditPage,
	type UrlEditValues,
	type UrlListQuery,
	type UrlStatusFilter,
	UrlsPage,
	listQueryString,
} from "../views/admin/urls";
import type { DomainResponse } from "./api/domains";
import type { FolderResponse } from "./api/folders";

/**
 * 管理画面。各画面をサーバー側でレンダリングし、更新はフォームの POST → 303 リダイレクトで行う。
 * データの読み書きは /api/* と同じハンドラーを内部から呼ぶ（バリデーションなどを二重に持たない）。
 */
const app = new Hono<AppEnv>();

type AdminContext = Context<AppEnv>;
type Api = <T>(method: string, path: string, options?: ApiRequestOptions) => Promise<ApiResult<T>>;

const PER_PAGE = 20;
const FLASH_COOKIE = "admin_flash";

// 他サイトの iframe に埋め込ませない（クリックジャッキング対策）。
// 枠の中からのフォーム送信は同一オリジンになるため、下の csrf() では防げない。
app.use("*", async (c, next) => {
	await next();
	c.header("X-Frame-Options", "DENY");
	c.header("Content-Security-Policy", "frame-ancestors 'none'");
});

app.use("*", async (c, next) => {
	if (c.get("domain") !== c.env.MAIN_DOMAIN) {
		return notFound("Not found");
	}
	return next();
});

// フォームの POST は Cloudflare Access の Cookie だけで認証されるため、別オリジンからの送信を拒否する。
app.use("*", csrf());

/** リクエストごとに、Access で認証したユーザーを principal とする内部 API を用意する */
function apiFor(c: AdminContext): Api {
	const email = c.get("email");
	const apiApp = createApiApp(
		createMiddleware<AppEnv>(async (ic, next) => {
			ic.set("email", email);
			return next();
		}),
	);
	let ctx: ExecutionContext | undefined;
	try {
		ctx = c.executionCtx;
	} catch {
		ctx = undefined;
	}
	return (method, path, options) => callApi(apiApp, c.env, ctx, method, path, options);
}

function setFlash(c: AdminContext, flash: Flash): void {
	setCookie(c, FLASH_COOKIE, JSON.stringify(flash), {
		path: "/admin",
		httpOnly: true,
		secure: new URL(c.req.url).protocol === "https:",
		sameSite: "Lax",
		maxAge: 60,
	});
}

/** 直前の操作のメッセージを取り出して Cookie を消す */
function takeFlash(c: AdminContext): Flash | null {
	const raw = getCookie(c, FLASH_COOKIE);
	if (raw === undefined) return null;
	deleteCookie(c, FLASH_COOKIE, { path: "/admin" });
	try {
		const parsed = JSON.parse(raw) as Partial<Flash>;
		if ((parsed.kind === "ok" || parsed.kind === "error") && typeof parsed.message === "string") {
			return { kind: parsed.kind, message: parsed.message };
		}
	} catch {
		// 壊れた Cookie は無視する
	}
	return null;
}

function redirectWithFlash(c: AdminContext, location: string, flash: Flash): Response {
	setFlash(c, flash);
	return c.redirect(location, 303);
}

function status(code: number): ContentfulStatusCode {
	return code as ContentfulStatusCode;
}

async function formFields(c: AdminContext): Promise<(name: string) => string> {
	const body = await c.req.parseBody();
	return (name) => {
		const value = body[name];
		return typeof value === "string" ? value : "";
	};
}

function parseListQuery(c: AdminContext): UrlListQuery {
	const rawStatus = c.req.query("status");
	const statusFilter = URL_STATUS_FILTERS.includes(rawStatus as UrlStatusFilter)
		? (rawStatus as UrlStatusFilter)
		: "active";
	const page = Number.parseInt(c.req.query("page") ?? "1", 10);
	const folder = c.req.query("folder_id") ?? "";
	return {
		status: statusFilter,
		domain: c.req.query("domain") || "all",
		folder: folder === "none" || /^[1-9][0-9]*$/.test(folder) ? folder : "",
		q: c.req.query("q") ?? "",
		page: Number.isFinite(page) && page > 1 ? page : 1,
	};
}

function listLocation(query: UrlListQuery): string {
	return `/admin/urls${listQueryString(query)}`;
}

async function listDomains(api: Api): Promise<ApiResult<{ data: DomainResponse[] }>> {
	return api<{ data: DomainResponse[] }>("GET", "/api/domains");
}

async function listFolders(api: Api): Promise<ApiResult<{ data: FolderResponse[] }>> {
	return api<{ data: FolderResponse[] }>("GET", "/api/folders");
}

/**
 * フォルダの select の値を API の folder_id / parent_id にする（"" = null）。
 * 数字以外はそのまま渡し、API のバリデーションでエラーにする。
 */
function folderIdValue(value: string): number | string | null {
	if (value === "") return null;
	return /^[0-9]+$/.test(value) ? Number(value) : value;
}

async function getUrl(api: Api, domain: string, slug: string): Promise<ApiResult<UrlRow>> {
	return api<UrlRow>("GET", `/api/urls/${encodeURIComponent(slug)}/stats`, { query: { domain } });
}

// ── 短縮 URL ──

async function renderUrls(
	c: AdminContext,
	api: Api,
	query: UrlListQuery,
	form: { values?: UrlCreateValues; error?: string } = {},
	code = 200,
): Promise<Response> {
	const [domains, folders, list] = await Promise.all([
		listDomains(api),
		listFolders(api),
		api<{ data: UrlRow[]; pagination: Pagination }>("GET", "/api/urls", {
			query: {
				status: query.status,
				domain: query.domain,
				folder_id: query.folder || undefined,
				q: query.q || undefined,
				page: query.page,
				per_page: PER_PAGE,
			},
		}),
	]);
	let flash = takeFlash(c);
	const failed = [domains, folders, list].find((r) => !r.ok);
	if (failed && !failed.ok) {
		flash = { kind: "error", message: `読み込みに失敗しました: ${failed.error}` };
	}
	const empty: Pagination = { page: 1, per_page: PER_PAGE, total: 0, total_pages: 0 };
	return c.html(
		<UrlsPage
			domains={domains.ok ? domains.data.data : []}
			folders={folders.ok ? folders.data.data : []}
			defaultDomain={query.domain !== "all" ? query.domain : c.env.MAIN_DOMAIN}
			query={query}
			urls={list.ok ? list.data.data : []}
			pagination={list.ok ? list.data.pagination : empty}
			flash={flash}
			values={form.values}
			error={form.error}
		/>,
		status(code),
	);
}

async function renderUrlEdit(
	c: AdminContext,
	api: Api,
	query: UrlListQuery,
	form: { values?: UrlEditValues; error?: string } = {},
	code = 200,
): Promise<Response> {
	const domain = c.req.param("domain") ?? "";
	const slug = c.req.param("slug") ?? "";
	const [result, folders] = await Promise.all([getUrl(api, domain, slug), listFolders(api)]);
	if (!result.ok) {
		return redirectWithFlash(c, listLocation(query), {
			kind: "error",
			message: `${domain}/${slug} を表示できませんでした: ${result.error}`,
		});
	}
	return c.html(
		<UrlEditPage
			row={result.data}
			folders={folders.ok ? folders.data.data : []}
			query={query}
			flash={
				folders.ok
					? takeFlash(c)
					: { kind: "error", message: `読み込みに失敗しました: ${folders.error}` }
			}
			values={form.values}
			error={form.error}
		/>,
		status(code),
	);
}

app.get("/", (c) => c.redirect("/admin/urls", 302));

app.get("/urls", (c) => renderUrls(c, apiFor(c), parseListQuery(c)));

app.post("/urls", async (c) => {
	const api = apiFor(c);
	const query = parseListQuery(c);
	const field = await formFields(c);
	const values: UrlCreateValues = {
		url: field("url").trim(),
		slug: field("slug").trim(),
		domain: field("domain"),
		expires_at: field("expires_at"),
		note: field("note").trim(),
		folder_id: field("folder_id"),
	};
	const fail = (error: string, code: number) => renderUrls(c, api, query, { values, error }, code);

	if (!values.url) {
		return fail("転送先 URL を入力してください。", 400);
	}
	const expiresAt = parseJstInput(values.expires_at);
	if (expiresAt === undefined) {
		return fail("有効期限の形式が正しくありません。", 400);
	}

	const result = await api<{ short_url: string }>("POST", "/api/shorten", {
		body: {
			url: values.url,
			slug: values.slug || undefined,
			domain: values.domain || undefined,
			expires_at: expiresAt ?? undefined,
			note: values.note || undefined,
			folder_id: folderIdValue(values.folder_id),
		},
	});
	if (!result.ok) {
		return fail(`作成できませんでした: ${result.error}`, result.status);
	}
	return redirectWithFlash(c, listLocation(query), {
		kind: "ok",
		message: `短縮 URL を作成しました: ${result.data.short_url}`,
	});
});

app.get("/urls/:domain/:slug", (c) => renderUrlEdit(c, apiFor(c), parseListQuery(c)));

app.post("/urls/:domain/:slug", async (c) => {
	const api = apiFor(c);
	const query = parseListQuery(c);
	const domain = c.req.param("domain");
	const slug = c.req.param("slug");
	const field = await formFields(c);
	const values: UrlEditValues = {
		target_url: field("target_url").trim(),
		expires_at: field("expires_at"),
		note: field("note").trim(),
		folder_id: field("folder_id"),
	};
	const fail = (error: string, code: number) =>
		renderUrlEdit(c, api, query, { values, error }, code);

	if (!values.target_url) {
		return fail("転送先 URL を入力してください。", 400);
	}
	const expiresAt = parseJstInput(values.expires_at);
	if (expiresAt === undefined) {
		return fail("有効期限の形式が正しくありません。", 400);
	}

	const result = await api<UrlRow>("PATCH", `/api/urls/${encodeURIComponent(slug)}`, {
		body: {
			target_url: values.target_url,
			expires_at: expiresAt,
			note: values.note || null,
			folder_id: folderIdValue(values.folder_id),
			domain,
		},
	});
	if (!result.ok) {
		return fail(`保存できませんでした: ${result.error}`, result.status);
	}
	return redirectWithFlash(c, listLocation(query), {
		kind: "ok",
		message: `${domain}/${slug} を更新しました。`,
	});
});

app.post("/urls/:domain/:slug/delete", async (c) => {
	const query = parseListQuery(c);
	const domain = c.req.param("domain");
	const slug = c.req.param("slug");
	const result = await apiFor(c)<null>("DELETE", `/api/urls/${encodeURIComponent(slug)}`, {
		query: { domain },
	});
	return redirectWithFlash(
		c,
		listLocation(query),
		result.ok
			? { kind: "ok", message: `${domain}/${slug} を削除しました。` }
			: { kind: "error", message: `削除できませんでした: ${result.error}` },
	);
});

app.post("/urls/:domain/:slug/restore", async (c) => {
	const query = parseListQuery(c);
	const domain = c.req.param("domain");
	const slug = c.req.param("slug");
	const result = await apiFor(c)<null>("POST", `/api/urls/${encodeURIComponent(slug)}/restore`, {
		query: { domain },
	});
	return redirectWithFlash(
		c,
		listLocation(query),
		result.ok
			? { kind: "ok", message: `${domain}/${slug} を復元しました。` }
			: { kind: "error", message: `復元できませんでした: ${result.error}` },
	);
});

// ── フォルダ ──

async function renderFolders(
	c: AdminContext,
	api: Api,
	form: { values?: FolderValues; error?: string } = {},
	code = 200,
): Promise<Response> {
	const result = await listFolders(api);
	const flash: Flash | null = result.ok
		? takeFlash(c)
		: { kind: "error", message: `読み込みに失敗しました: ${result.error}` };
	return c.html(
		<FoldersPage
			folders={result.ok ? result.data.data : []}
			flash={flash}
			values={form.values}
			error={form.error}
		/>,
		status(code),
	);
}

async function renderFolderEdit(
	c: AdminContext,
	api: Api,
	form: { values?: FolderValues; error?: string } = {},
	code = 200,
): Promise<Response> {
	const id = c.req.param("id") ?? "";
	const result = await listFolders(api);
	const folder = result.ok ? result.data.data.find((f) => String(f.id) === id) : undefined;
	if (!result.ok || !folder) {
		return redirectWithFlash(c, "/admin/folders", {
			kind: "error",
			message: `フォルダを表示できませんでした: ${result.ok ? "Folder not found" : result.error}`,
		});
	}
	return c.html(
		<FolderEditPage
			folder={folder}
			folders={result.data.data}
			flash={takeFlash(c)}
			values={form.values}
			error={form.error}
		/>,
		status(code),
	);
}

async function folderFormValues(c: AdminContext): Promise<FolderValues> {
	const field = await formFields(c);
	return { name: field("name").trim(), parent_id: field("parent_id") };
}

app.get("/folders", (c) => renderFolders(c, apiFor(c)));

app.post("/folders", async (c) => {
	const api = apiFor(c);
	const values = await folderFormValues(c);
	if (!values.name) {
		return renderFolders(c, api, { values, error: "名前を入力してください。" }, 400);
	}
	const result = await api<FolderResponse>("POST", "/api/folders", {
		body: { name: values.name, parent_id: folderIdValue(values.parent_id) },
	});
	if (!result.ok) {
		return renderFolders(
			c,
			api,
			{ values, error: `作成できませんでした: ${result.error}` },
			result.status,
		);
	}
	return redirectWithFlash(c, "/admin/folders", {
		kind: "ok",
		message: `フォルダ「${result.data.name}」を作成しました。`,
	});
});

app.get("/folders/:id", (c) => renderFolderEdit(c, apiFor(c)));

app.post("/folders/:id", async (c) => {
	const api = apiFor(c);
	const id = c.req.param("id");
	const values = await folderFormValues(c);
	const fail = (error: string, code: number) => renderFolderEdit(c, api, { values, error }, code);
	if (!values.name) {
		return fail("名前を入力してください。", 400);
	}
	const result = await api<FolderResponse>("PATCH", `/api/folders/${encodeURIComponent(id)}`, {
		body: { name: values.name, parent_id: folderIdValue(values.parent_id) },
	});
	if (!result.ok) {
		return fail(`保存できませんでした: ${result.error}`, result.status);
	}
	return redirectWithFlash(c, "/admin/folders", {
		kind: "ok",
		message: `フォルダ「${result.data.name}」を更新しました。`,
	});
});

app.post("/folders/:id/delete", async (c) => {
	const id = c.req.param("id");
	const result = await apiFor(c)<null>("DELETE", `/api/folders/${encodeURIComponent(id)}`);
	return redirectWithFlash(
		c,
		"/admin/folders",
		result.ok
			? { kind: "ok", message: "フォルダを削除しました。中の URL は未分類に戻りました。" }
			: { kind: "error", message: `削除できませんでした: ${result.error}` },
	);
});

// ── CSV インポート ──
// /api/* を経由せず D1 を直接使う（理由は src/lib/url-import.ts を参照）。

function renderImport(c: AdminContext, error?: string, code = 200): Response | Promise<Response> {
	return c.html(
		<ImportPage mainDomain={c.env.MAIN_DOMAIN} flash={takeFlash(c)} error={error} />,
		status(code),
	);
}

function csvDownload(c: AdminContext, filename: string, csv: string): Response {
	c.header("Content-Type", "text/csv; charset=utf-8");
	c.header("Content-Disposition", `attachment; filename="${filename}"`);
	return c.body(`${CSV_BOM}${csv}`);
}

app.get("/import", (c) => renderImport(c));

app.get("/import/template.csv", (c) =>
	csvDownload(c, "url-import-template.csv", formatCsv([[...IMPORT_COLUMNS]])),
);

app.post("/import", async (c) => {
	const body = await c.req.parseBody();
	const file = body.file;
	if (!(file instanceof File) || file.size === 0) {
		return renderImport(c, "CSV ファイルを選択してください。", 400);
	}
	if (file.size > MAX_IMPORT_BYTES) {
		return renderImport(c, "ファイルが大きすぎます。1 MB までにしてください。", 400);
	}
	const decoded = decodeCsv(await file.arrayBuffer());
	if (!decoded.ok) {
		return renderImport(c, decoded.error, 400);
	}
	const read = readImportCsv(decoded.text);
	if (!read.ok) {
		return renderImport(c, read.error, 400);
	}
	const rows = await validateImport(c.env.DB, read.inputs, c.env.MAIN_DOMAIN);
	if (rows.some((r) => r.errors.length > 0)) {
		return c.html(<ImportPreviewPage rows={rows} csv={decoded.text} slugs="" />, 400);
	}
	const assigned = await assignSlugs(c.env.DB, rows);
	return c.html(
		<ImportPreviewPage
			rows={rows}
			csv={decoded.text}
			slugs={generatedSlugsField(rows)}
			error={assigned.ok ? undefined : assigned.error}
		/>,
		assigned.ok ? 200 : 500,
	);
});

/**
 * 確認画面からの登録。CSV と自動生成したスラッグを読み直して検証し、問題が無ければ登録して
 * 結果画面を返す。結果画面を出すためリダイレクトはしないが、再送信しても全行が
 * 「既に使われています」になるだけで二重には登録されない。
 */
app.post("/import/commit", async (c) => {
	const field = await formFields(c);
	const csv = field("csv");
	// アップロード時の上限を超える長さは受け付けない（文字数はバイト数以下）
	if (csv === "" || csv.length > MAX_IMPORT_BYTES) {
		return renderImport(c, "CSV をアップロードし直してください。", 400);
	}
	const read = readImportCsv(csv);
	if (!read.ok) {
		return renderImport(c, read.error, 400);
	}
	if (!applySlugs(read.inputs, field("slugs"))) {
		return renderImport(
			c,
			"確認画面の内容が CSV と合いません。アップロードし直してください。",
			400,
		);
	}
	const rows = await validateImport(c.env.DB, read.inputs, c.env.MAIN_DOMAIN);
	const slugs = generatedSlugsField(rows);
	if (rows.some((r) => r.errors.length > 0)) {
		return c.html(<ImportPreviewPage rows={rows} csv={csv} slugs={slugs} />, 400);
	}
	const result = await insertImport(c.env.DB, rows);
	if (!result.ok) {
		return c.html(
			<ImportPreviewPage rows={rows} csv={csv} slugs={slugs} error={result.error} />,
			409,
		);
	}
	return c.html(<ImportResultPage rows={rows} />);
});

/** 結果画面から、作成した URL（"ドメイン/スラッグ" を 1 行に 1 つ）を CSV でダウンロードする */
app.post("/import/result.csv", async (c) => {
	const field = await formFields(c);
	const keys = field("urls")
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line !== "")
		.slice(0, MAX_IMPORT_ROWS)
		.flatMap((line) => {
			const i = line.indexOf("/");
			return i > 0 ? [{ domain: line.slice(0, i), slug: line.slice(i + 1) }] : [];
		});
	return csvDownload(c, "url-import-result.csv", await resultCsv(c.env.DB, keys));
});

// ── ドメイン ──

async function renderDomains(
	c: AdminContext,
	api: Api,
	form: { values?: DomainCreateValues; error?: string } = {},
	code = 200,
): Promise<Response> {
	const result = await listDomains(api);
	const flash: Flash | null = result.ok
		? takeFlash(c)
		: { kind: "error", message: `読み込みに失敗しました: ${result.error}` };
	return c.html(
		<DomainsPage
			domains={result.ok ? result.data.data : []}
			flash={flash}
			values={form.values}
			error={form.error}
		/>,
		status(code),
	);
}

async function findDomain(api: Api, domain: string): Promise<ApiResult<DomainResponse>> {
	const result = await listDomains(api);
	if (!result.ok) return result;
	const found = result.data.data.find((d) => d.domain === domain);
	return found
		? { ok: true, status: 200, data: found }
		: { ok: false, status: 404, error: "Domain not found" };
}

async function renderDomainEdit(
	c: AdminContext,
	api: Api,
	form: { values?: DomainEditValues; error?: string } = {},
	code = 200,
): Promise<Response> {
	const domain = c.req.param("domain") ?? "";
	const result = await findDomain(api, domain);
	if (!result.ok) {
		return redirectWithFlash(c, "/admin/domains", {
			kind: "error",
			message: `${domain} を表示できませんでした: ${result.error}`,
		});
	}
	return c.html(
		<DomainEditPage
			domain={result.data}
			flash={takeFlash(c)}
			values={form.values}
			error={form.error}
		/>,
		status(code),
	);
}

app.get("/domains", (c) => renderDomains(c, apiFor(c)));

app.post("/domains", async (c) => {
	const api = apiFor(c);
	const field = await formFields(c);
	const values: DomainCreateValues = {
		domain: field("domain").trim(),
		name: field("name").trim(),
		external: field("external") !== "",
	};
	if (!values.domain || !values.name) {
		return renderDomains(c, api, { values, error: "ドメインと表示名を入力してください。" }, 400);
	}

	const result = await api<DomainResponse>("POST", "/api/domains", { body: values });
	if (!result.ok) {
		return renderDomains(
			c,
			api,
			{ values, error: `追加できませんでした: ${result.error}` },
			result.status,
		);
	}
	return redirectWithFlash(c, "/admin/domains", {
		kind: "ok",
		message: values.external
			? `${values.domain} を追加しました。下に表示される DNS レコードをドメインの管理者に共有してください。`
			: `${values.domain} を追加しました。`,
	});
});

app.get("/domains/:domain", (c) => renderDomainEdit(c, apiFor(c)));

app.post("/domains/:domain", async (c) => {
	const api = apiFor(c);
	const domain = c.req.param("domain");
	const field = await formFields(c);
	const values: DomainEditValues = {
		name: field("name").trim(),
		gone_title: field("gone_title").trim(),
		gone_message: field("gone_message").trim(),
		gone_color: field("gone_color"),
		gone_logo_url: field("gone_logo_url").trim(),
		external: field("external") !== "",
	};
	const fail = (error: string, code: number) => renderDomainEdit(c, api, { values, error }, code);

	if (!values.name) {
		return fail("表示名を入力してください。", 400);
	}

	const current = await findDomain(api, domain);
	if (!current.ok) {
		return redirectWithFlash(c, "/admin/domains", {
			kind: "error",
			message: `保存できませんでした: ${current.error}`,
		});
	}

	// external は変更したときだけ送る（送るとカスタムホスト名の登録 / 削除が走るため）
	const externalChanged = values.external !== current.data.external;
	const result = await api<DomainResponse>("PATCH", `/api/domains/${encodeURIComponent(domain)}`, {
		body: {
			name: values.name,
			gone_title: values.gone_title,
			gone_message: values.gone_message,
			gone_color: values.gone_color,
			gone_logo_url: values.gone_logo_url || null,
			...(externalChanged ? { external: values.external } : {}),
		},
	});
	if (!result.ok) {
		return fail(`保存できませんでした: ${result.error}`, result.status);
	}
	return redirectWithFlash(c, "/admin/domains", {
		kind: "ok",
		message:
			externalChanged && values.external
				? `${domain} を更新しました。下に表示される DNS レコードをドメインの管理者に共有してください。`
				: `${domain} を更新しました。`,
	});
});

app.post("/domains/:domain/refresh", async (c) => {
	const domain = c.req.param("domain");
	const result = await apiFor(c)<DomainResponse & { verification_errors: string[] }>(
		"GET",
		`/api/domains/${encodeURIComponent(domain)}/hostname`,
	);
	if (!result.ok) {
		return redirectWithFlash(c, "/admin/domains", {
			kind: "error",
			message: `状態を更新できませんでした: ${result.error}`,
		});
	}
	const d = result.data;
	const errors = d.verification_errors.length
		? ` 検証エラー: ${d.verification_errors.join(" / ")}`
		: "";
	return redirectWithFlash(c, "/admin/domains", {
		kind: "ok",
		message: `${domain} の状態を更新しました（ホスト名: ${d.hostname_status ?? "不明"}、SSL: ${d.ssl_status ?? "不明"}）。${errors}`,
	});
});

app.post("/domains/:domain/delete", async (c) => {
	const domain = c.req.param("domain");
	const result = await apiFor(c)<null>("DELETE", `/api/domains/${encodeURIComponent(domain)}`);
	return redirectWithFlash(
		c,
		"/admin/domains",
		result.ok
			? { kind: "ok", message: `${domain} を削除しました。` }
			: { kind: "error", message: `削除できませんでした: ${result.error}` },
	);
});

export default app;
