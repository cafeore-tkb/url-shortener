import { WorkerEntrypoint } from "cloudflare:workers";
import { createMiddleware } from "hono/factory";
import { type ApiRequestOptions, type ApiResult, callApi, createApiApp } from "./internal-api";
import type { DomainResponse } from "./routes/api/domains";
import type { FolderResponse } from "./routes/api/folders";
import type { AppEnv, Bindings, UrlRow } from "./types";

/**
 * Service Binding 経由の呼び出しで `email` に入れる値。
 * Cloudflare Access のユーザー（メールアドレス）と区別できるようにする。
 */
export const SERVICE_BINDING_PRINCIPAL = "service-binding";

const servicePrincipal = createMiddleware<AppEnv>(async (c, next) => {
	c.set("email", SERVICE_BINDING_PRINCIPAL);
	return next();
});

/**
 * Service Binding 用の Hono アプリ。公開アプリ（src/index.ts）と同じ /api/* のハンドラーを
 * マウントし、Cloudflare Access の JWT 検証の代わりに servicePrincipal を通す。
 *
 * 名前付きエントリポイントはインターネットから到達できず、同じアカウントで binding を
 * 宣言した Worker からしか呼べないため、binding の宣言そのものを認可として扱う。
 * /admin とリダイレクト（/:slug）は公開しない。
 */
const serviceApp = createApiApp(servicePrincipal);

/**
 * domainMiddleware は Host ヘッダーでドメインを判定する。Service Binding の fetch では
 * 呼び出し元が Host を付けないことがあるため、無ければ URL のホストで補う。
 */
function withHostHeader(request: Request): Request {
	if (request.headers.has("Host")) {
		return request;
	}
	const headers = new Headers(request.headers);
	headers.set("Host", new URL(request.url).host);
	return new Request(request, { headers });
}

/** RPC メソッドの戻り値。REST API の HTTP ステータスと JSON ボディをそのまま運ぶ（詳細は ApiResult） */
export type ServiceResult<T> = ApiResult<T>;

/** URL 系メソッドの対象ドメイン。省略時は MAIN_DOMAIN（REST API の Host ヘッダーに相当） */
export type DomainOption = { domain?: string };

export type ShortenInput = {
	url: string;
	slug?: string;
	expires_at?: string;
	note?: string;
	domain?: string;
	folder_id?: number | null;
};

export type ShortenedUrl = {
	domain: string;
	slug: string;
	short_url: string;
	target_url: string;
	expires_at: string | null;
	folder_id: number | null;
	created_at: string;
};

export type ListUrlsInput = {
	/** "all" で全ドメイン */
	domain?: string;
	status?: "active" | "expired" | "deleted" | "all";
	q?: string;
	/** フォルダ ID でそのフォルダの直下、"none" で未分類のみ */
	folder_id?: number | "none";
	page?: number;
	per_page?: number;
};

export type UrlList = {
	data: UrlRow[];
	pagination: { page: number; per_page: number; total: number; total_pages: number };
};

export type UpdateUrlInput = {
	target_url?: string;
	expires_at?: string | null;
	note?: string | null;
	folder_id?: number | null;
};

export type CreateDomainInput = {
	domain: string;
	name: string;
	gone_title?: string;
	gone_message?: string;
	gone_color?: string;
	gone_logo_url?: string | null;
	external?: boolean;
};

export type UpdateDomainInput = Partial<Omit<CreateDomainInput, "domain">>;

export type DomainHostnameStatus = DomainResponse & { verification_errors: string[] };

export type CreateFolderInput = {
	name: string;
	/** 省略または null でトップレベル */
	parent_id?: number | null;
};

export type UpdateFolderInput = Partial<CreateFolderInput>;

/**
 * REST API（/api/*）と互換の Service Binding 用エントリポイント。
 *
 * 呼び出し側の wrangler 設定:
 *   "services": [{ "binding": "SHORTENER", "service": "url-shortener", "entrypoint": "ShortenerService" }]
 *
 * - RPC: `await env.SHORTENER.shorten({ url })` のようにメソッドを呼ぶ。戻り値は ServiceResult。
 * - HTTP: `await env.SHORTENER.fetch("https://<domain>/api/shorten", { method: "POST", body })`。
 *   パス・ボディ・レスポンスは REST API と同じで、Access の JWT は不要。
 *
 * どちらも REST API と同じハンドラーを通るため、バリデーションとレスポンスの形は REST API と一致する。
 */
