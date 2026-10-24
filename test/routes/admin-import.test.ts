import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bindings, UrlRow } from "../../src/types";

vi.mock("jose", () => ({
	createRemoteJWKSet: () => {},
	jwtVerify: async () => ({
		payload: { email: "test@example.com" },
	}),
}));

import app from "../../src/index";
import { parseCsv } from "../../src/lib/csv";
import { cleanAll, seedDomain, seedFolder, seedUrl } from "../fixtures/seed";

declare module "cloudflare:test" {
	interface ProvidedEnv extends Bindings {
		TEST_MIGRATIONS: D1Migration[];
	}
}

const MAIN_DOMAIN = "s.example.com";
const OTHER_DOMAIN = "other.example.com";
const ORIGIN = `http://${MAIN_DOMAIN}`;

function getEnv() {
	return {
		DB: env.DB,
		TEAM_DOMAIN: "test-team.cloudflareaccess.com",
		POLICY_AUD: "test-aud-tag",
		MAIN_DOMAIN,
	};
}

function request(path: string, init: RequestInit = {}, origin: string | null = ORIGIN) {
	const headers = new Headers(init.headers);
	headers.set("Host", MAIN_DOMAIN);
	headers.set("Cf-Access-Jwt-Assertion", "mock-token");
	if (origin) headers.set("Origin", origin);
	return app.request(
		new Request(`http://${MAIN_DOMAIN}${path}`, { ...init, headers }),
		undefined,
		getEnv(),
	);
}

/** CSV ファイルを multipart/form-data でアップロードする */
function upload(content: string | Uint8Array, origin: string | null = ORIGIN) {
	const form = new FormData();
	form.set("file", new File([content], "urls.csv", { type: "text/csv" }));
	return request("/admin/import", { method: "POST", body: form }, origin);
}

function post(path: string, fields: Record<string, string>) {
	return request(path, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams(fields).toString(),
	});
}

function unescapeHtml(value: string): string {
	return value
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&amp;/g, "&");
}

/** 確認画面・結果画面の hidden の値 */
function hidden(html: string, name: string): string {
	const match = html.match(new RegExp(`name="${name}" value="([^"]*)"`));
	expect(match).not.toBeNull();
	return unescapeHtml(match?.[1] ?? "");
}

/** 確認画面の「登録」を押したときと同じ送信 */
function commit(preview: string) {
	return post("/admin/import/commit", {
		csv: hidden(preview, "csv"),
		slugs: hidden(preview, "slugs"),
	});
}

async function urlCount(): Promise<number> {
	const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM urls").first<{ n: number }>();
	return row?.n ?? 0;
}

async function getUrl(domain: string, slug: string): Promise<UrlRow | null> {
	return env.DB.prepare("SELECT * FROM urls WHERE domain = ? AND slug = ?")
		.bind(domain, slug)
		.first<UrlRow>();
}

beforeAll(async () => {
	await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
	await cleanAll(env.DB);
	await seedDomain(env.DB, { domain: MAIN_DOMAIN, name: "Main" });
	await seedDomain(env.DB, { domain: OTHER_DOMAIN, name: "Other" });
});

describe("import page", () => {
	it("is linked from the navigation and explains the format", async () => {
		const res = await request("/admin/import");
		expect(res.status).toBe(200);
		const body = await res.text();
		expect(body).toContain(
			'<a href="/admin/import" class="active" aria-current="page">CSV インポート</a>',
		);
		expect(body).toContain('enctype="multipart/form-data"');
		expect(body).toContain('href="/admin/import/template.csv"');
		expect(body).toContain("expires_at");
	});

	it("downloads an empty template with a BOM", async () => {
		const res = await request("/admin/import/template.csv");
		expect(res.status).toBe(200);
		expect(res.headers.get("Content-Type")).toBe("text/csv; charset=utf-8");
		expect(res.headers.get("Content-Disposition")).toBe(
			'attachment; filename="url-import-template.csv"',
		);
		const bytes = new Uint8Array(await res.arrayBuffer());
		expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
		expect(new TextDecoder().decode(bytes)).toBe("url,slug,domain,expires_at,note,folder\r\n");
	});

	it("rejects cross-origin uploads", async () => {
		const res = await upload("url\nhttps://example.com\n", "https://evil.example");
		expect(res.status).toBe(403);
	});
});

