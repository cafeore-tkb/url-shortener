import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
	type ImportRow,
	applySlugs,
	generatedSlugsField,
	insertImport,
	readImportCsv,
} from "../../src/lib/url-import";
import type { Bindings } from "../../src/types";
import { cleanAll, seedDomain, seedUrl } from "../fixtures/seed";

declare module "cloudflare:test" {
	interface ProvidedEnv extends Bindings {
		TEST_MIGRATIONS: D1Migration[];
	}
}

function row(slug: string, url = `https://example.com/${slug}`): ImportRow {
	return {
		line: 2,
		values: { url, slug, domain: "", expires_at: "", note: "", folder: "" },
		extra: false,
		generated: false,
		domain: "s.example.com",
		expires_at: null,
		folder_id: null,
		errors: [],
	};
}

beforeAll(async () => {
	await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
	await cleanAll(env.DB);
	await seedDomain(env.DB);
});

describe("insertImport", () => {
	it("rolls back every row when one insert fails", async () => {
		await seedUrl(env.DB, { slug: "taken" });
		const result = await insertImport(env.DB, [row("new1"), row("taken"), row("new2")]);
		expect(result.ok).toBe(false);
		const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM urls").first<{ n: number }>();
		expect(count?.n).toBe(1);
	});
});

describe("readImportCsv / applySlugs", () => {
	it("ignores blank lines and maps columns by header", () => {
		const read = readImportCsv("note,URL\n\n,\nmemo,https://example.com\n");
		expect(read).toEqual({
			ok: true,
			inputs: [
				{
					line: 4,
					values: {
						url: "https://example.com",
						slug: "",
						domain: "",
						expires_at: "",
						note: "memo",
						folder: "",
					},
					extra: false,
					generated: false,
				},
			],
		});
	});

	it("round-trips generated slugs", () => {
		const read = readImportCsv("url,slug\nhttps://a.example,\nhttps://b.example,fixed\n");
		if (!read.ok) throw new Error(read.error);
		expect(applySlugs(read.inputs, "gen123\r\n")).toBe(true);
		expect(read.inputs.map((i) => [i.values.slug, i.generated])).toEqual([
			["gen123", true],
			["fixed", false],
		]);
		expect(generatedSlugsField(read.inputs)).toBe("gen123\n");
	});
});
