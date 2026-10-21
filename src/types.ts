export type Bindings = {
	DB: D1Database;
	TEAM_DOMAIN: string;
	POLICY_AUD: string;
	MAIN_DOMAIN: string;
	DEV_AUTH_BYPASS?: string;
	/** Cloudflare for SaaS を有効にしたゾーンの Zone ID（未設定なら SaaS 連携は無効） */
	CF_SAAS_ZONE_ID?: string;
	/** SSL and Certificates: Edit 権限を持つ API トークン（wrangler secret put CF_SAAS_API_TOKEN） */
	CF_SAAS_API_TOKEN?: string;
	/** 外部アカウント側が CNAME を向ける先（例: customers.example.net） */
	CF_SAAS_CNAME_TARGET?: string;
};

export type DomainRow = {
	domain: string;
	name: string;
	gone_title: string;
	gone_message: string;
	gone_color: string;
	gone_logo_url: string | null;
	created_at: string;
	/** 1 = 別 Cloudflare アカウント / Cloudflare 外のドメイン（カスタムホスト名として登録） */
	external: number;
	custom_hostname_id: string | null;
	hostname_status: string | null;
	ssl_status: string | null;
	/** ownership_verification（TXT レコード）の JSON 文字列 */
	ownership_verification: string | null;
	/** ssl.validation_records（TXT レコード配列）の JSON 文字列 */
	ssl_validation: string | null;
	/** ssl.dcv_delegation_records（Delegated DCV 用 CNAME レコード配列）の JSON 文字列 */
	dcv_delegation: string | null;
	hostname_checked_at: string | null;
};

export type UrlRow = {
	domain: string;
	slug: string;
	target_url: string;
	expires_at: string | null;
	clicks: number;
	created_at: string;
	deleted_at: string | null;
	note: string | null;
	/** 所属フォルダ（NULL = 未分類） */
	folder_id: number | null;
};

export type FolderRow = {
	id: number;
	name: string;
	/** 親フォルダ（NULL = トップレベル） */
	parent_id: number | null;
	created_at: string;
};

export type Variables = {
	domain: string;
	domainConfig: DomainRow;
	email: string;
};

export type AppEnv = {
	Bindings: Bindings;
	Variables: Variables;
};
