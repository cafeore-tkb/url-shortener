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
import { cleanAll, seedDomain, seedUrl } from "../fixtures/seed";

declare module "cloudflare:test" {
	interface ProvidedEnv extends Bindings {
		TEST_MIGRATIONS: D1Migration[];
	}
}

beforeAll(async () => {
	await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

const DOMAIN = "s.example.com";
const TEAM_DOMAIN = "test-team.cloudflareaccess.com";
const POLICY_AUD = "test-aud-tag";
const MAIN_DOMAIN = DOMAIN;

function getEnv() {
	return { DB: env.DB, TEAM_DOMAIN, POLICY_AUD, MAIN_DOMAIN };
}

function mockExecCtx(): ExecutionContext {
	const promises: Promise<unknown>[] = [];
	return {
		waitUntil: (p: Promise<unknown>) => promises.push(p),
		passThroughOnException: () => {},
		promises,
	} as unknown as ExecutionContext & { promises: Promise<unknown>[] };
}

function apiReq(path: string, method = "GET", body?: unknown): Request {
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
	return new Request(`http://${DOMAIN}${path}`, init);
}

function publicReq(slug: string): Request {
	return new Request(`http://${DOMAIN}/${slug}`, {
		headers: { Host: DOMAIN },
	});
}

describe("Full-flow integration tests", () => {
	beforeEach(async () => {
		await cleanAll(env.DB);
		await seedDomain(env.DB, { domain: DOMAIN });
	});

	it("creates a domain via POST /api/domains", async () => {
		const res = await app.request(
			apiReq("/api/domains", "POST", {
				domain: "new.example.com",
				name: "New Domain",
			}),
			undefined,
			getEnv(),
		);
		expect(res.status).toBe(201);
		const body = await res.json<{ domain: string; name: string }>();
		expect(body.domain).toBe("new.example.com");
		expect(body.name).toBe("New Domain");
	});

	it("creates a URL with auto-generated slug", async () => {
		const res = await app.request(
			apiReq("/api/shorten", "POST", {
				url: "https://example.com/auto",
			}),
			undefined,
			getEnv(),
		);
		expect(res.status).toBe(201);
		const body = await res.json<{ slug: string; target_url: string }>();
		expect(body.slug).toHaveLength(6);
		expect(body.target_url).toBe("https://example.com/auto");
	});

	it("rejects a cross-site form post to the API even with a valid Access JWT", async () => {
		// 罠ページの <form enctype="text/plain"> からの送信。Access は Cookie から JWT を付けて渡してくる
		const res = await app.request(
			new Request(`http://${DOMAIN}/api/shorten`, {
				method: "POST",
				headers: {
					Host: DOMAIN,
					"Cf-Access-Jwt-Assertion": "mock-token",
					"Content-Type": "text/plain",
					Origin: "https://evil.example",
					"Sec-Fetch-Site": "cross-site",
				},
				body: '{"url":"https://phish.example/","slug":"login","x":"="}',
			}),
			undefined,
			getEnv(),
		);
		expect(res.status).toBe(403);
		const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM urls").first<{ n: number }>();
		expect(count?.n).toBe(0);
	});

	it("creates a URL with custom slug", async () => {
		const res = await app.request(
			apiReq("/api/shorten", "POST", {
				url: "https://example.com/custom",
				slug: "my-custom",
			}),
			undefined,
			getEnv(),
		);
		expect(res.status).toBe(201);
		const body = await res.json<{ slug: string }>();
		expect(body.slug).toBe("my-custom");
	});

	it("redirects 302 and increments clicks", async () => {
		await seedUrl(env.DB, {
			domain: DOMAIN,
			slug: "redir",
			target_url: "https://example.com/target",
		});

		const ctx = mockExecCtx();
		const res = await app.request(publicReq("redir"), undefined, getEnv(), ctx);
		expect(res.status).toBe(302);
		expect(res.headers.get("Location")).toBe("https://example.com/target");

		// Wait for click increment
		await Promise.all((ctx as unknown as { promises: Promise<unknown>[] }).promises);

		// Verify clicks
		const statsRes = await app.request(apiReq("/api/urls/redir/stats"), undefined, getEnv());
		expect(statsRes.status).toBe(200);
		const stats = await statsRes.json<{ clicks: number }>();
		expect(stats.clicks).toBeGreaterThanOrEqual(1);
	});

	it("updates a URL via PATCH", async () => {
		await seedUrl(env.DB, { domain: DOMAIN, slug: "upd" });

		const res = await app.request(
			apiReq("/api/urls/upd", "PATCH", {
				target_url: "https://example.com/updated",
				note: "updated note",
			}),
			undefined,
			getEnv(),
		);
		expect(res.status).toBe(200);
		const body = await res.json<{ target_url: string; note: string }>();
		expect(body.target_url).toBe("https://example.com/updated");
		expect(body.note).toBe("updated note");
	});

	it("returns 410 for expired URL with gone branding", async () => {
		await seedUrl(env.DB, {
			domain: DOMAIN,
			slug: "old",
			target_url: "https://example.com/old",
			expires_at: "2020-01-01 00:00:00",
		});

		const ctx = mockExecCtx();
		const res = await app.request(publicReq("old"), undefined, getEnv(), ctx);
		expect(res.status).toBe(410);
		expect(res.headers.get("Content-Type")).toContain("text/html");
		const html = await res.text();
		expect(html).toContain("Link Expired");
	});

	it("soft-deletes a URL, returns 404 on redirect, and 409 on re-create", async () => {
		await seedUrl(env.DB, {
			domain: DOMAIN,
			slug: "del-me",
			target_url: "https://example.com/del",
		});

		// Soft delete
		const delRes = await app.request(apiReq("/api/urls/del-me", "DELETE"), undefined, getEnv());
		expect(delRes.status).toBe(204);

		// Redirect returns 404 after soft delete
		const ctx = mockExecCtx();
		const redirRes = await app.request(publicReq("del-me"), undefined, getEnv(), ctx);
		expect(redirRes.status).toBe(404);

		// Re-create same slug returns 409 (record still exists)
		const recreateRes = await app.request(
			apiReq("/api/shorten", "POST", {
				url: "https://example.com/new",
				slug: "del-me",
			}),
			undefined,
			getEnv(),
		);
		expect(recreateRes.status).toBe(409);
	});

	it("lists URLs with status filter, search, and pagination", async () => {
		await seedUrl(env.DB, { domain: DOMAIN, slug: "url-a", target_url: "https://a.com" });
		await seedUrl(env.DB, {
			domain: DOMAIN,
			slug: "url-b",
			target_url: "https://b.com",
			note: "special",
		});
		await seedUrl(env.DB, {
			domain: DOMAIN,
			slug: "url-exp",
			target_url: "https://expired.com",
			expires_at: "2020-01-01 00:00:00",
		});

		// Active URLs (default status)
		const activeRes = await app.request(apiReq("/api/urls?status=active"), undefined, getEnv());
		expect(activeRes.status).toBe(200);
		const active = await activeRes.json<{ data: unknown[]; pagination: { total: number } }>();
		expect(active.data.length).toBe(2);

		// Expired URLs
		const expiredRes = await app.request(apiReq("/api/urls?status=expired"), undefined, getEnv());
		const expired = await expiredRes.json<{ data: unknown[] }>();
		expect(expired.data.length).toBe(1);

		// Search by note
		const searchRes = await app.request(
			apiReq("/api/urls?status=all&q=special"),
			undefined,
			getEnv(),
		);
		const search = await searchRes.json<{ data: unknown[] }>();
		expect(search.data.length).toBe(1);

		// Pagination
		const pageRes = await app.request(
			apiReq("/api/urls?status=all&per_page=1&page=1"),
			undefined,
			getEnv(),
		);
		const page = await pageRes.json<{
			data: unknown[];
			pagination: { total: number; total_pages: number };
		}>();
		expect(page.data.length).toBe(1);
		expect(page.pagination.total).toBe(3);
		expect(page.pagination.total_pages).toBe(3);
	});
});
