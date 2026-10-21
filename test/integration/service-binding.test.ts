import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import app from "../../src/index";
import type { ShortenerService } from "../../src/service-binding";
import type { Bindings } from "../../src/types";
import { cleanAll, seedDomain, seedUrl } from "../fixtures/seed";

declare module "cloudflare:test" {
	interface ProvidedEnv extends Bindings {
		TEST_MIGRATIONS: D1Migration[];
		/** vitest.config.ts で自分自身の ShortenerService エントリポイントに向けた Service Binding */
		SHORTENER: Service<ShortenerService>;
	}
}

beforeAll(async () => {
	await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

const MAIN_DOMAIN = env.MAIN_DOMAIN;
const OTHER_DOMAIN = "go.example.com";

describe("ShortenerService (Service Binding)", () => {
	beforeEach(async () => {
		await cleanAll(env.DB);
		await seedDomain(env.DB, { domain: MAIN_DOMAIN, name: "Main" });
		await seedDomain(env.DB, { domain: OTHER_DOMAIN, name: "Other" });
	});

	describe("RPC", () => {
		it("shortens a URL on MAIN_DOMAIN by default without an Access JWT", async () => {
			const result = await env.SHORTENER.shorten({ url: "https://example.com/a", slug: "rpc-a" });

			expect(result).toMatchObject({
				ok: true,
				status: 201,
				data: {
					domain: MAIN_DOMAIN,
					slug: "rpc-a",
					short_url: `https://${MAIN_DOMAIN}/rpc-a`,
					target_url: "https://example.com/a",
					expires_at: null,
				},
			});

			const row = await env.DB.prepare("SELECT * FROM urls WHERE domain = ? AND slug = ?")
				.bind(MAIN_DOMAIN, "rpc-a")
				.first();
			expect(row).not.toBeNull();
		});

		it("shortens a URL on an explicit domain", async () => {
			const result = await env.SHORTENER.shorten({
				url: "https://example.com/b",
				slug: "rpc-b",
				domain: OTHER_DOMAIN,
			});

			expect(result.ok).toBe(true);
			expect(result.ok && result.data.short_url).toBe(`https://${OTHER_DOMAIN}/rpc-b`);
		});

		it("returns the same validation errors as the REST API", async () => {
			expect(await env.SHORTENER.shorten({ url: "" })).toEqual({
				ok: false,
				status: 400,
				error: "Missing required field: url",
			});

			await seedUrl(env.DB, { domain: MAIN_DOMAIN, slug: "taken" });
			expect(await env.SHORTENER.shorten({ url: "https://example.com", slug: "taken" })).toEqual({
				ok: false,
				status: 409,
				error: "Slug already exists",
			});

			expect(
				await env.SHORTENER.shorten({ url: "https://example.com", domain: "unknown.example" }),
			).toEqual({ ok: false, status: 400, error: "Unknown domain: unknown.example" });
		});

		it("lists URLs with the REST API's filters and pagination", async () => {
			await seedUrl(env.DB, { domain: MAIN_DOMAIN, slug: "m1" });
			await seedUrl(env.DB, { domain: MAIN_DOMAIN, slug: "m2" });
			await seedUrl(env.DB, { domain: OTHER_DOMAIN, slug: "o1" });

			const main = await env.SHORTENER.listUrls();
			expect(main.ok).toBe(true);
			if (!main.ok) return;
			expect(main.data.data.map((u) => u.slug).sort()).toEqual(["m1", "m2"]);
			expect(main.data.pagination).toEqual({ page: 1, per_page: 20, total: 2, total_pages: 1 });

			const other = await env.SHORTENER.listUrls({ domain: OTHER_DOMAIN });
			expect(other.ok && other.data.data.map((u) => u.slug)).toEqual(["o1"]);

			const all = await env.SHORTENER.listUrls({ domain: "all", per_page: 2, page: 2 });
			expect(all.ok && all.data.pagination).toEqual({
				page: 2,
				per_page: 2,
				total: 3,
				total_pages: 2,
			});

			const search = await env.SHORTENER.listUrls({ domain: "all", q: "o1" });
			expect(search.ok && search.data.data.map((u) => u.slug)).toEqual(["o1"]);
		});

		it("gets stats, updates, deletes and restores a URL", async () => {
			await seedUrl(env.DB, { domain: OTHER_DOMAIN, slug: "life" });
			const options = { domain: OTHER_DOMAIN };

			const stats = await env.SHORTENER.getUrlStats("life", options);
			expect(stats).toMatchObject({ ok: true, status: 200, data: { slug: "life", clicks: 0 } });

			const updated = await env.SHORTENER.updateUrl(
				"life",
				{ target_url: "https://example.com/updated", note: "memo" },
				options,
			);
			expect(updated).toMatchObject({
				ok: true,
				status: 200,
				data: { domain: OTHER_DOMAIN, target_url: "https://example.com/updated", note: "memo" },
			});

			expect(await env.SHORTENER.deleteUrl("life", options)).toEqual({
				ok: true,
				status: 204,
				data: null,
			});
			const deleted = await env.SHORTENER.listUrls({ ...options, status: "deleted" });
			expect(deleted.ok && deleted.data.data.map((u) => u.slug)).toEqual(["life"]);

			expect(await env.SHORTENER.restoreUrl("life", options)).toEqual({
				ok: true,
				status: 204,
				data: null,
			});
			const active = await env.SHORTENER.listUrls(options);
			expect(active.ok && active.data.data.map((u) => u.slug)).toEqual(["life"]);
		});

		it("returns 404 for a URL on a different domain", async () => {
			await seedUrl(env.DB, { domain: OTHER_DOMAIN, slug: "elsewhere" });

			expect(await env.SHORTENER.getUrlStats("elsewhere")).toEqual({
				ok: false,
				status: 404,
				error: "URL not found",
			});
			expect(await env.SHORTENER.updateUrl("elsewhere", { note: "x" })).toEqual({
				ok: false,
				status: 404,
				error: "URL not found",
			});
		});

		it("manages domains", async () => {
			const created = await env.SHORTENER.createDomain({ domain: "new.example.com", name: "New" });
			expect(created).toMatchObject({
				ok: true,
				status: 201,
				data: { domain: "new.example.com", name: "New", external: false, dns_instructions: null },
			});

			expect(await env.SHORTENER.createDomain({ domain: "new.example.com", name: "Dup" })).toEqual({
				ok: false,
				status: 409,
				error: "Domain already exists",
			});

			const updated = await env.SHORTENER.updateDomain("new.example.com", {
				name: "Renamed",
				gone_color: "#000000",
			});
			expect(updated).toMatchObject({
				ok: true,
				data: { name: "Renamed", gone_color: "#000000" },
			});

			const list = await env.SHORTENER.listDomains();
			expect(list.ok && list.data.data.map((d) => d.domain).sort()).toEqual(
				[MAIN_DOMAIN, OTHER_DOMAIN, "new.example.com"].sort(),
			);

			expect(await env.SHORTENER.deleteDomain("new.example.com")).toEqual({
				ok: true,
				status: 204,
				data: null,
			});
			expect(await env.SHORTENER.deleteDomain("new.example.com")).toEqual({
				ok: false,
				status: 404,
				error: "Domain not found",
			});
		});

		it("refuses to delete a domain that still has URLs", async () => {
			await seedUrl(env.DB, { domain: OTHER_DOMAIN, slug: "keep" });

			expect(await env.SHORTENER.deleteDomain(OTHER_DOMAIN)).toEqual({
				ok: false,
				status: 409,
				error: "Cannot delete domain with existing URLs",
			});
		});

		it("rejects hostname operations when Cloudflare for SaaS is not configured", async () => {
			const external = await env.SHORTENER.createDomain({
				domain: "partner.example.net",
				name: "Partner",
				external: true,
			});
			expect(external.ok).toBe(false);
			expect(external.status).toBe(400);

			expect(await env.SHORTENER.refreshDomainHostname(OTHER_DOMAIN)).toEqual({
				ok: false,
				status: 400,
				error: "Domain is not registered as a Cloudflare for SaaS custom hostname",
			});
		});

		it("manages folders and files URLs into them", async () => {
			const created = await env.SHORTENER.createFolder({ name: "Work" });
			expect(created).toMatchObject({ ok: true, status: 201, data: { name: "Work" } });
			if (!created.ok) return;
			const workId = created.data.id;

			const sub = await env.SHORTENER.createFolder({ name: "Sub", parent_id: workId });
			expect(sub.ok && sub.data.parent_id).toBe(workId);

			const renamed = await env.SHORTENER.updateFolder(workId, { name: "Office" });
			expect(renamed.ok && renamed.data.name).toBe("Office");

			const shortened = await env.SHORTENER.shorten({
				url: "https://example.com/f",
				slug: "rpc-f",
				folder_id: workId,
			});
			expect(shortened.ok && shortened.data.folder_id).toBe(workId);

			const inFolder = await env.SHORTENER.listUrls({ domain: "all", folder_id: workId });
			expect(inFolder.ok && inFolder.data.data.map((u) => u.slug)).toEqual(["rpc-f"]);

			const folder = await env.SHORTENER.getFolder(workId);
			expect(folder.ok && folder.data.url_count).toBe(1);

			expect(await env.SHORTENER.deleteFolder(workId)).toEqual({
				ok: true,
				status: 204,
				data: null,
			});
			const list = await env.SHORTENER.listFolders();
			expect(list.ok && list.data.data).toEqual([]);

			const unfiled = await env.SHORTENER.listUrls({ folder_id: "none" });
			expect(unfiled.ok && unfiled.data.data.map((u) => u.slug)).toEqual(["rpc-f"]);
		});
	});

	describe("fetch", () => {
		it("serves the REST API without an Access JWT", async () => {
			const created = await env.SHORTENER.fetch(`https://${OTHER_DOMAIN}/api/shorten`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ url: "https://example.com/fetch", slug: "via-fetch" }),
			});
			expect(created.status).toBe(201);
			expect(await created.json()).toMatchObject({
				domain: OTHER_DOMAIN,
				short_url: `https://${OTHER_DOMAIN}/via-fetch`,
			});

			const list = await env.SHORTENER.fetch(`https://${OTHER_DOMAIN}/api/urls`);
			expect(list.status).toBe(200);
			const body = await list.json<{ data: { slug: string }[] }>();
			expect(body.data.map((u) => u.slug)).toEqual(["via-fetch"]);

			const removed = await env.SHORTENER.fetch(`https://${OTHER_DOMAIN}/api/urls/via-fetch`, {
				method: "DELETE",
			});
			expect(removed.status).toBe(204);
		});

		it("uses an explicit Host header over the URL host", async () => {
			const res = await env.SHORTENER.fetch("https://internal.invalid/api/shorten", {
				method: "POST",
				headers: { Host: OTHER_DOMAIN, "Content-Type": "application/json" },
				body: JSON.stringify({ url: "https://example.com", slug: "by-host" }),
			});
			expect(res.status).toBe(201);
			expect(await res.json()).toMatchObject({ domain: OTHER_DOMAIN });
		});

		it("rejects unknown domains like the REST API", async () => {
			const res = await env.SHORTENER.fetch("https://unknown.example/api/urls");
			expect(res.status).toBe(400);
			expect(await res.json()).toEqual({ error: "Unknown domain: unknown.example", status: 400 });
		});

		it("does not expose the admin UI or redirects", async () => {
			await seedUrl(env.DB, { domain: MAIN_DOMAIN, slug: "abc123" });

			const admin = await env.SHORTENER.fetch(`https://${MAIN_DOMAIN}/admin`);
			expect(admin.status).toBe(404);

			const redirect = await env.SHORTENER.fetch(`https://${MAIN_DOMAIN}/abc123`, {
				redirect: "manual",
			});
			expect(redirect.status).toBe(404);
		});
	});

	it("keeps the public /api/* behind Cloudflare Access", async () => {
		const res = await app.request(
			`https://${MAIN_DOMAIN}/api/urls`,
			{ headers: { Host: MAIN_DOMAIN } },
			{ ...env, DEV_AUTH_BYPASS: undefined },
		);
		expect(res.status).toBe(401);
	});
});
