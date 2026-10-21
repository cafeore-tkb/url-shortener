-- Delegated DCV（DCV 委任）対応
--
-- 外部アカウントのドメイン所有者が `_acme-challenge.<hostname>` を
-- `<hostname>.<uuid>.dcv.cloudflare.com` に向ける CNAME を 1 度だけ張ると、
-- 以降の証明書更新のたびに Cloudflare が TXT トークンを自動で配置する。
-- ssl.dcv_delegation_records（CNAME レコード配列）を JSON 文字列で保存する。
ALTER TABLE domains ADD COLUMN dcv_delegation TEXT;
