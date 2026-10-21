-- フォルダ機能
--
-- フォルダはドメインに依存せず、1 つのフォルダに複数ドメインの URL を入れられる。
-- parent_id で入れ子にでき、NULL ならトップレベル。URL は 0〜1 個のフォルダに属する。
CREATE TABLE folders (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  parent_id  INTEGER REFERENCES folders(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 同じ親の下で同名のフォルダを作らせない（トップレベル同士も含む）
CREATE UNIQUE INDEX idx_folders_sibling_name ON folders(COALESCE(parent_id, 0), name);

-- NULL = 未分類
ALTER TABLE urls ADD COLUMN folder_id INTEGER REFERENCES folders(id);

CREATE INDEX idx_urls_folder ON urls(folder_id) WHERE folder_id IS NOT NULL;
