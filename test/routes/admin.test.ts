import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bindings } from "../../src/types";

vi.mock("jose", () => ({
	createRemoteJWKSet: () => {},
	jwtVerify: async () => ({
		payload: { email: "test@example.com" },
	}),
}));

import app from "../../src/index";
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

function get(
	path: string,
	{ host = MAIN_DOMAIN, cookie }: { host?: string; cookie?: string } = {},
) {
	const headers: Record<string, string> = { Host: host, "Cf-Access-Jwt-Assertion": "mock-token" };
	if (cookie) headers.Cookie = cookie;
	return app.request(new Request(`http://${host}${path}`, { headers }), undefined, getEnv());
}

function post(
	path: string,
	fields: Record<string, string> = {},
	{ origin = ORIGIN }: { origin?: string | null } = {},
) {
	const headers: Record<string, string> = {
		Host: MAIN_DOMAIN,
		"Cf-Access-Jwt-Assertion": "mock-token",
		"Content-Type": "application/x-www-form-urlencoded",
	};
	if (origin) headers.Origin = origin;
	return app.request(
		new Request(`http://${MAIN_DOMAIN}${path}`, {
			method: "POST",
			headers,
			body: new URLSearchParams(fields).toString(),
		}),
		undefined,
		getEnv(),
	);
}

/** レスポンスの Set-Cookie から管理画面のフラッシュ Cookie を取り出す（"name=value"） */
function flashCookie(res: Response): string {
	const header = res.headers.get("Set-Cookie") ?? "";
	const match = header.match(/admin_flash=[^;]*/);
	expect(match).not.toBeNull();
	return match?.[0] ?? "";
}

/** POST → 303 の後、リダイレクト先をフラッシュ Cookie 付きで開いた HTML */
async function follow(res: Response): Promise<string> {
	expect(res.status).toBe(303);
	const location = res.headers.get("Location") ?? "";
	const next = await get(location, { cookie: flashCookie(res) });
	expect(next.status).toBe(200);
	return next.text();
}

beforeAll(async () => {
	await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
	await cleanAll(env.DB);
	await seedDomain(env.DB, { domain: MAIN_DOMAIN, name: "Main" });
	await seedDomain(env.DB, { domain: OTHER_DOMAIN, name: "Other" });
});

describe("routing", () => {
	it("GET /admin redirects to /admin/urls", async () => {
		const res = await get("/admin");
		expect(res.status).toBe(302);
		expect(res.headers.get("Location")).toBe("/admin/urls");
	});

	it("serves Japanese HTML pages", async () => {
		for (const path of ["/admin/urls", "/admin/domains"]) {
			const res = await get(path);
			expect(res.status).toBe(200);
			expect(res.headers.get("Content-Type")).toContain("text/html");
			const body = await res.text();
			expect(body.startsWith("<!DOCTYPE html>")).toBe(true);
			expect(body).toContain('<html lang="ja">');
			expect(body).toContain("URL 短縮 管理画面");
		}
	});

	it("marks the current section in the navigation", async () => {
		const body = await (await get("/admin/domains")).text();
		expect(body).toContain(
			'<a href="/admin/domains" class="active" aria-current="page">ドメイン</a>',
		);
	});

	it("returns 404 on non-MAIN_DOMAIN", async () => {
		for (const path of ["/admin", "/admin/urls", "/admin/domains"]) {
			const res = await get(path, { host: OTHER_DOMAIN });
			expect(res.status).toBe(404);
		}
	});

	it("requires authentication", async () => {
		const res = await app.request(
			new Request(`http://${MAIN_DOMAIN}/admin/urls`, { headers: { Host: MAIN_DOMAIN } }),
			undefined,
			getEnv(),
		);
		expect(res.status).toBe(401);
	});

	it("rejects cross-origin form posts", async () => {
		const res = await post(
			"/admin/urls",
			{ url: "https://example.com" },
			{ origin: "https://evil.example" },
		);
		expect(res.status).toBe(403);
		const missing = await post("/admin/urls", { url: "https://example.com" }, { origin: null });
		expect(missing.status).toBe(403);
		const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM urls").first<{ n: number }>();
		expect(count?.n).toBe(0);
	});

	it("forbids embedding the pages in a frame", async () => {
		for (const res of [
			await get("/admin/urls"),
			await post("/admin/urls", { url: "https://example.com" }),
		]) {
			expect(res.headers.get("X-Frame-Options")).toBe("DENY");
			expect(res.headers.get("Content-Security-Policy")).toBe("frame-ancestors 'none'");
		}
	});
});

