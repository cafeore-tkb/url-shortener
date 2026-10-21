export function badRequest(error: string): Response {
	return Response.json({ error, status: 400 }, { status: 400 });
}

export function unauthorized(error: string): Response {
	return Response.json({ error, status: 401 }, { status: 401 });
}

export function forbidden(error: string): Response {
	return Response.json({ error, status: 403 }, { status: 403 });
}

export function notFound(error: string): Response {
	return Response.json({ error, status: 404 }, { status: 404 });
}

export function conflict(error: string): Response {
	return Response.json({ error, status: 409 }, { status: 409 });
}

export function gone(error: string): Response {
	return Response.json({ error, status: 410 }, { status: 410 });
}

/** 上流（Cloudflare API など）の呼び出しに失敗したときのエラー */
export function badGateway(error: string): Response {
	return Response.json({ error, status: 502 }, { status: 502 });
}
