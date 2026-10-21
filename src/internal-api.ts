import { Hono, type MiddlewareHandler } from "hono";
import { notFound } from "./lib/errors";
import { domainMiddleware } from "./middleware/domain";
import domainsApp from "./routes/api/domains";
import foldersApp from "./routes/api/folders";
import urlsApp from "./routes/api/urls";
import type { AppEnv, Bindings } from "./types";

/**
 * 内部から /api/* のハンドラーを呼んだ結果。REST API の HTTP ステータスと JSON ボディをそのまま運ぶ。
 * 例外ではなく値で返すのは、RPC の例外は呼び出し側の compatibility date によって
 * 独自プロパティ（status など）が落ちるため。
 */
export type ApiResult<T> =
	| { ok: true; status: number; data: T }
	| { ok: false; status: number; error: string };

export type ApiRequestOptions = {
	query?: Record<string, string | number | undefined>;
	body?: unknown;
};

/**
 * 公開アプリ（src/index.ts）と同じ /api/* のハンドラーをマウントした内部用アプリを作る。
 * Cloudflare Access の JWT 検証の代わりに principal で `email` を設定する。
 * Service Binding（src/service-binding.ts）と管理画面（src/routes/admin.tsx）が使う。
 */
export function createApiApp(principal: MiddlewareHandler<AppEnv>): Hono<AppEnv> {
	const app = new Hono<AppEnv>();
	app.use("/api/*", domainMiddleware);
	app.use("/api/*", principal);
	app.route("/api", domainsApp);
	app.route("/api", foldersApp);
	app.route("/api", urlsApp);
	app.notFound(() => notFound("Not found"));
	return app;
}

async function toResult<T>(response: Response): Promise<ApiResult<T>> {
	const text = await response.text();
	let body: unknown = null;
	if (text) {
		try {
			body = JSON.parse(text);
		} catch {
			body = text;
		}
	}

	if (response.ok) {
		return { ok: true, status: response.status, data: body as T };
	}

	const message = (body as { error?: unknown } | null)?.error;
	const error =
		typeof message === "string" ? message : text || `Request failed with status ${response.status}`;
	return { ok: false, status: response.status, error };
}

/**
 * REST API と同じリクエストを組み立てて app に渡す。Host は MAIN_DOMAIN にし、
 * 対象ドメインは REST API と同じく `domain` クエリ / ボディで指定する。
 */
export async function callApi<T>(
	app: Hono<AppEnv>,
	env: Bindings,
	ctx: ExecutionContext | undefined,
	method: string,
	path: string,
	{ query, body }: ApiRequestOptions = {},
): Promise<ApiResult<T>> {
	const url = new URL(path, `https://${env.MAIN_DOMAIN}`);
	for (const [key, value] of Object.entries(query ?? {})) {
		if (value !== undefined) {
			url.searchParams.set(key, String(value));
		}
	}

	const headers = new Headers({ Host: url.host });
	if (body !== undefined) {
		headers.set("Content-Type", "application/json");
	}

	const response = await app.fetch(
		new Request(url, {
			method,
			headers,
			body: body === undefined ? undefined : JSON.stringify(body),
		}),
		env,
		ctx,
	);
	return toResult<T>(response);
}