describe("preview and commit", () => {
	it("previews without registering, then registers every row", async () => {
		const parent = await seedFolder(env.DB, "イベント");
		const child = await seedFolder(env.DB, "2026", parent.id);
		const csv = [
			"URL,slug,domain,expires_at,note,folder",
			"https://example.com/a,spring,,2099/1/2 9:30,春,イベント / 2026",
			`https://example.com/b,,${OTHER_DOMAIN},,"カンマ, を含むメモ",`,
			"https://example.com/c?x=1,,,2099-01-01T00:00:00Z,,イベント",
			"",
		].join("\r\n");

		const res = await upload(csv);
		expect(res.status).toBe(200);
		const preview = await res.text();
		expect(preview).toContain("3 件の短縮 URL を作成します");
		expect(preview).toContain("3 件を登録");
		expect(preview).toContain("s.example.com/spring");
		expect(preview).toContain("2099-01-02 09:30");
		expect(preview).toContain("（自動生成）");
		expect(await urlCount()).toBe(0);

		const slugs = hidden(preview, "slugs").split("\n");
		expect(slugs).toHaveLength(3);
		expect(slugs[0]).toBe("");
		expect(slugs[1]).toMatch(/^[a-zA-Z0-9]{6}$/);
		expect(slugs[2]).toMatch(/^[a-zA-Z0-9]{6}$/);
		// 確認画面に出したスラッグがそのまま登録される
		expect(preview).toContain(`${OTHER_DOMAIN}/${slugs[1]}`);

		const done = await commit(preview);
		expect(done.status).toBe(200);
		const result = await done.text();
		expect(result).toContain("CSV から 3 件の短縮 URL を作成しました。");
		expect(result).toContain('action="/admin/import/result.csv"');
		expect(hidden(result, "urls")).toBe(
			[`${MAIN_DOMAIN}/spring`, `${OTHER_DOMAIN}/${slugs[1]}`, `${MAIN_DOMAIN}/${slugs[2]}`].join(
				"\n",
			),
		);

		const spring = await getUrl(MAIN_DOMAIN, "spring");
		expect(spring?.target_url).toBe("https://example.com/a");
		// 時刻は日本時間として解釈し、UTC で保存する
		expect(spring?.expires_at).toBe("2099-01-02T00:30:00.000Z");
		expect(spring?.note).toBe("春");
		expect(spring?.folder_id).toBe(child.id);

		const other = await getUrl(OTHER_DOMAIN, slugs[1]);
		expect(other?.note).toBe("カンマ, を含むメモ");
		expect(other?.expires_at).toBeNull();
		expect(other?.folder_id).toBeNull();

		const third = await getUrl(MAIN_DOMAIN, slugs[2]);
		expect(third?.target_url).toBe("https://example.com/c?x=1");
		expect(third?.expires_at).toBe("2099-01-01T00:00:00.000Z");
		expect(third?.folder_id).toBe(parent.id);
	});

	it("does not register twice when the commit is resubmitted", async () => {
		const preview = await (await upload("url\nhttps://example.com/once\n")).text();
		expect((await commit(preview)).status).toBe(200);
		const again = await commit(preview);
		expect(again.status).toBe(400);
		expect(await again.text()).toContain("既に使われています");
		expect(await urlCount()).toBe(1);
	});

	it("reads Shift_JIS files", async () => {
		const head = new TextEncoder().encode("url,note\r\nhttps://example.com,");
		// "テスト" の Shift_JIS
		const sjis = new Uint8Array([...head, 0x83, 0x65, 0x83, 0x58, 0x83, 0x67, 0x0d, 0x0a]);
		const preview = await (await upload(sjis)).text();
		expect(preview).toContain("テスト");
		expect((await commit(preview)).status).toBe(200);
		const row = await env.DB.prepare("SELECT note FROM urls").first<{ note: string }>();
		expect(row?.note).toBe("テスト");
	});

	it("checks more slugs than fit in one query", async () => {
		const lines = Array.from({ length: 150 }, (_, i) => `https://example.com/${i},bulk-${i}`);
		await seedUrl(env.DB, { slug: "bulk-140" });
		const res = await upload(["url,slug", ...lines].join("\n"));
		expect(res.status).toBe(400);
		const body = await res.text();
		expect(body).toContain("150 行のうち 1 行にエラーがあるため");
		expect(body).toContain("s.example.com/bulk-140 は既に使われています");

		await env.DB.prepare("DELETE FROM urls").run();
		const ok = await upload(["url,slug", ...lines].join("\n"));
		expect(ok.status).toBe(200);
		expect((await commit(await ok.text())).status).toBe(200);
		expect(await urlCount()).toBe(150);
	});

	it("re-validates on commit and registers nothing if the data changed", async () => {
		const preview = await (
			await upload("url,slug\nhttps://example.com/a,a1\nhttps://example.com/b,b1\n")
		).text();
		await seedUrl(env.DB, { slug: "b1" });
		const res = await commit(preview);
		expect(res.status).toBe(400);
		expect(await res.text()).toContain("s.example.com/b1 は既に使われています");
		expect(await urlCount()).toBe(1);
	});

	it("refuses generated slugs that do not match the CSV", async () => {
		const csv = "url,slug\nhttps://example.com/a,\nhttps://example.com/b,fixed\n";
		for (const slugs of ["", "abc", "abc\nother", "abc\nfixed\nextra"]) {
			const res = await post("/admin/import/commit", { csv, slugs });
			expect(res.status).toBe(400);
			expect(await res.text()).toContain("確認画面の内容が CSV と合いません");
		}
		expect(await urlCount()).toBe(0);
	});
});

