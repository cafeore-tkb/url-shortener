import { Hono } from "hono";
import { getDomain } from "../../lib/domain-cache";
import { badRequest, conflict, notFound } from "../../lib/errors";
import { folderExists } from "../../lib/folders";
import { generateSlug } from "../../lib/slug-generator";
import { validateFolderId, validateSlug, validateTargetUrl } from "../../lib/validation";
import type { AppEnv, UrlRow } from "../../types";

const app = new Hono<AppEnv>();

// POST /shorten
app.post("/shorten", async (c) => {
	let body: Record<string, unknown>;
	try {
		body = await c.req.json();
	} catch {
		return badRequest("Invalid JSON body");
	}

	const {
		url,
		slug: customSlug,
		expires_at,
		note,
		domain: domainParam,
		folder_id = null,
	} = body as {
		url?: string;
		slug?: string;
		expires_at?: string;
		note?: string;
		domain?: string;
		folder_id?: unknown;
	};

	if (!url) {
		return badRequest("Missing required field: url");
	}

	const urlValidation = validateTargetUrl(url);
	if (!urlValidation.valid) {
		return badRequest(urlValidation.reason);
	}

	if (customSlug !== undefined) {
		const slugValidation = validateSlug(customSlug);
		if (!slugValidation.valid) {
			return badRequest(slugValidation.reason);
		}
	}

	if (expires_at !== undefined) {
		const parsed = Date.parse(expires_at);
		if (Number.isNaN(parsed)) {
			return badRequest("Invalid expires_at date");
		}
	}

	const folderValidation = validateFolderId(folder_id);
	if (!folderValidation.valid) {
		return badRequest(folderValidation.reason);
	}

	const db = c.env.DB;
	const folderId = folder_id as number | null;
	if (folderId !== null && !(await folderExists(db, folderId))) {
		return badRequest(`Unknown folder: ${folderId}`);
	}

	let domain: string;

	if (domainParam) {
		const domainRow = await getDomain(domainParam, db);
		if (!domainRow) {
			return badRequest(`Unknown domain: ${domainParam}`);
		}
		domain = domainParam;
	} else {
		domain = c.get("domain");
	}

	let slug: string;

	if (customSlug) {
		const existing = await db
			.prepare("SELECT 1 FROM urls WHERE domain = ? AND slug = ?")
			.bind(domain, customSlug)
			.first();
		if (existing) {
			return conflict("Slug already exists");
		}
		slug = customSlug;
	} else {
		let found = false;
		slug = "";
		for (let i = 0; i < 5; i++) {
			slug = generateSlug();
			const existing = await db
				.prepare("SELECT 1 FROM urls WHERE domain = ? AND slug = ?")
				.bind(domain, slug)
				.first();
			if (!existing) {
				found = true;
				break;
			}
		}
		if (!found) {
			return Response.json(
				{ error: "Failed to generate unique slug", status: 500 },
				{ status: 500 },
			);
		}
	}

	await db
		.prepare(
			"INSERT INTO urls (domain, slug, target_url, expires_at, note, folder_id) VALUES (?, ?, ?, ?, ?, ?)",
		)
		.bind(domain, slug, url, expires_at ?? null, note ?? null, folderId)
		.run();

	const row = await db
		.prepare("SELECT * FROM urls WHERE domain = ? AND slug = ?")
		.bind(domain, slug)
		.first<UrlRow>();

	return Response.json(
		{
			domain,
			slug,
			short_url: `https://${domain}/${slug}`,
			target_url: url,
			expires_at: row?.expires_at ?? null,
			folder_id: folderId,
			created_at: row?.created_at,
		},
		{ status: 201 },
	);
});

