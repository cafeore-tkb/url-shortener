/**
 * `subtree(id)` に、バインドした ID のフォルダ自身とその子孫すべての ID を入れる CTE。
 * `${SUBTREE_CTE} SELECT id FROM subtree` のように文の先頭に付けて使う。
 * UNION（UNION ALL ではなく）にしているのは、parent_id が循環していても再帰を止めるため。
 */
export const SUBTREE_CTE = `WITH RECURSIVE subtree(id) AS (
  SELECT id FROM folders WHERE id = ?
  UNION
  SELECT f.id FROM folders f JOIN subtree s ON f.parent_id = s.id
)`;

export async function folderExists(db: D1Database, id: number): Promise<boolean> {
	const row = await db.prepare("SELECT 1 FROM folders WHERE id = ?").bind(id).first();
	return row !== null;
}
