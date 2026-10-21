import { createMiddleware } from "hono/factory";
import { forbidden } from "../lib/errors";
import type { AppEnv } from "../types";

const SAFE_METHODS = ["GET", "HEAD", "OPTIONS"];

/**
 * /api/* の CSRF 対策。
 *
 * Cloudflare Access は CF_Authorization Cookie から Cf-Access-Jwt-Assertion を付けて Worker に渡す。
 * この Cookie の SameSite は既定で None なので、ログイン中の管理者が罠ページを開くと、
 * 別サイトからのフォーム送信（text/plain で JSON を送れる）にも有効な JWT が付いてしまう。
 *
 * ブラウザが別オリジンからの送信だと示したとき（Sec-Fetch-Site / Origin）だけ拒否する。
 * curl やサーバー間の呼び出しはどちらのヘッダーも付けないので、これまでどおり通す。
 * hono/csrf はどちらのヘッダーも無いリクエストも拒否するため、ブラウザ以外から呼ばれる API には使わない。
 */
export const csrfMiddleware = createMiddleware<AppEnv>(async (c, next) => {
	if (SAFE_METHODS.includes(c.req.method)) {
		return next();
	}

	const secFetchSite = c.req.header("Sec-Fetch-Site");
	const origin = c.req.header("Origin");
	if (
		(secFetchSite !== undefined && secFetchSite !== "same-origin") ||
		(origin !== undefined && origin !== new URL(c.req.url).origin)
	) {
		return forbidden("Cross-origin requests are not allowed");
	}

	return next();
});
