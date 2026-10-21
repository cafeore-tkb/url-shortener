import { createMiddleware } from "hono/factory";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { unauthorized } from "../lib/errors";
import type { AppEnv } from "../types";

const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

export function clearJWKSCache(): void {
	jwksCache.clear();
}

function getJWKS(teamDomain: string): ReturnType<typeof createRemoteJWKSet> {
	let jwks = jwksCache.get(teamDomain);
	if (!jwks) {
		jwks = createRemoteJWKSet(new URL(`https://${teamDomain}/cdn-cgi/access/certs`));
		jwksCache.set(teamDomain, jwks);
	}
	return jwks;
}

export const authMiddleware = createMiddleware<AppEnv>(async (c, next) => {
	if (c.env.DEV_AUTH_BYPASS === "true") {
		c.set("email", "dev@localhost");
		return next();
	}

	const token = c.req.header("Cf-Access-Jwt-Assertion");
	if (!token) {
		return unauthorized("Missing authentication token");
	}

	const teamDomain = c.env.TEAM_DOMAIN;
	const audience = c.env.POLICY_AUD;

	try {
		const jwks = getJWKS(teamDomain);
		const { payload } = await jwtVerify(token, jwks, {
			issuer: `https://${teamDomain}`,
			audience,
		});

		if (!payload.email || typeof payload.email !== "string") {
			return unauthorized("Token missing email claim");
		}

		c.set("email", payload.email);
	} catch {
		return unauthorized("Invalid authentication token");
	}

	return next();
});
