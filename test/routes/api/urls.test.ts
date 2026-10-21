import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { invalidateAll } from "../../../src/lib/domain-cache";
import * as slugGenerator from "../../../src/lib/slug-generator";
import { domainMiddleware } from "../../../src/middleware/domain";
import urlsApp from "../../../src/routes/api/urls";
import type { AppEnv, UrlRow } from "../../../src/types";

const DOMAIN = "short.test";
const TEAM_DOMAIN = "test-team.cloudflareaccess.com";
const POLICY_AUD = "test-aud-tag";

const domainRow = {
	domain: DOMAIN,
	name: "Test",
	gone_title: "Link Expired",
	gone_message: "This link is no longer available.",
	gone_color: "#FF0000",
	gone_logo_url: null,
	created_at: "2024-01-01 00:00:00",
};

const sampleUrl: UrlRow = {
	domain: DOMAIN,
	slug: "abc123",
	target_url: "https://example.com",
	expires_at: null,
	clicks: 0,
	created_at: "2024-01-01 00:00:00",
	deleted_at: null,
	note: null,
	folder_id: null,
};

function createTestApp() {
	const app = new Hono<AppEnv>();
	app.use("*", domainMiddleware);
	app.route("/api", urlsApp);
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

describe("URL Management API", () => {
	beforeEach(() => {
		invalidateAll();
	});

	// ─── POST /api/shorten ───

	describe("POST /api/shorten", () => {
		it("creates a URL with auto-generated slug (201)", async () => {
			vi.spyOn(slugGenerator, "generateSlug").mockReturnValue("gen123");
			const db = createMockDB({
				firstFn: (sql) => {
					if (sql.includes("FROM domains")) return domainRow;
					if (sql.includes("SELECT 1")) return null; // no collision
					if (sql.includes("SELECT *")) return { ...sampleUrl, slug: "gen123" };
					return null;
				},
			});
			const app = createTestApp();
			const res = await app.request(
				jsonReq("/api/shorten", "POST", { url: "https://example.com" }),
				undefined,
				env(db),
			);
			expect(res.status).toBe(201);
			const body = await res.json();
			expect(body.slug).toBe("gen123");
			expect(body.short_url).toBe(`https://${DOMAIN}/gen123`);
			expect(body.target_url).toBe("https://example.com");
			vi.restoreAllMocks();
		});

		it("creates a URL with custom slug (201)", async () => {
			const db = createMockDB({
				firstFn: (sql) => {
					if (sql.includes("FROM domains")) return domainRow;
					if (sql.includes("SELECT 1")) return null;
					if (sql.includes("SELECT *")) return { ...sampleUrl, slug: "my-slug" };
					return null;
				},
			});
			const app = createTestApp();
			const res = await app.request(
				jsonReq("/api/shorten", "POST", { url: "https://example.com", slug: "my-slug" }),
				undefined,
				env(db),
			);
			expect(res.status).toBe(201);
			const body = await res.json();
			expect(body.slug).toBe("my-slug");
		});

		it("returns 400 when url is missing", async () => {
			const db = createMockDB();
			const app = createTestApp();
			const res = await app.request(jsonReq("/api/shorten", "POST", {}), undefined, env(db));
			expect(res.status).toBe(400);
			const body = await res.json();
			expect(body.error).toContain("url");
		});

		it("returns 400 for invalid url", async () => {
			const db = createMockDB();
			const app = createTestApp();
			const res = await app.request(
				jsonReq("/api/shorten", "POST", { url: "not-a-url" }),
				undefined,
				env(db),
			);
			expect(res.status).toBe(400);
		});

		it("returns 400 for invalid slug", async () => {
			const db = createMockDB();
			const app = createTestApp();
			const res = await app.request(
				jsonReq("/api/shorten", "POST", { url: "https://example.com", slug: "bad slug!" }),
				undefined,
				env(db),
			);
			expect(res.status).toBe(400);
		});

		it("returns 400 for invalid JSON body", async () => {
			const db = createMockDB();
			const app = createTestApp();
			const res = await app.request(
				new Request(`http://${DOMAIN}/api/shorten`, {
					method: "POST",
					headers: { Host: DOMAIN, "Content-Type": "application/json" },
					body: "not json",
				}),
				undefined,
				env(db),
			);
			expect(res.status).toBe(400);
			const body = await res.json();
			expect(body.error).toContain("Invalid JSON");
		});

		it("returns 400 for invalid expires_at", async () => {
			const db = createMockDB();
			const app = createTestApp();
			const res = await app.request(
				jsonReq("/api/shorten", "POST", { url: "https://example.com", expires_at: "not-a-date" }),
				undefined,
				env(db),
			);
			expect(res.status).toBe(400);
			const body = await res.json();
			expect(body.error).toContain("expires_at");
		});

		it("returns 409 for duplicate custom slug", async () => {
			const db = createMockDB({
				firstFn: (sql) => {
					if (sql.includes("FROM domains")) return domainRow;
					if (sql.includes("SELECT 1")) return { 1: 1 }; // collision
					return null;
				},
			});
			const app = createTestApp();
			const res = await app.request(
				jsonReq("/api/shorten", "POST", { url: "https://example.com", slug: "taken" }),
				undefined,
				env(db),
			);
			expect(res.status).toBe(409);
		});

		it("returns 400 for unknown domain parameter", async () => {
			const db = createMockDB({
				firstFn: (sql, binds) => {
					if (sql.includes("FROM domains")) {
						// Only return domainRow for the Host domain, null for unknown
						if (binds[0] === DOMAIN) return domainRow;
						return null;
					}
					return null;
				},
			});
			const app = createTestApp();
			const res = await app.request(
				jsonReq("/api/shorten", "POST", { url: "https://example.com", domain: "unknown.test" }),
				undefined,
				env(db),
			);
			expect(res.status).toBe(400);
			const body = await res.json();
			expect(body.error).toContain("Unknown domain");
		});

		it("returns 500 when slug generation retries are exhausted", async () => {
			vi.spyOn(slugGenerator, "generateSlug").mockReturnValue("collide");
			const db = createMockDB({
				firstFn: (sql) => {
					if (sql.includes("FROM domains")) return domainRow;
					if (sql.includes("SELECT 1")) return { 1: 1 }; // always collides
					return null;
				},
			});
			const app = createTestApp();
			const res = await app.request(
				jsonReq("/api/shorten", "POST", { url: "https://example.com" }),
				undefined,
				env(db),
			);
			expect(res.status).toBe(500);
			vi.restoreAllMocks();
		});
	});

	// ─── GET /api/urls ───

	describe("GET /api/urls", () => {
		it("returns paginated results", async () => {
			const db = createMockDB({
				firstFn: (sql) => {
					if (sql.includes("FROM domains")) return domainRow;
					if (sql.includes("COUNT")) return { count: 25 };
					return null;
				},
				allFn: () => ({ results: [sampleUrl] }),
			});
			const app = createTestApp();
			const res = await app.request(getReq("/api/urls?page=2&per_page=10"), undefined, env(db));
			expect(res.status).toBe(200);
			const body = await res.json();
			expect(body.pagination).toEqual({
				page: 2,
				per_page: 10,
				total: 25,
				total_pages: 3,
			});
			expect(body.data).toHaveLength(1);
		});

		it("filters by status=deleted", async () => {
			const db = createMockDB({
				firstFn: (sql) => {
					if (sql.includes("FROM domains")) return domainRow;
					if (sql.includes("COUNT")) return { count: 1 };
					return null;
				},
				allFn: () => ({
					results: [{ ...sampleUrl, deleted_at: "2024-06-01 00:00:00" }],
				}),
			});
			const app = createTestApp();
			const res = await app.request(getReq("/api/urls?status=deleted"), undefined, env(db));
			expect(res.status).toBe(200);
			const body = await res.json();
			expect(body.data).toHaveLength(1);
		});

		it("supports q search parameter", async () => {
			const db = createMockDB({
				firstFn: (sql) => {
					if (sql.includes("FROM domains")) return domainRow;
					if (sql.includes("COUNT")) return { count: 1 };
					return null;
				},
				allFn: () => ({ results: [sampleUrl] }),
			});
			const app = createTestApp();
			const res = await app.request(getReq("/api/urls?q=example"), undefined, env(db));
			expect(res.status).toBe(200);
			const body = await res.json();
			expect(body.data).toHaveLength(1);
		});

		it("supports domain=all", async () => {
			const db = createMockDB({
				firstFn: (sql) => {
					if (sql.includes("FROM domains")) return domainRow;
					if (sql.includes("COUNT")) return { count: 0 };
					return null;
				},
				allFn: () => ({ results: [] }),
			});
			const app = createTestApp();
			const res = await app.request(getReq("/api/urls?domain=all"), undefined, env(db));
			expect(res.status).toBe(200);
			const body = await res.json();
			expect(body.pagination.total).toBe(0);
		});
	});

	// ─── GET /api/urls/:slug/stats ───

	describe("GET /api/urls/:slug/stats", () => {
		it("returns URL stats (200)", async () => {
			const db = createMockDB({
				firstFn: (sql) => {
					if (sql.includes("FROM domains")) return domainRow;
					if (sql.includes("FROM urls")) return sampleUrl;
					return null;
				},
			});
			const app = createTestApp();
			const res = await app.request(getReq("/api/urls/abc123/stats"), undefined, env(db));
			expect(res.status).toBe(200);
			const body = await res.json();
			expect(body.slug).toBe("abc123");
			expect(body.target_url).toBe("https://example.com");
		});

		it("returns stats for deleted URLs", async () => {
			const deletedUrl = { ...sampleUrl, deleted_at: "2024-06-01 00:00:00" };
			const db = createMockDB({
				firstFn: (sql) => {
					if (sql.includes("FROM domains")) return domainRow;
					if (sql.includes("FROM urls")) return deletedUrl;
					return null;
				},
			});
			const app = createTestApp();
			const res = await app.request(getReq("/api/urls/abc123/stats"), undefined, env(db));
			expect(res.status).toBe(200);
			const body = await res.json();
			expect(body.deleted_at).toBe("2024-06-01 00:00:00");
		});

		it("returns 404 for non-existent slug", async () => {
			const db = createMockDB({
				firstFn: (sql) => {
					if (sql.includes("FROM domains")) return domainRow;
					return null;
				},
			});
			const app = createTestApp();
			const res = await app.request(getReq("/api/urls/nope/stats"), undefined, env(db));
			expect(res.status).toBe(404);
		});
	});

	// ─── PATCH /api/urls/:slug ───

	describe("PATCH /api/urls/:slug", () => {
		it("updates target_url (200)", async () => {
			const updated = { ...sampleUrl, target_url: "https://new.com" };
			const db = createMockDB({
				firstFn: (sql) => {
					if (sql.includes("FROM domains")) return domainRow;
					if (sql.includes("FROM urls")) return updated;
					return null;
				},
				runFn: () => ({ meta: { changes: 1 } }),
			});
			const app = createTestApp();
			const res = await app.request(
				jsonReq("/api/urls/abc123", "PATCH", { target_url: "https://new.com" }),
				undefined,
				env(db),
			);
			expect(res.status).toBe(200);
			const body = await res.json();
			expect(body.target_url).toBe("https://new.com");
		});

		it("returns 404 for non-existent slug", async () => {
			const db = createMockDB({
				firstFn: (sql) => {
					if (sql.includes("FROM domains")) return domainRow;
					return null;
				},
				runFn: () => ({ meta: { changes: 0 } }),
			});
			const app = createTestApp();
			const res = await app.request(
				jsonReq("/api/urls/nope", "PATCH", { target_url: "https://new.com" }),
				undefined,
				env(db),
			);
			expect(res.status).toBe(404);
		});

		it("returns 400 for invalid target_url", async () => {
			const db = createMockDB();
			const app = createTestApp();
			const res = await app.request(
				jsonReq("/api/urls/abc123", "PATCH", { target_url: "bad" }),
				undefined,
				env(db),
			);
			expect(res.status).toBe(400);
		});

		it("returns 400 for invalid expires_at", async () => {
			const db = createMockDB();
			const app = createTestApp();
			const res = await app.request(
				jsonReq("/api/urls/abc123", "PATCH", { expires_at: "not-a-date" }),
				undefined,
				env(db),
			);
			expect(res.status).toBe(400);
		});

		it("returns 400 when no fields provided", async () => {
			const db = createMockDB();
			const app = createTestApp();
			const res = await app.request(jsonReq("/api/urls/abc123", "PATCH", {}), undefined, env(db));
			expect(res.status).toBe(400);
			const body = await res.json();
			expect(body.error).toContain("No fields");
		});

		it("returns 400 for note exceeding 500 characters", async () => {
			const db = createMockDB();
			const app = createTestApp();
			const res = await app.request(
				jsonReq("/api/urls/abc123", "PATCH", { note: "x".repeat(501) }),
				undefined,
				env(db),
			);
			expect(res.status).toBe(400);
			const body = await res.json();
			expect(body.error).toContain("Note");
		});
	});

	// ─── DELETE /api/urls/:slug ───

	describe("DELETE /api/urls/:slug", () => {
		it("soft-deletes a URL (204)", async () => {
			const db = createMockDB({
				firstFn: (sql) => {
					if (sql.includes("FROM domains")) return domainRow;
					return null;
				},
				runFn: () => ({ meta: { changes: 1 } }),
			});
			const app = createTestApp();
			const res = await app.request(jsonReq("/api/urls/abc123", "DELETE"), undefined, env(db));
			expect(res.status).toBe(204);
		});

		it("returns 404 for non-existent slug", async () => {
			const db = createMockDB({
				firstFn: (sql) => {
					if (sql.includes("FROM domains")) return domainRow;
					return null;
				},
				runFn: () => ({ meta: { changes: 0 } }),
			});
			const app = createTestApp();
			const res = await app.request(jsonReq("/api/urls/nope", "DELETE"), undefined, env(db));
			expect(res.status).toBe(404);
		});
	});
});
