import { Hono } from "hono";
import {
	type CloudflareSaasClient,
	CloudflareSaasError,
	type CustomHostname,
	type DnsRecord,
	type SaasConfig,
	createCloudflareSaasClient,
	delegatedDcvRecord,
	saasConfigFromEnv,
} from "../../lib/cloudflare-saas";
import { invalidate } from "../../lib/domain-cache";
import { badGateway, badRequest, conflict, notFound } from "../../lib/errors";
import {
	validateGoneColor,
	validateGoneLogoUrl,
	validateGoneMessage,
	validateGoneTitle,
} from "../../lib/validation";
import type { AppEnv, Bindings, DomainRow } from "../../types";

const app = new Hono<AppEnv>();

const SAAS_NOT_CONFIGURED =
	"Cloudflare for SaaS is not configured: set CF_SAAS_ZONE_ID (var) and CF_SAAS_API_TOKEN (secret)";

type SaasContext = { config: SaasConfig; client: CloudflareSaasClient };

function saasContext(env: Bindings): SaasContext | null {
	const config = saasConfigFromEnv(env);
	if (!config) return null;
	return { config, client: createCloudflareSaasClient(config) };
}

function parseJson<T>(raw: string | null): T | null {
	if (!raw) return null;
	try {
		return JSON.parse(raw) as T;
	} catch {
		return null;
	}
}

/** サブドメインを持たないドメイン（example.com など）か。管理画面の DNS 注意書きでも使う */
export function isApex(domain: string): boolean {
	return domain.split(".").length <= 2;
}

/**
 * 外部アカウント側の管理者が設定すべき DNS レコードと注意事項を組み立てる。
 */
function dnsInstructions(row: DomainRow, cnameTarget: string | null) {
	const records: DnsRecord[] = [];
	if (cnameTarget) {
		records.push({ type: "CNAME", name: row.domain, value: cnameTarget });
	}

	const ownership = parseJson<DnsRecord>(row.ownership_verification);
	if (ownership) records.push(ownership);

	for (const record of parseJson<DnsRecord[]>(row.ssl_validation) ?? []) {
		records.push(record);
	}

	const dcvDelegation = parseJson<DnsRecord[]>(row.dcv_delegation) ?? [];

	const notes: string[] = [];
	if (!cnameTarget) {
		notes.push("CF_SAAS_CNAME_TARGET is not set; tell the domain owner the CNAME target manually.");
	}
	if (dcvDelegation.length > 0) {
		notes.push(
			"Delegated DCV: the domain owner may create the _acme-challenge CNAME below instead of the _acme-challenge TXT record. Create only one of the two — a CNAME and a TXT record cannot coexist at the same name.",
		);
		notes.push(
			"Keep the delegation CNAME in place permanently: Cloudflare publishes a fresh DCV token behind it on every certificate renewal.",
		);
	}
	if (isApex(row.domain)) {
		notes.push(
			"Apex domains cannot use a plain CNAME. Cloudflare-hosted zones can rely on CNAME flattening; otherwise apex proxying (Enterprise) is required.",
		);
	}
	notes.push(
		"If the zone is on Cloudflare, the CNAME record may be proxied (orange-to-orange) or DNS-only; both activate the custom hostname.",
	);

	return { cname_target: cnameTarget, records, dcv_delegation_records: dcvDelegation, notes };
}

function domainResponse(row: DomainRow, cnameTarget: string | null) {
	const external = Boolean(row.external);
	return {
		...row,
		external,
		dns_instructions: external ? dnsInstructions(row, cnameTarget) : null,
	};
}

/** /api/domains 系エンドポイントが返すドメイン 1 件分の JSON */
export type DomainResponse = ReturnType<typeof domainResponse>;

/**
 * カスタムホスト名のステータス列（custom_hostname_id 〜 hostname_checked_at）の
 * SET 句とバインド値を組み立てる。hostname が null なら全列をクリアする。
 */
