-- Cloudflare for SaaS（カスタムホスト名）対応
-- 別 Cloudflare アカウント / Cloudflare 外にゾーンがある短縮ドメインを扱うためのカラム。

-- 1 = 外部アカウントのドメイン（Cloudflare for SaaS のカスタムホスト名として登録する）
ALTER TABLE domains ADD COLUMN external INTEGER NOT NULL DEFAULT 0;

-- Cloudflare Custom Hostnames API が返す ID（UUID）
ALTER TABLE domains ADD COLUMN custom_hostname_id TEXT;

-- result.status（pending / active など。ホスト名の所有権検証ステータス）
ALTER TABLE domains ADD COLUMN hostname_status TEXT;

-- result.ssl.status（pending_validation / active など。証明書のステータス）
ALTER TABLE domains ADD COLUMN ssl_status TEXT;

-- result.ownership_verification（TXT レコード）を JSON 文字列で保存
ALTER TABLE domains ADD COLUMN ownership_verification TEXT;

-- result.ssl.validation_records を JSON 文字列（配列）で保存
ALTER TABLE domains ADD COLUMN ssl_validation TEXT;

-- 最後に Cloudflare API からステータスを取得した日時（ISO 8601）
ALTER TABLE domains ADD COLUMN hostname_checked_at TEXT;
