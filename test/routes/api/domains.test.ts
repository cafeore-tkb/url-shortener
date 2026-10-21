import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as domainCache from "../../../src/lib/domain-cache";
import { domainMiddleware } from "../../../src/middleware/domain";
import domainsApp from "../../../src/routes/api/domains";
import type { AppEnv, DomainRow } from "../../../src/types";

const DOMAIN = "short.test";
const TEAM_DOMAIN = "test-team.cloudflareaccess.com";
const POLICY_AUD = "test-aud-tag";

const domainRow: DomainRow = {
	domain: DOMAIN,
	name: "Test",
	gone_title: "Link Expired",
	gone_message: "This link is no longer available.",
	gone_color: "#FF0000",
	gone_logo_url: null,
	created_at: "2024-01-01 00:00:00",
	external: 0,
	custom_hostname_id: null,
	hostname_status: null,
	ssl_status: null,
	ownership_verification: null,
	ssl_validation: null,
	dcv_delegation: null,
	hostname_checked_at: null,
};

function createTestApp() {
	const app = new Hono<AppEnv>();
	app.use("*", domainMiddleware);
	app.route("/api", domainsApp);
	return app;
}

function env(db: D1Database) {
	return { DB: db, TEAM_DOMAIN, POLICY_AUD };
}

type MockDBOptions = {
	firstFn?: (sql: string, binds: unknown[]) => unknown;
	allFn?: (sql: string, binds: unknown[]) => { results: unknown[] };
	runFn?: (sql: string, binds: unknown[]) => { meta: { changes: number } };
};

function createMockDB(opts: MockDBOptions = {}) {
	const defaultFirst = (sql: string, _binds: unknown[]) => {
		if (sql.includes("FROM domains")) return domainRow;
		return null;
	};
	const defaultAll = () => ({ results: [] });
	const defaultRun = () => ({ meta: { changes: 1 } });

	const firstFn = opts.firstFn ?? defaultFirst;
	const allFn = opts.allFn ?? defaultAll;
	const runFn = opts.runFn ?? defaultRun;

	return {
		prepare: (sql: string) => ({
			bind: (...binds: unknown[]) => ({
				first: async () => firstFn(sql, binds),
				all: async () => allFn(sql, binds),
				run: async () => runFn(sql, binds),
			}),
		}),
	} as unknown as D1Database;
}

function jsonReq(path: string, method: string, body?: unknown) {
	const init: RequestInit = {
		method,
		headers: { Host: DOMAIN, "Content-Type": "application/json" },
	};
	if (body !== undefined) {
		init.body = JSON.stringify(body);
	}
	return new Request(`http://${DOMAIN}${path}`, init);
}

function getReq(path: string) {
	return new Request(`http://${DOMAIN}${path}`, {
		headers: { Host: DOMAIN },
	});
}

