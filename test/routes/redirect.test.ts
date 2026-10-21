import { beforeEach, describe, expect, it, vi } from "vitest";
import app from "../../src/index";
import { invalidateAll } from "../../src/lib/domain-cache";

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

function createMockDB(urlRow: Record<string, unknown> | null, onClickUpdate?: () => void) {
	return {
		prepare: (sql: string) => ({
			bind: (..._args: unknown[]) => ({
				first: async () => {
					if (sql.includes("FROM domains")) {
						return domainRow;
					}
					if (sql.includes("FROM urls")) {
						return urlRow;
					}
					return null;
				},
				run: async () => {
					if (sql.includes("UPDATE urls SET clicks") && onClickUpdate) {
						onClickUpdate();
					}
					return {};
				},
			}),
		}),
	} as unknown as D1Database;
}

function env(db: D1Database) {
	return { DB: db, TEAM_DOMAIN, POLICY_AUD };
}

function req(slug: string) {
	return new Request(`http://${DOMAIN}/${slug}`, {
		headers: { Host: DOMAIN },
	});
}

function mockExecutionCtx(waitUntilFn?: (p: Promise<unknown>) => void): ExecutionContext {
	return {
		waitUntil: waitUntilFn ?? (() => {}),
		passThroughOnException: () => {},
	} as ExecutionContext;
}

describe("GET /:slug", () => {
	beforeEach(() => {
		invalidateAll();
	});

	it("redirects with 302 for a valid slug", async () => {
		const db = createMockDB({ target_url: "https://example.com", expires_at: null });
		const res = await app.request(req("abc"), undefined, env(db), mockExecutionCtx());
		expect(res.status).toBe(302);
		expect(res.headers.get("Location")).toBe("https://example.com");
	});

	it("returns 410 with HTML for an expired slug", async () => {
		const db = createMockDB({
			target_url: "https://example.com",
			expires_at: "2020-01-01 00:00:00",
		});
		const res = await app.request(req("expired"), undefined, env(db), mockExecutionCtx());
		expect(res.status).toBe(410);
		expect(res.headers.get("Content-Type")).toContain("text/html");
		const body = await res.text();
		expect(body).toContain("Link Expired");
		expect(body).toContain("This link is no longer available.");
		expect(body).toContain("#FF0000");
	});

	it("returns 404 JSON for a non-existent slug", async () => {
		const db = createMockDB(null);
		const res = await app.request(req("nope"), undefined, env(db), mockExecutionCtx());
		expect(res.status).toBe(404);
		const body = await res.json();
		expect(body.error).toBe("URL not found");
	});

	it("returns 404 for a soft-deleted slug (deleted_at IS NULL filter)", async () => {
		// The mock returns null to simulate that the SQL WHERE deleted_at IS NULL excludes this row
		const db = createMockDB(null);
		const res = await app.request(req("deleted"), undefined, env(db), mockExecutionCtx());
		expect(res.status).toBe(404);
		const body = await res.json();
		expect(body.error).toBe("URL not found");
	});

	it("increments clicks via waitUntil after redirect", async () => {
		const clickUpdated = vi.fn();
		const db = createMockDB({ target_url: "https://example.com", expires_at: null }, clickUpdated);
		const waitUntilPromises: Promise<unknown>[] = [];
		const ctx = mockExecutionCtx((p) => waitUntilPromises.push(p));
		const res = await app.request(req("tracked"), undefined, env(db), ctx);
		expect(res.status).toBe(302);
		await Promise.all(waitUntilPromises);
		expect(clickUpdated).toHaveBeenCalledOnce();
	});
});