describe("validation errors", () => {
	it("lists every invalid row and registers nothing", async () => {
		await seedFolder(env.DB, "既存");
		await seedUrl(env.DB, { slug: "taken" });
		await env.DB.prepare("UPDATE urls SET deleted_at = datetime('now')").run();
		const csv = [
			"url,slug,domain,expires_at,note,folder",
			"https://example.com/ok,good,,,,既存",
			"ftp://example.com,,,,,",
			"https://example.com/x,taken,,,,",
			"https://example.com/y,dup,,,,",
			"https://example.com/z,dup,,,,",
			"https://example.com/w,,unknown.example.com,,,",
			"https://example.com/v,,,2026-12-31,,",
			"https://example.com/u,,,,,存在しない / フォルダ",
			`https://example.com/t,,,,${"あ".repeat(501)},`,
			",admin,,,,",
			"https://example.com/s,,,,,,extra",
		].join("\n");

		const res = await upload(csv);
		expect(res.status).toBe(400);
		const body = await res.text();
		expect(body).toContain("11 行のうち 9 行にエラーがあるため、登録できません");
		expect(body).toContain("エラーの無い 2 行は表示を省いています");
		expect(body).not.toContain("example.com/ok");
		expect(body).not.toContain('action="/admin/import/commit"');
		expect(body).toContain("url が正しくありません: URL must use http or https protocol");
		expect(body).toContain("s.example.com/taken は既に使われています（削除済みを含む）");
		expect(body).toContain("5 行目と同じ短縮 URL です");
		expect(body).toContain("ドメイン unknown.example.com は登録されていません");
		expect(body).toContain("expires_at の形式が正しくありません");
		expect(body).toContain("フォルダ「存在しない / フォルダ」が見つかりません");
		expect(body).toContain("note は 500 文字以内にしてください");
		expect(body).toContain("url が空です");
		expect(body).toContain("slug が正しくありません: Slug is reserved");
		expect(body).toContain("見出しの無い列に値があります");
		expect(await urlCount()).toBe(1);
	});

	it("reports folders that cannot be identified", async () => {
		const a = await seedFolder(env.DB, "a");
		await seedFolder(env.DB, "b", a.id);
		await seedFolder(env.DB, "a/b");
		const body = await (await upload("url,folder\nhttps://example.com,a / b\n")).text();
		expect(body).toContain("フォルダ「a / b」が複数あり、どれか決められません");
	});

	it.each([
		["", "CSV ファイルを選択してください"],
		["url,slug\n", "データ行がありません"],
		["slug\nabc\n", "url 列がありません"],
		["url,expire_at\nhttps://example.com,x\n", "不明な列があります: expire_at"],
		["url,URL\nhttps://example.com,x\n", "列が重複しています: url"],
		['url,note\nhttps://example.com,"open\n', "2 行目: 引用符（&quot;）が閉じられていません"],
		[`url\n${"https://example.com\n".repeat(501)}`, "行数が多すぎます（501 行）"],
	])("rejects a malformed file (%#)", async (csv, message) => {
		const res = await upload(csv);
		expect(res.status).toBe(400);
		const body = await res.text();
		expect(body).toContain(message);
		expect(body).toContain('enctype="multipart/form-data"');
	});

	it("rejects files that are too large", async () => {
		const res = await upload(`url\n${"x".repeat(1024 * 1024)}\n`);
		expect(res.status).toBe(400);
		expect(await res.text()).toContain("ファイルが大きすぎます");
	});
});