function hostnameColumns(hostname: CustomHostname | null): { sets: string[]; binds: unknown[] } {
	const sets = [
		"custom_hostname_id = ?",
		"hostname_status = ?",
		"ssl_status = ?",
		"ownership_verification = ?",
		"ssl_validation = ?",
		"dcv_delegation = ?",
		"hostname_checked_at = ?",
	];
	if (!hostname) {
		return { sets, binds: [null, null, null, null, null, null, null] };
	}
	return {
		sets,
		binds: [
			hostname.id,
			hostname.status,
			hostname.sslStatus,
			hostname.ownershipVerification ? JSON.stringify(hostname.ownershipVerification) : null,
			hostname.sslValidation.length > 0 ? JSON.stringify(hostname.sslValidation) : null,
			hostname.dcvDelegation.length > 0 ? JSON.stringify(hostname.dcvDelegation) : null,
			new Date().toISOString(),
		],
	};
}

/**
 * Delegated DCV 用の CNAME レコードを補完する。
 *
 * Cloudflare が `ssl.dcv_delegation_records` を返していればそれをそのまま使う。
 * 返っていない場合（このフィールドは DCV トークンと同じく非同期に生成されるため、
 * 登録直後は空のことがある）はゾーンの DCV Delegation UUID から組み立てる。
 * UUID はゾーン単位で固定なので、カスタムホスト名ごとに取り直す必要はない。
 *
 * この補完はベストエフォート。取得に失敗しても TXT DCV で証明書は発行できるため、
 * カスタムホスト名の登録・ステータス更新自体は成功させる。
 */
async function withDcvDelegation(
	client: CloudflareSaasClient,
	domain: string,
	hostname: CustomHostname,
): Promise<CustomHostname> {
	if (hostname.dcvDelegation.length > 0) {
		return hostname;
	}
	let uuid: string | null;
	try {
		uuid = await client.dcvDelegationUuid();
	} catch {
		return hostname;
	}
	if (!uuid) {
		return hostname;
	}
	return {
		...hostname,
		dcvDelegation: [delegatedDcvRecord(hostname.hostname || domain, uuid)],
	};
}

async function persistHostname(
	db: D1Database,
	domain: string,
	hostname: CustomHostname,
): Promise<void> {
	const cols = hostnameColumns(hostname);
	await db
		.prepare(`UPDATE domains SET ${cols.sets.join(", ")} WHERE domain = ?`)
		.bind(...cols.binds, domain)
		.run();
}

// GET /domains
app.get("/domains", async (c) => {
	const db = c.env.DB;
	const rows = await db
		.prepare("SELECT * FROM domains ORDER BY created_at ASC")
		.bind()
		.all<DomainRow>();
	const cnameTarget = saasConfigFromEnv(c.env)?.cnameTarget ?? null;
	return c.json({ data: (rows.results ?? []).map((row) => domainResponse(row, cnameTarget)) });
});

// POST /domains
app.post("/domains", async (c) => {
	let body: Record<string, unknown>;
	try {
		body = await c.req.json();
	} catch {
		return badRequest("Invalid JSON body");
	}

	const { domain, name, gone_title, gone_message, gone_color, gone_logo_url, external } = body as {
		domain?: string;
		name?: string;
		gone_title?: string;
		gone_message?: string;
		gone_color?: string;
		gone_logo_url?: string | null;
		external?: boolean;
	};

	if (!domain) {
		return badRequest("Missing required field: domain");
	}
	if (!name) {
		return badRequest("Missing required field: name");
	}

	if (gone_title !== undefined) {
		const v = validateGoneTitle(gone_title);
		if (!v.valid) return badRequest(v.reason);
	}
	if (gone_message !== undefined) {
		const v = validateGoneMessage(gone_message);
		if (!v.valid) return badRequest(v.reason);
	}
	if (gone_color !== undefined) {
		const v = validateGoneColor(gone_color);
		if (!v.valid) return badRequest(v.reason);
	}
	if (gone_logo_url !== undefined) {
		const v = validateGoneLogoUrl(gone_logo_url ?? null);
		if (!v.valid) return badRequest(v.reason);
	}

	// external ドメインは Cloudflare for SaaS の設定が必須。行を作る前に検証する。
	let saas: SaasContext | null = null;
	if (external) {
		saas = saasContext(c.env);
		if (!saas) {
			return badRequest(SAAS_NOT_CONFIGURED);
		}
	}

	const db = c.env.DB;

	try {
		await db
			.prepare(
				"INSERT INTO domains (domain, name, gone_title, gone_message, gone_color, gone_logo_url, external) VALUES (?, ?, ?, ?, ?, ?, ?)",
			)
			.bind(
				domain,
				name,
				gone_title ?? "Link Removed",
				gone_message ?? "This link is no longer available.",
				gone_color ?? "#6366F1",
				gone_logo_url ?? null,
				external ? 1 : 0,
			)
			.run();
	} catch (e: unknown) {
		if (e instanceof Error && e.message.includes("UNIQUE")) {
			return conflict("Domain already exists");
		}
		throw e;
	}

	if (saas) {
		try {
			const created = await saas.client.create(domain);
			const hostname = await withDcvDelegation(saas.client, domain, created);
			await persistHostname(db, domain, hostname);
		} catch (e: unknown) {
			// カスタムホスト名を作れなかった場合は行を残さない（孤児レコードを避ける）。
			await db.prepare("DELETE FROM domains WHERE domain = ?").bind(domain).run();
			invalidate(domain);
			if (e instanceof CloudflareSaasError) {
				return badGateway(e.message);
			}
			throw e;
		}
	}

	const row = await db
		.prepare("SELECT * FROM domains WHERE domain = ?")
		.bind(domain)
		.first<DomainRow>();

	return Response.json(row ? domainResponse(row, saas?.config.cnameTarget ?? null) : null, {
		status: 201,
	});
});

