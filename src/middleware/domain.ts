import { createMiddleware } from "hono/factory";
import { getDomain } from "../lib/domain-cache";
import { badRequest } from "../lib/errors";
import type { AppEnv } from "../types";

export const domainMiddleware = createMiddleware<AppEnv>(async (c, next) => {
	if (c.req.path === "/health") {
		return next();
	}

	const host = c.req.header("Host");
	if (!host) {
		return badRequest("Missing Host header");
	}

	const domain = host.replace(/:\d+$/, "");
	const domainConfig = await getDomain(domain, c.env.DB);

	if (!domainConfig) {
		return badRequest(`Unknown domain: ${domain}`);
	}

	c.set("domain", domain);
	c.set("domainConfig", domainConfig);

	return next();
});
