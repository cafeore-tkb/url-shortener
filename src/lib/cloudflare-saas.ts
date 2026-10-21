/**
 * Cloudflare for SaaS (Custom Hostnames) API クライアント。
 *
 * 別の Cloudflare アカウント（あるいは Cloudflare 外）にゾーンがある短縮ドメインを
 * この Worker で配信するために、SaaS ゾーンへカスタムホスト名を登録する。
 *
 * API リファレンス:
 * https://developers.cloudflare.com/api/resources/custom_hostnames/methods/create/
 */

const API_BASE = "https://api.cloudflare.com/client/v4";

/** Delegated DCV の委任先ドメイン。CNAME ターゲットは <hostname>.<uuid>.dcv.cloudflare.com になる */
const DCV_DELEGATION_SUFFIX = "dcv.cloudflare.com";

export type SaasConfig = {
	zoneId: string;
	apiToken: string;
	/** 外部アカウント側が CNAME を向ける先（fallback origin / CNAME target） */
	cnameTarget: string | null;
};

export type DnsRecord = {
	type: "CNAME" | "TXT";
	name: string;
	value: string;
};

export type CustomHostname = {
	id: string;
	hostname: string;
	/** ホスト名の所有権検証ステータス（active になると Cloudflare がトラフィックを流せる） */
	status: string;
	/** 証明書のステータス（active になると TLS 証明書が配備済み） */
	sslStatus: string | null;
	/** 所有権確認用 TXT レコード（_cf-custom-hostname.<hostname>） */
	ownershipVerification: DnsRecord | null;
	/** 証明書 DCV 用 TXT レコード（_acme-challenge.<hostname>） */
	sslValidation: DnsRecord[];
	/**
	 * Delegated DCV 用の CNAME レコード（_acme-challenge.<hostname> → <hostname>.<uuid>.dcv.cloudflare.com）。
	 * これを 1 度だけ張ってもらえば、以降の更新時に Cloudflare が TXT トークンを自動で配置する。
	 */
	dcvDelegation: DnsRecord[];
	verificationErrors: string[];
};

export interface CloudflareSaasClient {
	/** カスタムホスト名を新規登録する（ssl.method = "txt", ssl.type = "dv", wildcard = false） */
	create(hostname: string): Promise<CustomHostname>;
	/** 現在のステータスを取得する。存在しない場合は null */
	get(customHostnameId: string): Promise<CustomHostname | null>;
	/** カスタムホスト名を削除する。既に存在しない場合は false */
	delete(customHostnameId: string): Promise<boolean>;
	/**
	 * ゾーンの DCV Delegation UUID を取得する。
	 * ゾーン単位で固定の値で、Delegated DCV 用 CNAME のターゲットに使う。
	 * ゾーンで利用できない場合は null。
	 */
	dcvDelegationUuid(): Promise<string | null>;
}

/**
 * Delegated DCV 用の CNAME レコードを組み立てる。
 *
 * ドメイン所有者が `_acme-challenge.<hostname>` をこのターゲットに向けると、
 * 証明書の発行・更新のたびに Cloudflare が委任先へ TXT トークンを配置する。
 * https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/security/certificate-management/issue-and-validate/validate-certificates/delegated-dcv/
 */
export function delegatedDcvRecord(hostname: string, uuid: string): DnsRecord {
	return {
		type: "CNAME",
		name: `_acme-challenge.${hostname}`,
		value: `${hostname}.${uuid}.${DCV_DELEGATION_SUFFIX}`,
	};
}

export class CloudflareSaasError extends Error {
	readonly httpStatus: number;
	readonly apiErrors: string[];

	constructor(message: string, httpStatus: number, apiErrors: string[] = []) {
		super(message);
		this.name = "CloudflareSaasError";
		this.httpStatus = httpStatus;
		this.apiErrors = apiErrors;
	}
}

type EnvLike = {
	CF_SAAS_ZONE_ID?: string;
	CF_SAAS_API_TOKEN?: string;
	CF_SAAS_CNAME_TARGET?: string;
};

/**
 * 環境変数から SaaS 設定を組み立てる。
 * CF_SAAS_ZONE_ID / CF_SAAS_API_TOKEN のどちらかが無ければ null を返す（= SaaS 連携は無効）。
 */
export function saasConfigFromEnv(env: EnvLike): SaasConfig | null {
	const zoneId = env.CF_SAAS_ZONE_ID?.trim();
	const apiToken = env.CF_SAAS_API_TOKEN?.trim();
	if (!zoneId || !apiToken) {
		return null;
	}
	return {
		zoneId,
		apiToken,
		cnameTarget: env.CF_SAAS_CNAME_TARGET?.trim() || null,
	};
}

type ApiEnvelope<T> = {
	success?: boolean;
	result?: T;
	errors?: Array<{ code?: number; message?: string }>;
};