describe("result CSV", () => {
	it("downloads the created URLs in the given order", async () => {
		const folder = await seedFolder(env.DB, "親");
		const child = await seedFolder(env.DB, "子", folder.id);
		await seedUrl(env.DB, {
			slug: "first",
			target_url: "https://example.com/?a=1,2",
			expires_at: "2099-01-01T15:30:00.000Z",
			note: 'say "hi"',
			folder_id: child.id,
		});
		await seedUrl(env.DB, { domain: OTHER_DOMAIN, slug: "second" });

		const res = await post("/admin/import/result.csv", {
			urls: `${OTHER_DOMAIN}/second\r\n${MAIN_DOMAIN}/first\r\n${MAIN_DOMAIN}/missing\r\nbroken`,
		});
		expect(res.status).toBe(200);
		expect(res.headers.get("Content-Type")).toBe("text/csv; charset=utf-8");
		expect(res.headers.get("Content-Disposition")).toBe(
			'attachment; filename="url-import-result.csv"',
		);
		const text = await res.text();
		expect(text.startsWith("﻿")).toBe(true);
		const parsed = parseCsv(text.slice(1));
		expect(parsed.ok && parsed.records.map((r) => r.cells)).toEqual([
			["short_url", "url", "slug", "domain", "expires_at", "note", "folder"],
			[`https://${OTHER_DOMAIN}/second`, "https://example.com", "second", OTHER_DOMAIN, "", "", ""],
			[
				`https://${MAIN_DOMAIN}/first`,
				"https://example.com/?a=1,2",
				"first",
				MAIN_DOMAIN,
				"2099-01-02 00:30",
				'say "hi"',
				"親 / 子",
			],
		]);
	});

	it("can be downloaded right after an import", async () => {
		const preview = await (
			await upload("url,note\nhttps://example.com/1,one\nhttps://example.com/2,two\n")
		).text();
		const result = await (await commit(preview)).text();
		const res = await post("/admin/import/result.csv", { urls: hidden(result, "urls") });
		const parsed = parseCsv((await res.text()).slice(1));
		const rows = parsed.ok ? parsed.records.slice(1).map((r) => r.cells) : [];
		expect(rows.map((r) => [r[1], r[5]])).toEqual([
			["https://example.com/1", "one"],
			["https://example.com/2", "two"],
		]);
		const slugs = hidden(preview, "slugs").split("\n");
		expect(rows.map((r) => r[0])).toEqual(slugs.map((s) => `https://${MAIN_DOMAIN}/${s}`));
	});
});
