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

const DOMAIN_A = "a.test.com";
const DOMAIN_B = "b.test.com";
const MAIN_DOMAIN = DOMAIN_A;
const TEAM_DOMAIN = "test-team.cloudflareaccess.com";
const POLICY_AUD = "test-aud-tag";

function getEnv() {
	return { DB: env.DB, TEAM_DOMAIN, POLICY_AUD, MAIN_DOMAIN };
}

function mockExecCtx(): ExecutionContext & { promises: Promise<unknown>[] } {
	const promises: Promise<unknown>[] = [];
	return {
		waitUntil: (p: Promise<unknown>) => promises.push(p),
		passThroughOnException: () => {},
		promises,
	} as unknown as ExecutionContext & { promises: Promise<unknown>[] };
}

function apiReq(path: string, host: string, method = "GET", body?: unknown): Request {
	const init: RequestInit = {
		method,
		headers: {
			Host: host,
			"Cf-Access-Jwt-Assertion": "mock-token",
			"Content-Type": "application/json",
		},
	};
	if (body !== undefined) {
		init.body = JSON.stringify(body);
	}
	return new Request(`http://${host}${path}`, init);
}

function publicReq(slug: string, host: string): Request {
	return new Request(`http://${host}/${slug}`, {
		headers: { Host: host },
	});
}

describe("Multi-domain integration tests", () => {
	beforeEach(async () => {
		await cleanAll(env.DB);
	});

	it("creates and lists multiple domains", async () => {
		// Seed domain A directly so the Host header resolves
		await seedDomain(env.DB, { domain: DOMAIN_A, name: "Domain A" });

		// Create domain B via API
		const resB = await app.request(
			apiReq("/api/domains", DOMAIN_A, "POST", { domain: DOMAIN_B, name: "Domain B" }),
			undefined,
			getEnv(),
		);
		expect(resB.status).toBe(201);
		const bodyB = await resB.json<{ domain: string }>();
		expect(bodyB.domain).toBe(DOMAIN_B);

		// List returns both
		const listRes = await app.request(apiReq("/api/domains", DOMAIN_A), undefined, getEnv());
		expect(listRes.status).toBe(200);
		const list = await listRes.json<{ data: { domain: string }[] }>();
		const domains = list.data.map((d) => d.domain);
		expect(domains).toContain(DOMAIN_A);
		expect(domains).toContain(DOMAIN_B);
	});

	it("same slug on different domains redirects to different targets", async () => {
		await seedDomain(env.DB, { domain: DOMAIN_A, name: "A" });
		await seedDomain(env.DB, { domain: DOMAIN_B, name: "B" });
		await seedUrl(env.DB, { domain: DOMAIN_A, slug: "hello", target_url: "https://a.com" });
		await seedUrl(env.DB, { domain: DOMAIN_B, slug: "hello", target_url: "https://b.com" });

		const ctxA = mockExecCtx();
		const resA = await app.request(publicReq("hello", DOMAIN_A), undefined, getEnv(), ctxA);
		expect(resA.status).toBe(302);
		expect(resA.headers.get("Location")).toBe("https://a.com");
		await Promise.all(ctxA.promises);

		const ctxB = mockExecCtx();
		const resB = await app.request(publicReq("hello", DOMAIN_B), undefined, getEnv(), ctxB);
		expect(resB.status).toBe(302);
		expect(resB.headers.get("Location")).toBe("https://b.com");
		await Promise.all(ctxB.promises);
	});

	it("shows different 410 branding per domain", async () => {
		await seedDomain(env.DB, {
			domain: DOMAIN_A,
			name: "A",
			gone_title: "Gone A",
			gone_color: "#AA0000",
		});
		await seedDomain(env.DB, {
			domain: DOMAIN_B,
			name: "B",
			gone_title: "Gone B",
			gone_color: "#BB0000",
		});
		await seedUrl(env.DB, {
			domain: DOMAIN_A,
			slug: "exp",
			target_url: "https://a.com",
			expires_at: "2020-01-01 00:00:00",
		});
		await seedUrl(env.DB, {
			domain: DOMAIN_B,
			slug: "exp",
			target_url: "https://b.com",
			expires_at: "2020-01-01 00:00:00",
		});

		const ctxA = mockExecCtx();
		const resA = await app.request(publicReq("exp", DOMAIN_A), undefined, getEnv(), ctxA);
		expect(resA.status).toBe(410);
		const htmlA = await resA.text();
		expect(htmlA).toContain("Gone A");
		expect(htmlA).toContain("#AA0000");
		await Promise.all(ctxA.promises);

		const ctxB = mockExecCtx();
		const resB = await app.request(publicReq("exp", DOMAIN_B), undefined, getEnv(), ctxB);
		expect(resB.status).toBe(410);
		const htmlB = await resB.text();
		expect(htmlB).toContain("Gone B");
		expect(htmlB).toContain("#BB0000");
		await Promise.all(ctxB.promises);
	});

	it("domain=all returns URLs from all domains", async () => {
		await seedDomain(env.DB, { domain: DOMAIN_A, name: "A" });
		await seedDomain(env.DB, { domain: DOMAIN_B, name: "B" });
		await seedUrl(env.DB, { domain: DOMAIN_A, slug: "a1", target_url: "https://a.com/1" });
		await seedUrl(env.DB, { domain: DOMAIN_B, slug: "b1", target_url: "https://b.com/1" });

		const res = await app.request(apiReq("/api/urls?domain=all", DOMAIN_A), undefined, getEnv());
		expect(res.status).toBe(200);
		const body = await res.json<{ data: { domain: string }[] }>();
		const domains = body.data.map((u) => u.domain);
		expect(domains).toContain(DOMAIN_A);
		expect(domains).toContain(DOMAIN_B);
	});

	it("domain param in POST /api/shorten creates URL on specified domain", async () => {
		await seedDomain(env.DB, { domain: DOMAIN_A, name: "A" });
		await seedDomain(env.DB, { domain: DOMAIN_B, name: "B" });

		const res = await app.request(
			apiReq("/api/shorten", DOMAIN_A, "POST", {
				url: "https://b.com/cross",
				domain: DOMAIN_B,
			}),
			undefined,
			getEnv(),
		);
		expect(res.status).toBe(201);
		const body = await res.json<{ domain: string }>();
		expect(body.domain).toBe(DOMAIN_B);
	});

	it("returns 409 when deleting a domain that has URLs", async () => {
		await seedDomain(env.DB, { domain: DOMAIN_A, name: "A" });
		await seedUrl(env.DB, { domain: DOMAIN_A, slug: "keep", target_url: "https://a.com" });

		const res = await app.request(
			apiReq(`/api/domains/${DOMAIN_A}`, DOMAIN_A, "DELETE"),
			undefined,
			getEnv(),
		);
		expect(res.status).toBe(409);
		const body = await res.json<{ error: string }>();
		expect(body.error).toContain("existing URLs");
	});
});