type ApiCustomHostname = {
	id?: string;
	hostname?: string;
	status?: string;
	verification_errors?: string[];
	ownership_verification?: { type?: string; name?: string; value?: string };
	ssl?: {
		status?: string;
		validation_records?: Array<{ txt_name?: string; txt_value?: string }>;
		dcv_delegation_records?: Array<{ cname?: string; cname_target?: string }>;
	};
};

type ApiDcvDelegation = {
	uuid?: string;
};

function normalize(result: ApiCustomHostname): CustomHostname {
	const ov = result.ownership_verification;
	const ownershipVerification: DnsRecord | null =
		ov?.name && ov?.value ? { type: "TXT", name: ov.name, value: ov.value } : null;

	const sslValidation: DnsRecord[] = [];
	for (const record of result.ssl?.validation_records ?? []) {
		if (record.txt_name && record.txt_value) {
			sslValidation.push({ type: "TXT", name: record.txt_name, value: record.txt_value });
		}
	}

	const dcvDelegation: DnsRecord[] = [];
	for (const record of result.ssl?.dcv_delegation_records ?? []) {
		if (record.cname && record.cname_target) {
			dcvDelegation.push({ type: "CNAME", name: record.cname, value: record.cname_target });
		}
	}

	return {
		id: result.id ?? "",
		hostname: result.hostname ?? "",
		status: result.status ?? "unknown",
		sslStatus: result.ssl?.status ?? null,
		ownershipVerification,
		sslValidation,
		dcvDelegation,
		verificationErrors: result.verification_errors ?? [],
	};
}

/**
 * Cloudflare for SaaS クライアントを生成する。
 * fetchImpl を差し替えることでテストからモックできる。
 */
export function createCloudflareSaasClient(
	config: SaasConfig,
	fetchImpl: typeof fetch = (input, init) => globalThis.fetch(input, init),
): CloudflareSaasClient {
	const zoneBase = `${API_BASE}/zones/${config.zoneId}`;
	const base = `${zoneBase}/custom_hostnames`;

	async function call<T>(
		method: string,
		url: string,
		body?: unknown,
	): Promise<{ status: number; envelope: ApiEnvelope<T> }> {
		const init: RequestInit = {
			method,
			headers: {
				Authorization: `Bearer ${config.apiToken}`,
				"Content-Type": "application/json",
			},
		};
		if (body !== undefined) {
			init.body = JSON.stringify(body);
		}

		let res: Response;
		try {
			res = await fetchImpl(url, init);
		} catch (e) {
			const reason = e instanceof Error ? e.message : String(e);
			throw new CloudflareSaasError(`Cloudflare API request failed: ${reason}`, 502);
		}

		let envelope: ApiEnvelope<T> = {};
		try {
			envelope = (await res.json()) as ApiEnvelope<T>;
		} catch {
			if (res.ok) {
				throw new CloudflareSaasError("Cloudflare API returned a non-JSON response", 502);
			}
		}

		return { status: res.status, envelope };
	}

	function fail(action: string, status: number, envelope: ApiEnvelope<unknown>): never {
		const apiErrors = (envelope.errors ?? [])
			.map((e) => e.message)
			.filter((m): m is string => Boolean(m));
		const detail = apiErrors.length > 0 ? apiErrors.join("; ") : `HTTP ${status}`;
		throw new CloudflareSaasError(`${action} failed: ${detail}`, status, apiErrors);
	}

	return {
		async create(hostname: string): Promise<CustomHostname> {
			const { status, envelope } = await call<ApiCustomHostname>("POST", base, {
				hostname,
				ssl: {
					method: "txt",
					type: "dv",
					wildcard: false,
					settings: { min_tls_version: "1.2" },
				},
			});

			if (!envelope.success || !envelope.result) {
				fail("Custom hostname creation", status, envelope);
			}
			return normalize(envelope.result);
		},

		async get(customHostnameId: string): Promise<CustomHostname | null> {
			const { status, envelope } = await call<ApiCustomHostname>(
				"GET",
				`${base}/${encodeURIComponent(customHostnameId)}`,
			);
			if (status === 404) {
				return null;
			}
			if (!envelope.success || !envelope.result) {
				fail("Custom hostname lookup", status, envelope);
			}
			return normalize(envelope.result);
		},

		async delete(customHostnameId: string): Promise<boolean> {
			const { status, envelope } = await call<ApiCustomHostname>(
				"DELETE",
				`${base}/${encodeURIComponent(customHostnameId)}`,
			);
			if (status === 404) {
				return false;
			}
			if (status >= 400) {
				fail("Custom hostname deletion", status, envelope);
			}
			return true;
		},

		async dcvDelegationUuid(): Promise<string | null> {
			const { status, envelope } = await call<ApiDcvDelegation>(
				"GET",
				`${zoneBase}/dcv_delegation/uuid`,
			);
			if (status === 404) {
				return null;
			}
			if (!envelope.success || !envelope.result) {
				fail("DCV delegation lookup", status, envelope);
			}
			return envelope.result.uuid ?? null;
		},
	};
}