describe("short URLs", () => {
	it("lists URLs with Japanese labels and escapes user content", async () => {
		await seedUrl(env.DB, {
			slug: "hello",
			target_url: "https://example.com/a",
			note: "<script>x</script>",
		});
		const body = await (await get("/admin/urls")).text();
		expect(body).toContain("s.example.com/hello");
		expect(body).toContain("https://example.com/a");
		expect(body).toContain("有効");
		expect(body).toContain("&lt;script&gt;x&lt;/script&gt;");
		expect(body).not.toContain("<script>x</script>");
	});

	it("filters by status, domain and search query", async () => {
		await seedUrl(env.DB, { slug: "alive", target_url: "https://example.com/alive" });
		await seedUrl(env.DB, { slug: "gone", target_url: "https://example.com/gone" });
		await seedUrl(env.DB, { domain: OTHER_DOMAIN, slug: "elsewhere" });
		await env.DB.prepare("UPDATE urls SET deleted_at = datetime('now') WHERE slug = 'gone'").run();

		const active = await (await get("/admin/urls")).text();
		expect(active).toContain("s.example.com/alive");
		expect(active).toContain("other.example.com/elsewhere");
		expect(active).not.toContain("s.example.com/gone");

		const deleted = await (await get("/admin/urls?status=deleted")).text();
		expect(deleted).toContain("s.example.com/gone");
		expect(deleted).not.toContain("s.example.com/alive");
		expect(deleted).toContain("復元");

		const other = await (await get(`/admin/urls?domain=${OTHER_DOMAIN}`)).text();
		expect(other).toContain("other.example.com/elsewhere");
		expect(other).not.toContain("s.example.com/alive");

		const searched = await (await get("/admin/urls?q=aliv")).text();
		expect(searched).toContain("s.example.com/alive");
		expect(searched).not.toContain("other.example.com/elsewhere");
	});

	it("paginates with links that keep the filters", async () => {
		for (let i = 0; i < 21; i++) {
			await seedUrl(env.DB, { slug: `s${i}`, note: "paged" });
		}
		const first = await (await get("/admin/urls?q=paged")).text();
		expect(first).toContain("1 / 2 ページ（全 21 件）");
		expect(first).toContain('href="/admin/urls?q=paged&amp;page=2"');
		const second = await (await get("/admin/urls?q=paged&page=2")).text();
		expect(second).toContain("2 / 2 ページ");
		expect(second).toContain('href="/admin/urls?q=paged"');
	});

	it("creates a URL and shows the result after redirect", async () => {
		const res = await post("/admin/urls?status=all", {
			url: "https://example.com/new",
			slug: "fresh",
			domain: OTHER_DOMAIN,
			expires_at: "2099-01-02T09:30",
			note: "メモ",
		});
		expect(res.headers.get("Location")).toBe("/admin/urls?status=all");
		const body = await follow(res);
		expect(body).toContain("短縮 URL を作成しました: https://other.example.com/fresh");

		const row = await env.DB.prepare("SELECT * FROM urls WHERE slug = 'fresh'").first<{
			domain: string;
			expires_at: string;
			note: string;
		}>();
		expect(row?.domain).toBe(OTHER_DOMAIN);
		// 入力は日本時間として解釈し、UTC で保存する
		expect(row?.expires_at).toBe("2099-01-02T00:30:00.000Z");
		expect(row?.note).toBe("メモ");
	});

	it("shows the flash message only once", async () => {
		const res = await post("/admin/urls", { url: "https://example.com/once" });
		const cookie = flashCookie(res);
		const first = await get("/admin/urls", { cookie });
		expect(await first.text()).toContain("短縮 URL を作成しました");
		expect(first.headers.get("Set-Cookie")).toMatch(/admin_flash=;.*Max-Age=0/);
	});

	it("re-renders the form with the API error and keeps the input", async () => {
		await seedUrl(env.DB, { slug: "taken" });
		const res = await post("/admin/urls", {
			url: "https://example.com/dup",
			slug: "taken",
			note: "keep me",
		});
		expect(res.status).toBe(409);
		const body = await res.text();
		expect(body).toContain("作成できませんでした: Slug already exists");
		expect(body).toContain('value="https://example.com/dup"');
		expect(body).toContain('value="keep me"');
	});

	it("validates required fields in Japanese", async () => {
		const res = await post("/admin/urls", { url: "" });
		expect(res.status).toBe(400);
		expect(await res.text()).toContain("転送先 URL を入力してください。");

		const bad = await post("/admin/urls", { url: "https://example.com", expires_at: "tomorrow" });
		expect(bad.status).toBe(400);
		expect(await bad.text()).toContain("有効期限の形式が正しくありません。");
	});

	it("shows the edit page with the expiry in JST", async () => {
		await seedUrl(env.DB, { slug: "edit-me", expires_at: "2099-01-01T15:00:00.000Z", note: "old" });
		const res = await get(`/admin/urls/${MAIN_DOMAIN}/edit-me`);
		expect(res.status).toBe(200);
		const body = await res.text();
		expect(body).toContain("短縮 URL を編集: s.example.com/edit-me");
		expect(body).toContain('value="2099-01-02T00:00"');
		expect(body).toContain(">old</textarea>");
	});

	it("updates a URL and returns to the filtered list", async () => {
		await seedUrl(env.DB, { slug: "edit-me", expires_at: "2099-01-01T00:00:00.000Z", note: "old" });
		const res = await post(`/admin/urls/${MAIN_DOMAIN}/edit-me?q=edit`, {
			target_url: "https://example.com/updated",
			expires_at: "",
			note: "",
		});
		expect(res.headers.get("Location")).toBe("/admin/urls?q=edit");
		expect(await follow(res)).toContain("s.example.com/edit-me を更新しました。");

		const row = await env.DB.prepare("SELECT * FROM urls WHERE slug = 'edit-me'").first<{
			target_url: string;
			expires_at: string | null;
			note: string | null;
		}>();
		expect(row).toMatchObject({
			target_url: "https://example.com/updated",
			expires_at: null,
			note: null,
		});
	});

	it("re-renders the edit page on API validation errors", async () => {
		await seedUrl(env.DB, { slug: "edit-me" });
		const res = await post(`/admin/urls/${MAIN_DOMAIN}/edit-me`, {
			target_url: "ftp://example.com",
		});
		expect(res.status).toBe(400);
		const body = await res.text();
		expect(body).toContain("保存できませんでした: URL must use http or https protocol");
		expect(body).toContain('value="ftp://example.com"');
	});

	it("redirects to the list when the URL does not exist", async () => {
		const res = await get(`/admin/urls/${MAIN_DOMAIN}/missing`);
		expect(res.status).toBe(303);
		expect(res.headers.get("Location")).toBe("/admin/urls");
	});

	it("deletes and restores a URL", async () => {
		await seedUrl(env.DB, { slug: "bye" });
		const del = await post(`/admin/urls/${MAIN_DOMAIN}/bye/delete`);
		expect(await follow(del)).toContain("s.example.com/bye を削除しました。");
		const deleted = await env.DB.prepare("SELECT deleted_at FROM urls WHERE slug = 'bye'").first<{
			deleted_at: string | null;
		}>();
		expect(deleted?.deleted_at).not.toBeNull();

		const restore = await post(`/admin/urls/${MAIN_DOMAIN}/bye/restore?status=deleted`);
		expect(restore.headers.get("Location")).toBe("/admin/urls?status=deleted");
		expect(await follow(restore)).toContain("s.example.com/bye を復元しました。");
		const restored = await env.DB.prepare("SELECT deleted_at FROM urls WHERE slug = 'bye'").first<{
			deleted_at: string | null;
		}>();
		expect(restored?.deleted_at).toBeNull();
	});
});

