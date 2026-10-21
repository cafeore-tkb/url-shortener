-- domains テーブル
CREATE TABLE domains (
  domain       TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  gone_title   TEXT NOT NULL DEFAULT '期限切れ',
  gone_message TEXT NOT NULL DEFAULT 'このリンクは有効期限が切れています。',
  gone_color   TEXT NOT NULL DEFAULT '#1B3A5C',
  gone_logo_url TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- urls テーブル
CREATE TABLE urls (
  domain     TEXT NOT NULL,
  slug       TEXT NOT NULL,
  target_url TEXT NOT NULL,
  expires_at TEXT,
  clicks     INTEGER DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT,
  note       TEXT,
  PRIMARY KEY (domain, slug),
  FOREIGN KEY (domain) REFERENCES domains(domain)
);

-- 期限切れクリーンアップ用の部分インデックス
CREATE INDEX idx_expires_active ON urls(expires_at)
  WHERE expires_at IS NOT NULL AND deleted_at IS NULL;

-- ドメイン別アクティブ URL 一覧取得用
CREATE INDEX idx_domain_active ON urls(domain, created_at)
  WHERE deleted_at IS NULL;