export class ShortenerService extends WorkerEntrypoint<Bindings> {
	async fetch(request: Request): Promise<Response> {
		return serviceApp.fetch(withHostHeader(request), this.env, this.ctx);
	}

	/** POST /api/shorten */
	shorten(input: ShortenInput): Promise<ServiceResult<ShortenedUrl>> {
		return this.#request("POST", "/api/shorten", { body: input });
	}

	/** GET /api/urls */
	listUrls(input: ListUrlsInput = {}): Promise<ServiceResult<UrlList>> {
		return this.#request("GET", "/api/urls", { query: input });
	}

	/** GET /api/urls/:slug/stats */
	getUrlStats(slug: string, options: DomainOption = {}): Promise<ServiceResult<UrlRow>> {
		return this.#request("GET", `/api/urls/${encodeURIComponent(slug)}/stats`, { query: options });
	}

	/** PATCH /api/urls/:slug */
	updateUrl(
		slug: string,
		changes: UpdateUrlInput,
		options: DomainOption = {},
	): Promise<ServiceResult<UrlRow>> {
		return this.#request("PATCH", `/api/urls/${encodeURIComponent(slug)}`, {
			body: { ...changes, ...options },
		});
	}

	/** DELETE /api/urls/:slug（論理削除） */
	deleteUrl(slug: string, options: DomainOption = {}): Promise<ServiceResult<null>> {
		return this.#request("DELETE", `/api/urls/${encodeURIComponent(slug)}`, { query: options });
	}

	/** POST /api/urls/:slug/restore */
	restoreUrl(slug: string, options: DomainOption = {}): Promise<ServiceResult<null>> {
		return this.#request("POST", `/api/urls/${encodeURIComponent(slug)}/restore`, {
			query: options,
		});
	}

	/** GET /api/domains */
	listDomains(): Promise<ServiceResult<{ data: DomainResponse[] }>> {
		return this.#request("GET", "/api/domains");
	}

	/** POST /api/domains */
	createDomain(input: CreateDomainInput): Promise<ServiceResult<DomainResponse>> {
		return this.#request("POST", "/api/domains", { body: input });
	}

	/** PATCH /api/domains/:domain */
	updateDomain(domain: string, changes: UpdateDomainInput): Promise<ServiceResult<DomainResponse>> {
		return this.#request("PATCH", `/api/domains/${encodeURIComponent(domain)}`, { body: changes });
	}

	/** GET /api/domains/:domain/hostname */
	refreshDomainHostname(domain: string): Promise<ServiceResult<DomainHostnameStatus>> {
		return this.#request("GET", `/api/domains/${encodeURIComponent(domain)}/hostname`);
	}

	/** DELETE /api/domains/:domain */
	deleteDomain(domain: string): Promise<ServiceResult<null>> {
		return this.#request("DELETE", `/api/domains/${encodeURIComponent(domain)}`);
	}

	/** GET /api/folders */
	listFolders(): Promise<ServiceResult<{ data: FolderResponse[] }>> {
		return this.#request("GET", "/api/folders");
	}

	/** GET /api/folders/:id */
	getFolder(id: number): Promise<ServiceResult<FolderResponse>> {
		return this.#request("GET", `/api/folders/${id}`);
	}

	/** POST /api/folders */
	createFolder(input: CreateFolderInput): Promise<ServiceResult<FolderResponse>> {
		return this.#request("POST", "/api/folders", { body: input });
	}

	/** PATCH /api/folders/:id（名前の変更・移動） */
	updateFolder(id: number, changes: UpdateFolderInput): Promise<ServiceResult<FolderResponse>> {
		return this.#request("PATCH", `/api/folders/${id}`, { body: changes });
	}

	/** DELETE /api/folders/:id（サブフォルダごと削除。中の URL は未分類に戻る） */
	deleteFolder(id: number): Promise<ServiceResult<null>> {
		return this.#request("DELETE", `/api/folders/${id}`);
	}

	#request<T>(
		method: string,
		path: string,
		options: ApiRequestOptions = {},
	): Promise<ServiceResult<T>> {
		return callApi<T>(serviceApp, this.env, this.ctx, method, path, options);
	}
}
