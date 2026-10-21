import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bindings, FolderRow, UrlRow } from "../../src/types";

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

beforeAll(async () => {
	await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

const DOMAIN = "s.example.com";
const OTHER_DOMAIN = "go.example.com";

function getEnv() {
	return {
		DB: env.DB,
		TEAM_DOMAIN: "test-team.cloudflareaccess.com",
		POLICY_AUD: "test-aud-tag",
		MAIN_DOMAIN: DOMAIN,
	};
}

async function api(path: string, method = "GET", body?: unknown): Promise<Response> {
	const init: RequestInit = {
		method,
		headers: {
			Host: DOMAIN,
			"Cf-Access-Jwt-Assertion": "mock-token",
			"Content-Type": "application/json",
		},
	};
	if (body !== undefined) {
		init.body = JSON.stringify(body);
	}
	return app.fetch(new Request(`http://${DOMAIN}/api${path}`, init), getEnv());
}

async function folderIdOf(domain: string, slug: string): Promise<number | null> {
	const row = await env.DB.prepare("SELECT folder_id FROM urls WHERE domain = ? AND slug = ?")
		.bind(domain, slug)
		.first<{ folder_id: number | null }>();
	return row?.folder_id ?? null;
}

describe("Folders", () => {
	beforeEach(async () => {
		await cleanAll(env.DB);
		await seedDomain(env.DB, { domain: DOMAIN });
		await seedDomain(env.DB, { domain: OTHER_DOMAIN, name: "Other" });
	});

	describe("POST /api/folders", () => {
		it("creates a top-level folder and a nested folder", async () => {
			const res = await api("/folders", "POST", { name: "  Work  " });
			expect(res.status).toBe(201);
			const work = await res.json<FolderRow & { url_count: number }>();
			expect(work).toMatchObject({ name: "Work", parent_id: null, url_count: 0 });

			const res2 = await api("/folders", "POST", { name: "Project A", parent_id: work.id });
			expect(res2.status).toBe(201);
			expect(await res2.json()).toMatchObject({ name: "Project A", parent_id: work.id });
		});

		it("rejects an empty or too long name", async () => {
			expect((await api("/folders", "POST", { name: "   " })).status).toBe(400);
			expect((await api("/folders", "POST", { name: "a".repeat(101) })).status).toBe(400);
			expect((await api("/folders", "POST", {})).status).toBe(400);
		});

		it("rejects an unknown or malformed parent_id", async () => {
			expect((await api("/folders", "POST", { name: "x", parent_id: 9999 })).status).toBe(400);
			expect((await api("/folders", "POST", { name: "x", parent_id: "1" })).status).toBe(400);
		});

		it("returns 409 for a duplicate name under the same parent only", async () => {
			const work = await seedFolder(env.DB, "Work");
			await seedFolder(env.DB, "Docs", work.id);

			expect((await api("/folders", "POST", { name: "Work" })).status).toBe(409);
			expect((await api("/folders", "POST", { name: "Docs", parent_id: work.id })).status).toBe(
				409,
			);
			// 親が違えば同名でもよい
			expect((await api("/folders", "POST", { name: "Docs" })).status).toBe(201);
		});
	});

	describe("GET /api/folders", () => {
		it("lists folders with the number of non-deleted URLs directly inside", async () => {
			const work = await seedFolder(env.DB, "Work");
			const sub = await seedFolder(env.DB, "Sub", work.id);
			await seedUrl(env.DB, { slug: "a", folder_id: work.id });
			await seedUrl(env.DB, { domain: OTHER_DOMAIN, slug: "b", folder_id: work.id });
			await seedUrl(env.DB, { slug: "c", folder_id: sub.id });
			await seedUrl(env.DB, { slug: "d", folder_id: work.id });
			await env.DB.prepare("UPDATE urls SET deleted_at = datetime('now') WHERE slug = 'd'").run();

			const res = await api("/folders");
			expect(res.status).toBe(200);
			const { data } = await res.json<{ data: (FolderRow & { url_count: number })[] }>();
			expect(data.map((f) => [f.name, f.parent_id, f.url_count])).toEqual([
				["Sub", work.id, 1],
				["Work", null, 2],
			]);
		});

		it("returns 404 for an unknown folder", async () => {
			expect((await api("/folders/9999")).status).toBe(404);
			expect((await api("/folders/abc")).status).toBe(404);
		});
	});

	describe("PATCH /api/folders/:id", () => {
		it("renames and moves a folder", async () => {
			const a = await seedFolder(env.DB, "A");
			const b = await seedFolder(env.DB, "B");

			const res = await api(`/folders/${b.id}`, "PATCH", { name: "B2", parent_id: a.id });
			expect(res.status).toBe(200);
			expect(await res.json()).toMatchObject({ id: b.id, name: "B2", parent_id: a.id });

			const res2 = await api(`/folders/${b.id}`, "PATCH", { parent_id: null });
			expect(await res2.json()).toMatchObject({ name: "B2", parent_id: null });
		});

		it("rejects moving a folder into itself or its descendants", async () => {
			const a = await seedFolder(env.DB, "A");
			const b = await seedFolder(env.DB, "B", a.id);
			const c = await seedFolder(env.DB, "C", b.id);

			expect((await api(`/folders/${a.id}`, "PATCH", { parent_id: a.id })).status).toBe(400);
			expect((await api(`/folders/${a.id}`, "PATCH", { parent_id: c.id })).status).toBe(400);
			// 子孫でない方向の移動はできる
			expect((await api(`/folders/${c.id}`, "PATCH", { parent_id: a.id })).status).toBe(200);
		});

		it("does not create a cycle when two folders are moved into each other at the same time", async () => {
			const a = await seedFolder(env.DB, "A");
			const b = await seedFolder(env.DB, "B");

			const statuses = (
				await Promise.all([
					api(`/folders/${a.id}`, "PATCH", { parent_id: b.id }),
					api(`/folders/${b.id}`, "PATCH", { parent_id: a.id }),
				])
			).map((res) => res.status);
			expect(statuses.sort()).toEqual([200, 400]);

			const rows = await env.DB.prepare("SELECT * FROM folders").all<FolderRow>();
			expect(rows.results.filter((f) => f.parent_id !== null)).toHaveLength(1);
		});

		it("returns 409 when the destination already has a folder with the same name", async () => {
			const a = await seedFolder(env.DB, "A");
			await seedFolder(env.DB, "X", a.id);
			const x = await seedFolder(env.DB, "X");

			expect((await api(`/folders/${x.id}`, "PATCH", { parent_id: a.id })).status).toBe(409);
			// 自分自身の名前のままの更新は重複扱いしない
			expect((await api(`/folders/${x.id}`, "PATCH", { name: "X" })).status).toBe(200);
		});

		it("returns 400 without fields and 404 for an unknown folder", async () => {
			const a = await seedFolder(env.DB, "A");
			expect((await api(`/folders/${a.id}`, "PATCH", {})).status).toBe(400);
			expect((await api("/folders/9999", "PATCH", { name: "Z" })).status).toBe(404);
		});
	});

	describe("DELETE /api/folders/:id", () => {
		it("deletes the folder with its subfolders and unfiles the URLs inside", async () => {
			const a = await seedFolder(env.DB, "A");
			const b = await seedFolder(env.DB, "B", a.id);
			const c = await seedFolder(env.DB, "C", b.id);
			const other = await seedFolder(env.DB, "Other");
			await seedUrl(env.DB, { slug: "in-a", folder_id: a.id });
			await seedUrl(env.DB, { slug: "in-c", folder_id: c.id });
			await seedUrl(env.DB, { slug: "in-other", folder_id: other.id });

			const res = await api(`/folders/${a.id}`, "DELETE");
			expect(res.status).toBe(204);

			const remaining = await env.DB.prepare("SELECT id FROM folders").all<{ id: number }>();
			expect(remaining.results.map((r) => r.id)).toEqual([other.id]);
			expect(await folderIdOf(DOMAIN, "in-a")).toBeNull();
			expect(await folderIdOf(DOMAIN, "in-c")).toBeNull();
			expect(await folderIdOf(DOMAIN, "in-other")).toBe(other.id);

			const url = await env.DB.prepare("SELECT * FROM urls WHERE slug = 'in-c'").first<UrlRow>();
			expect(url?.deleted_at).toBeNull();
		});

		it("returns 404 for an unknown folder", async () => {
			expect((await api("/folders/9999", "DELETE")).status).toBe(404);
		});

		it("terminates even if parent_id already forms a cycle", async () => {
			const a = await seedFolder(env.DB, "A");
			const b = await seedFolder(env.DB, "B", a.id);
			await env.DB.prepare("UPDATE folders SET parent_id = ? WHERE id = ?").bind(b.id, a.id).run();
			await seedUrl(env.DB, { slug: "in-b", folder_id: b.id });

			expect((await api(`/folders/${a.id}`, "DELETE")).status).toBe(204);

			const remaining = await env.DB.prepare("SELECT id FROM folders").all<{ id: number }>();
			expect(remaining.results).toEqual([]);
			expect(await folderIdOf(DOMAIN, "in-b")).toBeNull();
		});
	});

	describe("URLs in folders", () => {
		it("creates a URL in a folder and moves it between folders", async () => {
			const a = await seedFolder(env.DB, "A");
			const b = await seedFolder(env.DB, "B");

			const res = await api("/shorten", "POST", {
				url: "https://example.com/x",
				slug: "x",
				folder_id: a.id,
			});
			expect(res.status).toBe(201);
			expect(await res.json()).toMatchObject({ slug: "x", folder_id: a.id });

			const res2 = await api("/urls/x", "PATCH", { folder_id: b.id });
			expect(res2.status).toBe(200);
			expect(await res2.json()).toMatchObject({ folder_id: b.id });

			const res3 = await api("/urls/x", "PATCH", { folder_id: null });
			expect(await res3.json()).toMatchObject({ folder_id: null });
		});

		it("rejects an unknown or malformed folder_id", async () => {
			await seedUrl(env.DB, { slug: "x" });
			const shorten = (folder_id: unknown) =>
				api("/shorten", "POST", { url: "https://example.com", folder_id });

			expect((await shorten(9999)).status).toBe(400);
			expect((await shorten("1")).status).toBe(400);
			expect((await shorten(1.5)).status).toBe(400);
			expect((await api("/urls/x", "PATCH", { folder_id: 9999 })).status).toBe(400);
			expect(await folderIdOf(DOMAIN, "x")).toBeNull();
		});

		it("filters GET /api/urls by folder_id across domains", async () => {
			const a = await seedFolder(env.DB, "A");
			const sub = await seedFolder(env.DB, "Sub", a.id);
			await seedUrl(env.DB, { slug: "a1", folder_id: a.id });
			await seedUrl(env.DB, { domain: OTHER_DOMAIN, slug: "a2", folder_id: a.id });
			await seedUrl(env.DB, { slug: "s1", folder_id: sub.id });
			await seedUrl(env.DB, { slug: "none1" });

			const slugs = async (query: string) => {
				const res = await api(`/urls?domain=all&${query}`);
				expect(res.status).toBe(200);
				const { data } = await res.json<{ data: UrlRow[] }>();
				return data.map((u) => u.slug).sort();
			};

			// サブフォルダの URL は含めない（直下のみ）
			expect(await slugs(`folder_id=${a.id}`)).toEqual(["a1", "a2"]);
			expect(await slugs("folder_id=none")).toEqual(["none1"]);
			expect(await slugs("")).toEqual(["a1", "a2", "none1", "s1"]);
			expect((await api("/urls?folder_id=abc")).status).toBe(400);
		});
	});
});
