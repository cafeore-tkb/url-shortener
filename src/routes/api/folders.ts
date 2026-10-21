import { Hono } from "hono";
import { badRequest, conflict, notFound } from "../../lib/errors";
import { SUBTREE_CTE, folderExists } from "../../lib/folders";
import { validateFolderId, validateFolderName } from "../../lib/validation";
import type { AppEnv, FolderRow } from "../../types";

const app = new Hono<AppEnv>();

/** API が返すフォルダ。url_count は直下にある削除されていない URL の数（サブフォルダ分は含まない） */
export type FolderResponse = FolderRow & { url_count: number };

const MOVE_INTO_SUBTREE_ERROR = "Cannot move a folder into itself or its subfolders";

const SELECT_FOLDER = `SELECT f.*,
  (SELECT COUNT(*) FROM urls u WHERE u.folder_id = f.id AND u.deleted_at IS NULL) AS url_count
FROM folders f`;

function parseId(raw: string): number | null {
	return /^[1-9][0-9]*$/.test(raw) ? Number(raw) : null;
}

async function getFolder(db: D1Database, id: number): Promise<FolderResponse | null> {
	return db.prepare(`${SELECT_FOLDER} WHERE f.id = ?`).bind(id).first<FolderResponse>();
}

/** 同じ親の下に同名のフォルダがあるか（excludeId は自分自身を除外するため） */
async function siblingNameTaken(
	db: D1Database,
	parentId: number | null,
	name: string,
	excludeId: number | null = null,
): Promise<boolean> {
	const row = await db
		.prepare(
			"SELECT 1 FROM folders WHERE COALESCE(parent_id, 0) = COALESCE(?, 0) AND name = ? AND id IS NOT ?",
		)
		.bind(parentId, name, excludeId)
		.first();
	return row !== null;
}

// GET /folders
app.get("/folders", async (c) => {
	const db = c.env.DB;
	const rows = await db.prepare(`${SELECT_FOLDER} ORDER BY f.name, f.id`).all<FolderResponse>();
	return c.json({ data: rows.results });
});

// POST /folders
app.post("/folders", async (c) => {
	let body: Record<string, unknown>;
	try {
		body = await c.req.json();
	} catch {
		return badRequest("Invalid JSON body");
	}

	const { name, parent_id = null } = body as { name?: unknown; parent_id?: unknown };

	const nameValidation = validateFolderName(name);
	if (!nameValidation.valid) {
		return badRequest(nameValidation.reason);
	}
	const parentValidation = validateFolderId(parent_id, "parent_id");
	if (!parentValidation.valid) {
		return badRequest(parentValidation.reason);
	}

	const db = c.env.DB;
	const trimmed = (name as string).trim();
	const parentId = parent_id as number | null;

	if (parentId !== null && !(await folderExists(db, parentId))) {
		return badRequest(`Unknown parent folder: ${parentId}`);
	}
	if (await siblingNameTaken(db, parentId, trimmed)) {
		return conflict("A folder with the same name already exists here");
	}

	const inserted = await db
		.prepare("INSERT INTO folders (name, parent_id) VALUES (?, ?) RETURNING id")
		.bind(trimmed, parentId)
		.first<{ id: number }>();

	const folder = await getFolder(db, inserted?.id ?? 0);
	return c.json(folder, 201);
});

// GET /folders/:id
app.get("/folders/:id", async (c) => {
	const id = parseId(c.req.param("id"));
	const folder = id === null ? null : await getFolder(c.env.DB, id);
	if (!folder) {
		return notFound("Folder not found");
	}
	return c.json(folder);
});

// PATCH /folders/:id（名前の変更・別の親への移動）
app.patch("/folders/:id", async (c) => {
	let body: Record<string, unknown>;
	try {
		body = await c.req.json();
	} catch {
		return badRequest("Invalid JSON body");
	}

	const { name, parent_id } = body as { name?: unknown; parent_id?: unknown };

	if (name === undefined && parent_id === undefined) {
		return badRequest("No fields to update");
	}
	if (name !== undefined) {
		const validation = validateFolderName(name);
		if (!validation.valid) {
			return badRequest(validation.reason);
		}
	}
	if (parent_id !== undefined) {
		const validation = validateFolderId(parent_id, "parent_id");
		if (!validation.valid) {
			return badRequest(validation.reason);
		}
	}

	const db = c.env.DB;
	const id = parseId(c.req.param("id"));
	const current =
		id === null
			? null
			: await db.prepare("SELECT * FROM folders WHERE id = ?").bind(id).first<FolderRow>();
	if (!current) {
		return notFound("Folder not found");
	}

	const newName = name === undefined ? current.name : (name as string).trim();
	const newParentId = parent_id === undefined ? current.parent_id : (parent_id as number | null);

	if (newParentId !== null && newParentId !== current.parent_id) {
		const subtree = await db
			.prepare(`${SUBTREE_CTE} SELECT 1 FROM subtree WHERE id = ?`)
			.bind(current.id, newParentId)
			.first();
		if (subtree) {
			return badRequest(MOVE_INTO_SUBTREE_ERROR);
		}
		if (!(await folderExists(db, newParentId))) {
			return badRequest(`Unknown parent folder: ${newParentId}`);
		}
	}
	if (await siblingNameTaken(db, newParentId, newName, current.id)) {
		return conflict("A folder with the same name already exists here");
	}

	// 移動先が子孫でないことを UPDATE の条件でも確かめる。上の確認だけだと、A→B と B→A の移動が
	// 同時に来たときに両方が確認を通って循環ができる。1 つの文の中の確認と更新は SQLite が不可分に行う。
	const updated = await db
		.prepare(
			`${SUBTREE_CTE} UPDATE folders SET name = ?, parent_id = ? WHERE id = ? AND (? IS NULL OR ? NOT IN subtree)`,
		)
		.bind(current.id, newName, newParentId, current.id, newParentId, newParentId)
		.run();
	if (updated.meta.changes === 0) {
		return (await folderExists(db, current.id))
			? badRequest(MOVE_INTO_SUBTREE_ERROR)
			: notFound("Folder not found");
	}

	return c.json(await getFolder(db, current.id));
});

// DELETE /folders/:id
// サブフォルダもまとめて削除する。中の URL は削除せず未分類（folder_id = NULL）に戻す。
app.delete("/folders/:id", async (c) => {
	const db = c.env.DB;
	const id = parseId(c.req.param("id"));
	if (id === null || !(await folderExists(db, id))) {
		return notFound("Folder not found");
	}

	await db.batch([
		db
			.prepare(`${SUBTREE_CTE} UPDATE urls SET folder_id = NULL WHERE folder_id IN subtree`)
			.bind(id),
		db.prepare(`${SUBTREE_CTE} DELETE FROM folders WHERE id IN subtree`).bind(id),
	]);

	return new Response(null, { status: 204 });
});

export default app;
