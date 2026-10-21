import type { DomainRow } from "../types";

const TTL_MS = 60_000;

const cache = new Map<string, { data: DomainRow; expiresAt: number }>();

export async function getDomain(domain: string, db: D1Database): Promise<DomainRow | null> {
	const cached = cache.get(domain);
	if (cached && cached.expiresAt > Date.now()) {
		return cached.data;
	}

	const row = await db
		.prepare("SELECT * FROM domains WHERE domain = ?")
		.bind(domain)
		.first<DomainRow>();

	if (row) {
		cache.set(domain, { data: row, expiresAt: Date.now() + TTL_MS });
	} else {
		cache.delete(domain);
	}

	return row;
}

export function invalidate(domain: string): void {
	cache.delete(domain);
}

export function invalidateAll(): void {
	cache.clear();
}