// GET /domains/:domain/hostname — Cloudflare からステータスを再取得して D1 を更新する
app.get("/domains/:domain/hostname", async (c) => {
	const domain = c.req.param("domain");
	const db = c.env.DB;

	const row = await db
		.prepare("SELECT * FROM domains WHERE domain = ?")
		.bind(domain)
		.first<DomainRow>();

	if (!row) {
		return notFound("Domain not found");
	}
	if (!row.custom_hostname_id) {
		return badRequest("Domain is not registered as a Cloudflare for SaaS custom hostname");
	}

	const saas = saasContext(c.env);
	if (!saas) {
		return badRequest(SAAS_NOT_CONFIGURED);
	}

	let fetched: CustomHostname | null;
	try {
		fetched = await saas.client.get(row.custom_hostname_id);
	} catch (e: unknown) {
		if (e instanceof CloudflareSaasError) {
			return badGateway(e.message);
		}
		throw e;
	}

	if (!fetched) {
		return notFound("Custom hostname not found on Cloudflare");
	}

	const hostname = await withDcvDelegation(saas.client, domain, fetched);
	await persistHostname(db, domain, hostname);
	invalidate(domain);

	const updated = await db
		.prepare("SELECT * FROM domains WHERE domain = ?")
		.bind(domain)
		.first<DomainRow>();

	return c.json({
		...domainResponse((updated ?? row) as DomainRow, saas.config.cnameTarget),
		verification_errors: hostname.verificationErrors,
	});
});

