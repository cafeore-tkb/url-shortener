import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { csrfMiddleware } from "../../src/middleware/csrf";
import type { AppEnv } from "../../src/types";

const ORIGIN = "https://s.example.com";

function request(method: string, headers: Record<string, string> = {}) {
	const app = new Hono<AppEnv>();
	app.use("*", csrfMiddleware);
	app.all("*", (c) => c.json({ ok: true }));
	return app.request(`${ORIGIN}/api/shorten`, { method, headers });
}

describe("csrfMiddleware", () => {
	it("allows requests without Origin or Sec-Fetch-Site (curl, server-to-server)", async () => {
		for (const method of ["POST", "PATCH", "DELETE"]) {
			expect((await request(method)).status).toBe(200);
		}
	});

	it("allows same-origin requests from a browser", async () => {
		const res = await request("POST", { Origin: ORIGIN, "Sec-Fetch-Site": "same-origin" });
		expect(res.status).toBe(200);
	});

	it("rejects cross-origin requests from a browser", async () => {
		for (const headers of [
			{ Origin: "https://evil.example", "Sec-Fetch-Site": "cross-site" },
			{ Origin: "https://other.example.com", "Sec-Fetch-Site": "same-site" },
			// Sec-Fetch-Site を送らない古いブラウザ
			{ Origin: "https://evil.example" },
			{ Origin: "null" },
		]) {
			const res = await request("POST", headers);
			expect(res.status).toBe(403);
			expect(await res.json()).toEqual({
				error: "Cross-origin requests are not allowed",
				status: 403,
			});
		}
	});

	it("does not check safe methods", async () => {
		const res = await request("GET", {
			Origin: "https://evil.example",
			"Sec-Fetch-Site": "cross-site",
		});
		expect(res.status).toBe(200);
	});
});
