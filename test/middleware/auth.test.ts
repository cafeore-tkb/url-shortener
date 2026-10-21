import { fetchMock } from "cloudflare:test";
import { Hono } from "hono";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { authMiddleware, clearJWKSCache } from "../../src/middleware/auth";
import type { AppEnv } from "../../src/types";

const TEAM_DOMAIN = "test-team.cloudflareaccess.com";
const POLICY_AUD = "test-aud-tag";

let publicJWK: JsonWebKey;
let privateKey: CryptoKey;

function createTestApp() {
	const app = new Hono<AppEnv>();
	app.use("*", authMiddleware);
	app.get("*", (c) => c.json({ email: c.get("email") }));
	return app;
}

async function signToken(
	overrides: {
		email?: string;
		issuer?: string;
		audience?: string;
		expiresIn?: string;
		key?: CryptoKey;
	} = {},
) {
	const builder = new SignJWT({ email: overrides.email ?? "user@example.com" })
		.setProtectedHeader({ alg: "RS256" })
		.setIssuedAt()
		.setIssuer(overrides.issuer ?? `https://${TEAM_DOMAIN}`)
		.setAudience(overrides.audience ?? POLICY_AUD)
		.setExpirationTime(overrides.expiresIn ?? "1h");

	return builder.sign(overrides.key ?? privateKey);
}

beforeAll(async () => {
	const keyPair = await generateKeyPair("RS256");
	privateKey = keyPair.privateKey as unknown as CryptoKey;
	publicJWK = await exportJWK(keyPair.publicKey);
});

beforeEach(() => {
	clearJWKSCache();
	fetchMock.activate();
	fetchMock.disableNetConnect();
});

afterEach(() => {
	fetchMock.deactivate();
});

function mockJWKS() {
	fetchMock
		.get(`https://${TEAM_DOMAIN}`)
		.intercept({ path: "/cdn-cgi/access/certs" })
		.reply(200, JSON.stringify({ keys: [{ ...publicJWK, alg: "RS256", use: "sig" }] }));
}

function env() {
	return { DB: {} as D1Database, TEAM_DOMAIN, POLICY_AUD };
}

describe("authMiddleware", () => {
	it("returns 200 with valid token", async () => {
		mockJWKS();
		const app = createTestApp();
		const token = await signToken();
		const res = await app.request(
			"/api/test",
			{ headers: { "Cf-Access-Jwt-Assertion": token } },
			env(),
		);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.email).toBe("user@example.com");
	});

	it("returns 401 when header is missing", async () => {
		const app = createTestApp();
		const res = await app.request("/api/test", {}, env());
		expect(res.status).toBe(401);
	});

	it("returns 401 with invalid signature", async () => {
		mockJWKS();
		const wrongKeyPair = await generateKeyPair("RS256");
		const token = await signToken({
			key: wrongKeyPair.privateKey as unknown as CryptoKey,
		});
		const app = createTestApp();
		const res = await app.request(
			"/api/test",
			{ headers: { "Cf-Access-Jwt-Assertion": token } },
			env(),
		);
		expect(res.status).toBe(401);
	});

	it("returns 401 with wrong audience", async () => {
		mockJWKS();
		const token = await signToken({ audience: "wrong-aud" });
		const app = createTestApp();
		const res = await app.request(
			"/api/test",
			{ headers: { "Cf-Access-Jwt-Assertion": token } },
			env(),
		);
		expect(res.status).toBe(401);
	});

	it("returns 401 with wrong issuer", async () => {
		mockJWKS();
		const token = await signToken({ issuer: "https://wrong.cloudflareaccess.com" });
		const app = createTestApp();
		const res = await app.request(
			"/api/test",
			{ headers: { "Cf-Access-Jwt-Assertion": token } },
			env(),
		);
		expect(res.status).toBe(401);
	});

	it("returns 401 with expired token", async () => {
		mockJWKS();
		const token = await signToken({ expiresIn: "-1h" });
		const app = createTestApp();
		const res = await app.request(
			"/api/test",
			{ headers: { "Cf-Access-Jwt-Assertion": token } },
			env(),
		);
		expect(res.status).toBe(401);
	});

	it("returns 401 when token has no email claim", async () => {
		mockJWKS();
		const token = await new SignJWT({})
			.setProtectedHeader({ alg: "RS256" })
			.setIssuedAt()
			.setIssuer(`https://${TEAM_DOMAIN}`)
			.setAudience(POLICY_AUD)
			.setExpirationTime("1h")
			.sign(privateKey);
		const app = createTestApp();
		const res = await app.request(
			"/api/test",
			{ headers: { "Cf-Access-Jwt-Assertion": token } },
			env(),
		);
		expect(res.status).toBe(401);
	});
});