// PATCH /domains/:domain
app.patch("/domains/:domain", async (c) => {
	let body: Record<string, unknown>;
	try {
		body = await c.req.json();
	} catch {
		return badRequest("Invalid JSON body");
	}

	const { name, gone_title, gone_message, gone_color, gone_logo_url, external } = body as {
		name?: string;
		gone_title?: string;
		gone_message?: string;
		gone_color?: string;
		gone_logo_url?: string | null;
		external?: boolean;
	};

	const sets: string[] = [];
	const binds: unknown[] = [];

	if (name !== undefined) {
		sets.push("name = ?");
		binds.push(name);
	}

	if (gone_title !== undefined) {
		const v = validateGoneTitle(gone_title);
		if (!v.valid) return badRequest(v.reason);
		sets.push("gone_title = ?");
		binds.push(gone_title);
	}

	if (gone_message !== undefined) {
		const v = validateGoneMessage(gone_message);
		if (!v.valid) return badRequest(v.reason);
		sets.push("gone_message = ?");
		binds.push(gone_message);
	}

	if (gone_color !== undefined) {
		const v = validateGoneColor(gone_color);
		if (!v.valid) return badRequest(v.reason);
		sets.push("gone_color = ?");
		binds.push(gone_color);
	}

	if (gone_logo_url !== undefined) {
		if (gone_logo_url !== null) {
			const v = validateGoneLogoUrl(gone_logo_url);
			if (!v.valid) return badRequest(v.reason);
		}
		sets.push("gone_logo_url = ?");
		binds.push(gone_logo_url);
	}

	if (external !== undefined && typeof external !== "boolean") {
		return badRequest("external must be a boolean");
	}

	if (sets.length === 0 && external === undefined) {
		return badRequest("No fields to update");
	}

	const domain = c.req.param("domain");
	const db = c.env.DB;

	// external の切り替えは Cloudflare 側の操作（カスタムホスト名の登録 / 削除）を伴うため、
	// 現在の行を読んで差分があるときだけ実行する。Cloudflare 側が失敗したら D1 は変更しない。
	if (external !== undefined) {
		const current = await db
			.prepare("SELECT * FROM domains WHERE domain = ?")
			.bind(domain)
			.first<DomainRow>();
		if (!current) {
			return notFound("Domain not found");
		}

		const currentlyExternal = Boolean(current.external);

		if (external && (!currentlyExternal || !current.custom_hostname_id)) {
			// 既存ドメインを external にする: カスタムホスト名を新規登録する
			const saas = saasContext(c.env);
			if (!saas) {
				return badRequest(SAAS_NOT_CONFIGURED);
			}
			let created: CustomHostname;
			try {
				created = await saas.client.create(domain);
			} catch (e: unknown) {
				if (e instanceof CloudflareSaasError) {
					return badGateway(e.message);
				}
				throw e;
			}
			const hostname = await withDcvDelegation(saas.client, domain, created);
			const cols = hostnameColumns(hostname);
			sets.push("external = ?", ...cols.sets);
			binds.push(1, ...cols.binds);
		} else if (!external && currentlyExternal) {
			// external を解除する: カスタムホスト名を削除してから D1 の列をクリアする。
			// Cloudflare 側に課金対象のホスト名を残さないよう、削除に失敗したら切り替えない。
			if (current.custom_hostname_id) {
				const saas = saasContext(c.env);
				if (!saas) {
					return badRequest(SAAS_NOT_CONFIGURED);
				}
				try {
					await saas.client.delete(current.custom_hostname_id);
				} catch (e: unknown) {
					if (e instanceof CloudflareSaasError) {
						return badGateway(e.message);
					}
					throw e;
				}
			}
			const cols = hostnameColumns(null);
			sets.push("external = ?", ...cols.sets);
			binds.push(0, ...cols.binds);
		}
		// 現在の状態と同じなら何もしない
	}

	const cnameTarget = saasConfigFromEnv(c.env)?.cnameTarget ?? null;

	if (sets.length === 0) {
		// external が指定されたが変更なし、かつ他の更新も無い場合はそのまま返す
		const row = await db
			.prepare("SELECT * FROM domains WHERE domain = ?")
			.bind(domain)
			.first<DomainRow>();
		return c.json(row ? domainResponse(row, cnameTarget) : null);
	}

	const result = await db
		.prepare(`UPDATE domains SET ${sets.join(", ")} WHERE domain = ?`)
		.bind(...binds, domain)
		.run();

	if (result.meta.changes === 0) {
		return notFound("Domain not found");
	}

	invalidate(domain);

	const row = await db
		.prepare("SELECT * FROM domains WHERE domain = ?")
		.bind(domain)
		.first<DomainRow>();

	return c.json(row ? domainResponse(row, cnameTarget) : null);
});

// DELETE /domains/:domain
app.delete("/domains/:domain", async (c) => {
	const domain = c.req.param("domain");
	const db = c.env.DB;

	const urlExists = await db
		.prepare("SELECT 1 FROM urls WHERE domain = ? LIMIT 1")
		.bind(domain)
		.first();

	if (urlExists) {
		return conflict("Cannot delete domain with existing URLs");
	}

	const existing = await db
		.prepare("SELECT * FROM domains WHERE domain = ?")
		.bind(domain)
		.first<DomainRow>();

	const result = await db.prepare("DELETE FROM domains WHERE domain = ?").bind(domain).run();

	if (result.meta.changes === 0) {
		return notFound("Domain not found");
	}

	invalidate(domain);

	// カスタムホスト名の削除はベストエフォート（失敗してもドメイン削除は成功扱い）。
	if (existing?.custom_hostname_id) {
		const saas = saasContext(c.env);
		if (saas) {
			try {
				await saas.client.delete(existing.custom_hostname_id);
			} catch {
				// Cloudflare 側に残っても D1 の削除は完了しているため無視する。
			}
		}
	}

	return new Response(null, { status: 204 });
});

export default app;