describe("domains", () => {
	it("lists domains", async () => {
		const body = await (await get("/admin/domains")).text();
		expect(body).toContain("ドメインを追加");
		expect(body).toContain(MAIN_DOMAIN);
		expect(body).toContain(OTHER_DOMAIN);
		expect(body).toContain(`href="/admin/domains/${OTHER_DOMAIN}"`);
	});

	it("adds a domain", async () => {
		const res = await post("/admin/domains", { domain: "go.example.com", name: "Go" });
		expect(await follow(res)).toContain("go.example.com を追加しました。");
		const row = await env.DB.prepare(
			"SELECT name, external FROM domains WHERE domain = 'go.example.com'",
		).first();
		expect(row).toEqual({ name: "Go", external: 0 });
	});

	it("shows the API error when an external domain cannot be registered", async () => {
		const res = await post("/admin/domains", {
			domain: "ext.example.net",
			name: "Ext",
			external: "on",
		});
		expect(res.status).toBe(400);
		const body = await res.text();
		expect(body).toContain("追加できませんでした: Cloudflare for SaaS is not configured");
		expect(body).toContain('value="ext.example.net"');
	});

	it("shows the edit page with a 410 preview", async () => {
		await env.DB.prepare(
			"UPDATE domains SET gone_title = 'リンク切れ', gone_color = '#123456' WHERE domain = ?",
		)
			.bind(OTHER_DOMAIN)
			.run();
		const res = await get(`/admin/domains/${OTHER_DOMAIN}`);
		expect(res.status).toBe(200);
		const body = await res.text();
		expect(body).toContain(`ドメインを編集: ${OTHER_DOMAIN}`);
		expect(body).toContain('style="color:#123456"');
		expect(body).toContain(">リンク切れ</h1>");
	});

	it("updates a domain", async () => {
		const res = await post(`/admin/domains/${OTHER_DOMAIN}`, {
			name: "Renamed",
			gone_title: "なくなりました",
			gone_message: "このリンクは無効です",
			gone_color: "#00AA00",
			gone_logo_url: "",
		});
		expect(await follow(res)).toContain(`${OTHER_DOMAIN} を更新しました。`);
		const row = await env.DB.prepare("SELECT * FROM domains WHERE domain = ?")
			.bind(OTHER_DOMAIN)
			.first();
		expect(row).toMatchObject({
			name: "Renamed",
			gone_title: "なくなりました",
			gone_message: "このリンクは無効です",
			gone_color: "#00AA00",
			gone_logo_url: null,
			external: 0,
		});
	});

	it("re-renders the edit page on validation errors", async () => {
		const res = await post(`/admin/domains/${OTHER_DOMAIN}`, {
			name: "Other",
			gone_color: "red",
			gone_logo_url: "http://insecure.example/logo.png",
		});
		expect(res.status).toBe(400);
		const body = await res.text();
		expect(body).toContain("保存できませんでした:");
		// 不正な色はプレビューの style に入れない
		expect(body).not.toContain('style="color:red"');
	});

	it("refuses to delete a domain that still has URLs", async () => {
		await seedUrl(env.DB, { domain: OTHER_DOMAIN, slug: "keep" });
		const res = await post(`/admin/domains/${OTHER_DOMAIN}/delete`);
		expect(await follow(res)).toContain(
			"削除できませんでした: Cannot delete domain with existing URLs",
		);
		const row = await env.DB.prepare("SELECT 1 FROM domains WHERE domain = ?")
			.bind(OTHER_DOMAIN)
			.first();
		expect(row).not.toBeNull();
	});

	it("deletes a domain", async () => {
		const res = await post(`/admin/domains/${OTHER_DOMAIN}/delete`);
		expect(await follow(res)).toContain(`${OTHER_DOMAIN} を削除しました。`);
		const row = await env.DB.prepare("SELECT 1 FROM domains WHERE domain = ?")
			.bind(OTHER_DOMAIN)
			.first();
		expect(row).toBeNull();
	});

	it("shows DNS instructions in Japanese for external domains", async () => {
		await seedDomain(env.DB, {
			domain: "brand.org",
			name: "Brand",
			external: 1,
			custom_hostname_id: "ch_1",
			hostname_status: "pending",
			ssl_status: "pending_validation",
			ownership_verification: JSON.stringify({
				type: "TXT",
				name: "_cf-custom-hostname.brand.org",
				value: "token-1",
			}),
		});
		const body = await (await get("/admin/domains")).text();
		expect(body).toContain("相手側のアカウントで作成してもらう DNS レコード:");
		expect(body).toContain("_cf-custom-hostname.brand.org");
		expect(body).toContain("CF_SAAS_CNAME_TARGET が設定されていません。");
		expect(body).toContain("Apex ドメインには通常の CNAME を設定できません。");
		expect(body).toContain('action="/admin/domains/brand.org/refresh"');
	});

	it("reports refresh failures", async () => {
		const res = await post(`/admin/domains/${OTHER_DOMAIN}/refresh`);
		expect(await follow(res)).toContain(
			"状態を更新できませんでした: Domain is not registered as a Cloudflare for SaaS custom hostname",
		);
	});
});

