import { invalidateAll } from "../../src/lib/domain-cache";
import type { DomainRow, FolderRow, UrlRow } from "../../src/types";

export const DEFAULT_DOMAIN: Partial<DomainRow> = {
	domain: "s.example.com",
	name: "Main",
	gone_title: "Link Expired",
	gone_message: "This link is no longer available.",
	gone_color: "#FF0000",
	gone_logo_url: null,
};

export const DEFAULT_URL: Partial<UrlRow> = {
	domain: "s.example.com",
	slug: "abc123",
	target_url: "https://example.com",
	expires_at: null,
	note: null,
	folder_id: null,
};

export async function seedDomain(
	db: D1Database,
	overrides: Partial<DomainRow> = {},
): Promise<DomainRow> {
	const d = { ...DEFAULT_DOMAIN, ...overrides };
	await db
		.prepare(
			"INSERT INTO domains (domain, name, gone_title, gone_message, gone_color, gone_logo_url, external, custom_hostname_id, hostname_status, ssl_status, ownership_verification, ssl_validation, dcv_delegation) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
		)
		.bind(
			d.domain,
			d.name,
			d.gone_title,
			d.gone_message,
			d.gone_color,
			d.gone_logo_url ?? null,
			d.external ?? 0,
			d.custom_hostname_id ?? null,
			d.hostname_status ?? null,
			d.ssl_status ?? null,
			d.ownership_verification ?? null,
			d.ssl_validation ?? null,
			d.dcv_delegation ?? null,
		)
		.run();

	const row = await db
		.prepare("SELECT * FROM domains WHERE domain = ?")
		.bind(d.domain)
		.first<DomainRow>();
	return row as DomainRow;
}

export async function seedUrl(db: D1Database, overrides: Partial<UrlRow> = {}): Promise<UrlRow> {
	const u = { ...DEFAULT_URL, ...overrides };
	await db
		.prepare(
			"INSERT INTO urls (domain, slug, target_url, expires_at, note, folder_id) VALUES (?, ?, ?, ?, ?, ?)",
		)
		.bind(u.domain, u.slug, u.target_url, u.expires_at ?? null, u.note ?? null, u.folder_id ?? null)
		.run();

	const row = await db
		.prepare("SELECT * FROM urls WHERE domain = ? AND slug = ?")
		.bind(u.domain, u.slug)
		.first<UrlRow>();
	return row as UrlRow;
}

export async function seedFolder(
	db: D1Database,
	name: string,
	parentId: number | null = null,
): Promise<FolderRow> {
	const row = await db
		.prepare("INSERT INTO folders (name, parent_id) VALUES (?, ?) RETURNING *")
		.bind(name, parentId)
		.first<FolderRow>();
	return row as FolderRow;
}

export async function cleanAll(db: D1Database): Promise<void> {
	await db.prepare("DELETE FROM urls").bind().run();
	await db.prepare("DELETE FROM folders").bind().run();
	await db.prepare("DELETE FROM domains").bind().run();
	invalidateAll();
}