describe("Domain Management API", () => {
	beforeEach(() => {
		domainCache.invalidateAll();
		vi.restoreAllMocks();
	});

	// ─── GET /api/domains ───

	describe("GET /api/domains", () => {
		it("returns all domains", async () => {
			const db = createMockDB({
				firstFn: (sql) => {
					if (sql.includes("FROM domains")) return domainRow;
					return null;
				},
				allFn: () => ({ results: [domainRow] }),
			});
			const app = createTestApp();
			const res = await app.request(getReq("/api/domains"), undefined, env(db));
			expect(res.status).toBe(200);
			const body = await res.json();
			expect(body.data).toHaveLength(1);
			expect(body.data[0].domain).toBe(DOMAIN);
		});
	});

	// ─── POST /api/domains ───

	describe("POST /api/domains", () => {
		it("creates a domain (201)", async () => {
			const newDomain: DomainRow = {
				domain: "new.test",
				name: "New Domain",
				gone_title: "Link Removed",
				gone_message: "This link is no longer available.",
				gone_color: "#6366F1",
				gone_logo_url: null,
				created_at: "2024-01-01 00:00:00",
				external: 0,
				custom_hostname_id: null,
				hostname_status: null,
				ssl_status: null,
				ownership_verification: null,
				ssl_validation: null,
				dcv_delegation: null,
				hostname_checked_at: null,
			};
			const db = createMockDB({
				firstFn: (sql, binds) => {
					// domainMiddleware lookup for Host header
					if (sql.includes("FROM domains") && binds[0] === DOMAIN) return domainRow;
					// POST handler fetches newly created row
					if (sql.includes("FROM domains") && binds[0] === "new.test") return newDomain;
					return null;
				},
			});
			const app = createTestApp();
			const res = await app.request(
				jsonReq("/api/domains", "POST", { domain: "new.test", name: "New Domain" }),
				undefined,
				env(db),
			);
			expect(res.status).toBe(201);
			const body = await res.json();
			expect(body.domain).toBe("new.test");
		});

		it("returns 400 when domain is missing", async () => {
			const db = createMockDB();
			const app = createTestApp();
			const res = await app.request(
				jsonReq("/api/domains", "POST", { name: "Test" }),
				undefined,
				env(db),
			);
			expect(res.status).toBe(400);
			const body = await res.json();
			expect(body.error).toContain("domain");
		});

		it("returns 400 when name is missing", async () => {
			const db = createMockDB();
			const app = createTestApp();
			const res = await app.request(
				jsonReq("/api/domains", "POST", { domain: "test.com" }),
				undefined,
				env(db),
			);
			expect(res.status).toBe(400);
			const body = await res.json();
			expect(body.error).toContain("name");
		});

		it("returns 400 for invalid gone_color", async () => {
			const db = createMockDB();
			const app = createTestApp();
			const res = await app.request(
				jsonReq("/api/domains", "POST", {
					domain: "test.com",
					name: "Test",
					gone_color: "not-a-color",
				}),
				undefined,
				env(db),
			);
			expect(res.status).toBe(400);
			const body = await res.json();
			expect(body.error).toContain("Color");
		});

		it("returns 409 for duplicate domain", async () => {
			const db = createMockDB({
				runFn: (sql) => {
					if (sql.includes("INSERT")) {
						throw new Error("UNIQUE constraint failed: domains.domain");
					}
					return { meta: { changes: 1 } };
				},
			});
			const app = createTestApp();
			const res = await app.request(
				jsonReq("/api/domains", "POST", { domain: DOMAIN, name: "Dup" }),
				undefined,
				env(db),
			);
			expect(res.status).toBe(409);
			const body = await res.json();
			expect(body.error).toContain("already exists");
		});
	});

	// ─── PATCH /api/domains/:domain ───

	describe("PATCH /api/domains/:domain", () => {
		it("updates domain fields (200)", async () => {
			const updated = { ...domainRow, name: "Updated" };
			const db = createMockDB({
				firstFn: (sql) => {
					if (sql.includes("FROM domains")) return updated;
					return null;
				},
				runFn: () => ({ meta: { changes: 1 } }),
			});
			const app = createTestApp();
			const res = await app.request(
				jsonReq(`/api/domains/${DOMAIN}`, "PATCH", { name: "Updated" }),
				undefined,
				env(db),
			);
			expect(res.status).toBe(200);
			const body = await res.json();
			expect(body.name).toBe("Updated");
		});

		it("allows setting gone_logo_url to null", async () => {
			const updated = { ...domainRow, gone_logo_url: null };
			const db = createMockDB({
				firstFn: (sql) => {
					if (sql.includes("FROM domains")) return updated;
					return null;
				},
				runFn: () => ({ meta: { changes: 1 } }),
			});
			const app = createTestApp();
			const res = await app.request(
				jsonReq(`/api/domains/${DOMAIN}`, "PATCH", { gone_logo_url: null }),
				undefined,
				env(db),
			);
			expect(res.status).toBe(200);
			const body = await res.json();
			expect(body.gone_logo_url).toBeNull();
		});

		it("returns 404 for non-existent domain", async () => {
			const db = createMockDB({
				runFn: () => ({ meta: { changes: 0 } }),
			});
			const app = createTestApp();
			const res = await app.request(
				jsonReq("/api/domains/nope.test", "PATCH", { name: "X" }),
				undefined,
				env(db),
			);
			expect(res.status).toBe(404);
		});

		it("returns 400 when no fields provided", async () => {
			const db = createMockDB();
			const app = createTestApp();
			const res = await app.request(
				jsonReq(`/api/domains/${DOMAIN}`, "PATCH", {}),
				undefined,
				env(db),
			);
			expect(res.status).toBe(400);
			const body = await res.json();
			expect(body.error).toContain("No fields");
		});

		it("invalidates cache after update", async () => {
			const spy = vi.spyOn(domainCache, "invalidate");
			const db = createMockDB({
				firstFn: (sql) => {
					if (sql.includes("FROM domains")) return domainRow;
					return null;
				},
				runFn: () => ({ meta: { changes: 1 } }),
			});
			const app = createTestApp();
			await app.request(
				jsonReq(`/api/domains/${DOMAIN}`, "PATCH", { name: "Updated" }),
				undefined,
				env(db),
			);
			expect(spy).toHaveBeenCalledWith(DOMAIN);
		});
	});

	// ─── DELETE /api/domains/:domain ───

	describe("DELETE /api/domains/:domain", () => {
		it("deletes a domain with no URLs (204)", async () => {
			const db = createMockDB({
				firstFn: (sql) => {
					if (sql.includes("FROM domains") && !sql.includes("DELETE")) return domainRow;
					if (sql.includes("FROM urls")) return null; // no URLs
					return null;
				},
				runFn: () => ({ meta: { changes: 1 } }),
			});
			const app = createTestApp();
			const res = await app.request(
				jsonReq(`/api/domains/${DOMAIN}`, "DELETE"),
				undefined,
				env(db),
			);
			expect(res.status).toBe(204);
		});

		it("returns 409 when domain has URLs", async () => {
			const db = createMockDB({
				firstFn: (sql) => {
					if (sql.includes("FROM domains")) return domainRow;
					if (sql.includes("FROM urls")) return { 1: 1 }; // URLs exist
					return null;
				},
			});
			const app = createTestApp();
			const res = await app.request(
				jsonReq(`/api/domains/${DOMAIN}`, "DELETE"),
				undefined,
				env(db),
			);
			expect(res.status).toBe(409);
			const body = await res.json();
			expect(body.error).toContain("existing URLs");
		});

		it("returns 404 for non-existent domain", async () => {
			const db = createMockDB({
				firstFn: (sql) => {
					if (sql.includes("FROM domains") && !sql.includes("DELETE")) return domainRow;
					return null; // no URLs found
				},
				runFn: () => ({ meta: { changes: 0 } }),
			});
			const app = createTestApp();
			const res = await app.request(
				jsonReq("/api/domains/nope.test", "DELETE"),
				undefined,
				env(db),
			);
			expect(res.status).toBe(404);
		});

		it("invalidates cache after delete", async () => {
			const spy = vi.spyOn(domainCache, "invalidate");
			const db = createMockDB({
				firstFn: (sql) => {
					if (sql.includes("FROM domains")) return domainRow;
					if (sql.includes("FROM urls")) return null;
					return null;
				},
				runFn: () => ({ meta: { changes: 1 } }),
			});
			const app = createTestApp();
			await app.request(jsonReq(`/api/domains/${DOMAIN}`, "DELETE"), undefined, env(db));
			expect(spy).toHaveBeenCalledWith(DOMAIN);
		});
	});
});