describe("folders", () => {
	it("is linked from the navigation", async () => {
		const body = await (await get("/admin/urls")).text();
		expect(body).toContain('<a href="/admin/folders">フォルダ</a>');
	});

	it("lists folders as an indented tree with URL counts", async () => {
		const parent = await seedFolder(env.DB, "親");
		const child = await seedFolder(env.DB, "子", parent.id);
		await seedUrl(env.DB, { slug: "in-child", folder_id: child.id });

		const body = await (await get("/admin/folders")).text();
		expect(body).toContain("フォルダを作成");
		expect(body.indexOf(">親<")).toBeLessThan(body.indexOf(">子<"));
		expect(body).toContain('style="width:20px"');
		expect(body).toContain(`href="/admin/urls?folder_id=${child.id}"`);
		expect(body).toContain("フォルダ「親」とサブフォルダ 1 個を削除しますか？");
	});

	it("renders pages even if parent_id already forms a cycle", async () => {
		const a = await seedFolder(env.DB, "A");
		const b = await seedFolder(env.DB, "B", a.id);
		await env.DB.prepare("UPDATE folders SET parent_id = ? WHERE id = ?").bind(b.id, a.id).run();
		await seedUrl(env.DB, { slug: "in-b", folder_id: b.id });

		const list = await get("/admin/urls");
		expect(list.status).toBe(200);
		expect(await list.text()).toContain("A / B");
		expect((await get(`/admin/folders/${a.id}`)).status).toBe(200);
	});

	it("creates a folder under a parent", async () => {
		const parent = await seedFolder(env.DB, "Campaigns");
		const res = await post("/admin/folders", { name: " 2026 ", parent_id: String(parent.id) });
		expect(await follow(res)).toContain("フォルダ「2026」を作成しました。");
		const row = await env.DB.prepare("SELECT parent_id FROM folders WHERE name = '2026'").first<{
			parent_id: number;
		}>();
		expect(row?.parent_id).toBe(parent.id);
	});

	it("shows API conflicts when creating a duplicate folder", async () => {
		await seedFolder(env.DB, "Dup");
		const res = await post("/admin/folders", { name: "Dup", parent_id: "" });
		expect(res.status).toBe(409);
		const body = await res.text();
		expect(body).toContain("作成できませんでした: A folder with the same name already exists here");
		expect(body).toContain('value="Dup"');
	});

	it("excludes the folder and its descendants from parent candidates", async () => {
		const a = await seedFolder(env.DB, "A");
		const b = await seedFolder(env.DB, "B", a.id);
		const other = await seedFolder(env.DB, "Other");

		const body = await (await get(`/admin/folders/${a.id}`)).text();
		expect(body).toContain("フォルダを編集: A");
		expect(body).not.toContain(`<option value="${a.id}"`);
		expect(body).not.toContain(`<option value="${b.id}"`);
		expect(body).toContain(`<option value="${other.id}"`);
	});

	it("renames and moves a folder", async () => {
		const a = await seedFolder(env.DB, "A");
		const target = await seedFolder(env.DB, "Target");
		const res = await post(`/admin/folders/${a.id}`, {
			name: "Renamed",
			parent_id: String(target.id),
		});
		expect(await follow(res)).toContain("フォルダ「Renamed」を更新しました。");
		const row = await env.DB.prepare("SELECT * FROM folders WHERE id = ?").bind(a.id).first();
		expect(row).toMatchObject({ name: "Renamed", parent_id: target.id });
	});

	it("re-renders the edit page when moving into a descendant", async () => {
		const a = await seedFolder(env.DB, "A");
		const b = await seedFolder(env.DB, "B", a.id);
		const res = await post(`/admin/folders/${a.id}`, { name: "A", parent_id: String(b.id) });
		expect(res.status).toBe(400);
		expect(await res.text()).toContain(
			"保存できませんでした: Cannot move a folder into itself or its subfolders",
		);
	});

	it("redirects to the list for an unknown folder", async () => {
		const res = await get("/admin/folders/999");
		expect(res.status).toBe(303);
		expect(res.headers.get("Location")).toBe("/admin/folders");
	});

	it("deletes a folder and keeps its URLs as unfiled", async () => {
		const folder = await seedFolder(env.DB, "Gone");
		await seedUrl(env.DB, { slug: "kept", folder_id: folder.id });
		const res = await post(`/admin/folders/${folder.id}/delete`);
		expect(await follow(res)).toContain("フォルダを削除しました。中の URL は未分類に戻りました。");
		const url = await env.DB.prepare("SELECT folder_id FROM urls WHERE slug = 'kept'").first<{
			folder_id: number | null;
		}>();
		expect(url?.folder_id).toBeNull();
	});

	it("filters URLs by folder and shows the folder path", async () => {
		const parent = await seedFolder(env.DB, "P");
		const child = await seedFolder(env.DB, "C", parent.id);
		await seedUrl(env.DB, { slug: "filed", folder_id: child.id });
		await seedUrl(env.DB, { slug: "loose" });

		const inFolder = await (await get(`/admin/urls?folder_id=${child.id}`)).text();
		expect(inFolder).toContain("s.example.com/filed");
		expect(inFolder).not.toContain("s.example.com/loose");
		expect(inFolder).toContain('<span class="folder-path">P / C</span>');
		// フォルダで絞り込んでいるときは作成フォームの既定もそのフォルダ
		expect(inFolder).toMatch(
			new RegExp(
				`<select id="folder_id" name="folder_id">.*<option value="${child.id}" selected=""`,
				"s",
			),
		);

		const unfiled = await (await get("/admin/urls?folder_id=none")).text();
		expect(unfiled).toContain("s.example.com/loose");
		expect(unfiled).not.toContain("s.example.com/filed");

		// 不正な値は無視して絞り込まない
		const invalid = await (await get("/admin/urls?folder_id=abc")).text();
		expect(invalid).toContain("s.example.com/loose");
		expect(invalid).toContain("s.example.com/filed");
	});

	it("creates and moves URLs between folders", async () => {
		const folder = await seedFolder(env.DB, "F");
		const created = await post(`/admin/urls?folder_id=${folder.id}`, {
			url: "https://example.com/f",
			slug: "in-f",
			folder_id: String(folder.id),
		});
		expect(created.headers.get("Location")).toBe(`/admin/urls?folder_id=${folder.id}`);
		const row = await env.DB.prepare("SELECT folder_id FROM urls WHERE slug = 'in-f'").first<{
			folder_id: number | null;
		}>();
		expect(row?.folder_id).toBe(folder.id);

		const edit = await (await get(`/admin/urls/${MAIN_DOMAIN}/in-f`)).text();
		expect(edit).toContain(`<option value="${folder.id}" selected="">`);

		const moved = await post(`/admin/urls/${MAIN_DOMAIN}/in-f`, {
			target_url: "https://example.com/f",
			folder_id: "",
		});
		expect(moved.status).toBe(303);
		const after = await env.DB.prepare("SELECT folder_id FROM urls WHERE slug = 'in-f'").first<{
			folder_id: number | null;
		}>();
		expect(after?.folder_id).toBeNull();
	});

	it("shows the API error for an unknown folder", async () => {
		const res = await post("/admin/urls", { url: "https://example.com", folder_id: "999" });
		expect(res.status).toBe(400);
		expect(await res.text()).toContain("作成できませんでした: Unknown folder: 999");
	});
});
