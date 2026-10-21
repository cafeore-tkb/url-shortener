import { Hono } from "hono";
import { notFound } from "../lib/errors";
import { render410Page } from "../lib/gone-page";
import type { AppEnv, UrlRow } from "../types";

const app = new Hono<AppEnv>();

app.get("/:slug", async (c) => {
	const slug = c.req.param("slug");
	const domain = c.get("domain");
	const domainConfig = c.get("domainConfig");
	const db = c.env.DB;

	const row = await db
		.prepare(
			"SELECT target_url, expires_at FROM urls WHERE domain = ? AND slug = ? AND deleted_at IS NULL",
		)
		.bind(domain, slug)
		.first<Pick<UrlRow, "target_url" | "expires_at">>();

	if (!row) {
		return notFound("URL not found");
	}

	if (row.expires_at && new Date(row.expires_at) < new Date()) {
		const html = render410Page({
			title: domainConfig.gone_title,
			message: domainConfig.gone_message,
			color: domainConfig.gone_color,
			logoUrl: domainConfig.gone_logo_url,
		});
		return c.html(html, 410);
	}

	c.executionCtx.waitUntil(
		db
			.prepare("UPDATE urls SET clicks = clicks + 1 WHERE domain = ? AND slug = ?")
			.bind(domain, slug)
			.run(),
	);

	return c.redirect(row.target_url, 302);
});

export default app;