// GET /urls
app.get("/urls", async (c) => {
	const db = c.env.DB;
	const domainParam = c.req.query("domain") ?? c.get("domain");
	const page = Math.max(1, Number.parseInt(c.req.query("page") ?? "1", 10) || 1);
	const perPage = Math.min(
		100,
		Math.max(1, Number.parseInt(c.req.query("per_page") ?? "20", 10) || 20),
	);
	const status = c.req.query("status") ?? "active";
	const q = c.req.query("q");
	// 数値ならそのフォルダの直下、"none" なら未分類、省略時はフォルダで絞り込まない
	const folderParam = c.req.query("folder_id");

	const conditions: string[] = [];
	const binds: unknown[] = [];

	if (domainParam !== "all") {
		conditions.push("domain = ?");
		binds.push(domainParam);
	}

	if (status === "active") {
		conditions.push("deleted_at IS NULL AND (expires_at IS NULL OR expires_at >= datetime('now'))");
	} else if (status === "expired") {
		conditions.push(
			"deleted_at IS NULL AND expires_at IS NOT NULL AND expires_at < datetime('now')",
		);
	} else if (status === "deleted") {
		conditions.push("deleted_at IS NOT NULL");
	}
	// status=all → no filter

	if (folderParam === "none") {
		conditions.push("folder_id IS NULL");
	} else if (folderParam !== undefined) {
		if (!/^[1-9][0-9]*$/.test(folderParam)) {
			return badRequest('folder_id must be a positive integer or "none"');
		}
		conditions.push("folder_id = ?");
		binds.push(Number(folderParam));
	}

	if (q) {
		conditions.push("(slug LIKE ? OR target_url LIKE ? OR note LIKE ?)");
		const pattern = `%${q}%`;
		binds.push(pattern, pattern, pattern);
	}

	const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

	const countResult = await db
		.prepare(`SELECT COUNT(*) as count FROM urls ${whereClause}`)
		.bind(...binds)
		.first<{ count: number }>();
	const total = countResult?.count ?? 0;

	const offset = (page - 1) * perPage;
	const rows = await db
		.prepare(`SELECT * FROM urls ${whereClause} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
		.bind(...binds, perPage, offset)
		.all<UrlRow>();

	return c.json({
		data: rows.results,
		pagination: {
			page,
			per_page: perPage,
			total,
			total_pages: Math.ceil(total / perPage),
		},
	});
});

// GET /urls/:slug/stats
app.get("/urls/:slug/stats", async (c) => {
	const slug = c.req.param("slug");
	const domain = c.req.query("domain") ?? c.get("domain");
	const db = c.env.DB;

	const row = await db
		.prepare("SELECT * FROM urls WHERE domain = ? AND slug = ?")
		.bind(domain, slug)
		.first<UrlRow>();

	if (!row) {
		return notFound("URL not found");
	}

	return c.json(row);
});

// PATCH /urls/:slug
app.patch("/urls/:slug", async (c) => {
	let body: Record<string, unknown>;
	try {
		body = await c.req.json();
	} catch {
		return badRequest("Invalid JSON body");
	}

	const { target_url, expires_at, note, folder_id } = body as {
		target_url?: string;
		expires_at?: string | null;
		note?: string | null;
		folder_id?: unknown;
	};

	const sets: string[] = [];
	const binds: unknown[] = [];

	if (target_url !== undefined) {
		const validation = validateTargetUrl(target_url);
		if (!validation.valid) {
			return badRequest(validation.reason);
		}
		sets.push("target_url = ?");
		binds.push(target_url);
	}

	if (expires_at !== undefined) {
		if (expires_at !== null) {
			const parsed = Date.parse(expires_at);
			if (Number.isNaN(parsed)) {
				return badRequest("Invalid expires_at date");
			}
		}
		sets.push("expires_at = ?");
		binds.push(expires_at);
	}

	if (note !== undefined) {
		if (note !== null && note.length > 500) {
			return badRequest("Note must not exceed 500 characters");
		}
		sets.push("note = ?");
		binds.push(note);
	}

	const db = c.env.DB;

	if (folder_id !== undefined) {
		const validation = validateFolderId(folder_id);
		if (!validation.valid) {
			return badRequest(validation.reason);
		}
		if (folder_id !== null && !(await folderExists(db, folder_id as number))) {
			return badRequest(`Unknown folder: ${folder_id}`);
		}
		sets.push("folder_id = ?");
		binds.push(folder_id);
	}

	if (sets.length === 0) {
		return badRequest("No fields to update");
	}

	const slug = c.req.param("slug");
	const domain = (body as { domain?: string }).domain ?? c.get("domain");

	const result = await db
		.prepare(
			`UPDATE urls SET ${sets.join(", ")} WHERE domain = ? AND slug = ? AND deleted_at IS NULL`,
		)
		.bind(...binds, domain, slug)
		.run();

	if (result.meta.changes === 0) {
		return notFound("URL not found");
	}

	const row = await db
		.prepare("SELECT * FROM urls WHERE domain = ? AND slug = ?")
		.bind(domain, slug)
		.first<UrlRow>();

	return c.json(row);
});

// DELETE /urls/:slug
app.delete("/urls/:slug", async (c) => {
	const slug = c.req.param("slug");
	const domain = c.req.query("domain") ?? c.get("domain");
	const db = c.env.DB;

	const result = await db
		.prepare(
			"UPDATE urls SET deleted_at = datetime('now') WHERE domain = ? AND slug = ? AND deleted_at IS NULL",
		)
		.bind(domain, slug)
		.run();

	if (result.meta.changes === 0) {
		return notFound("URL not found");
	}

	return new Response(null, { status: 204 });
});

// POST /urls/:slug/restore
app.post("/urls/:slug/restore", async (c) => {
	const slug = c.req.param("slug");
	const domain = c.req.query("domain") ?? c.get("domain");
	const db = c.env.DB;

	const result = await db
		.prepare(
			"UPDATE urls SET deleted_at = NULL WHERE domain = ? AND slug = ? AND deleted_at IS NOT NULL",
		)
		.bind(domain, slug)
		.run();

	if (result.meta.changes === 0) {
		return notFound("URL not found");
	}

	return new Response(null, { status: 204 });
});

export default app;
