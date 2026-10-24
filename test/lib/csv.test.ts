import { describe, expect, it } from "vitest";
import { decodeCsv, formatCsv, parseCsv } from "../../src/lib/csv";

function cells(text: string): string[][] {
	const result = parseCsv(text);
	if (!result.ok) throw new Error(result.error);
	return result.records.map((r) => r.cells);
}

describe("parseCsv", () => {
	it("splits rows and cells", () => {
		expect(cells("a,b,c\r\n1,2,3\r\n")).toEqual([
			["a", "b", "c"],
			["1", "2", "3"],
		]);
	});

	it("accepts LF / CR line endings and a missing final newline", () => {
		expect(cells("a,b\n1,2")).toEqual([
			["a", "b"],
			["1", "2"],
		]);
		expect(cells("a,b\r1,2\r")).toEqual([
			["a", "b"],
			["1", "2"],
		]);
	});

	it("keeps empty cells", () => {
		expect(cells("a,,c,\n")).toEqual([["a", "", "c", ""]]);
	});

	it("reads quoted values with commas, escaped quotes and newlines", () => {
		expect(cells('"a,b","say ""hi""","line1\r\nline2"\n')).toEqual([
			["a,b", 'say "hi"', "line1\nline2"],
		]);
	});

	it("reports the line where each record starts", () => {
		const result = parseCsv('h\n"multi\nline"\n\nlast\n');
		expect(result.ok && result.records.map((r) => r.line)).toEqual([1, 2, 4, 5]);
	});

	it("treats quotes inside an unquoted value literally", () => {
		expect(cells('ab"c,d\n')).toEqual([['ab"c', "d"]]);
	});

	it("fails on an unclosed quote", () => {
		const result = parseCsv('a\n"open,\nmore\n');
		expect(result).toEqual({ ok: false, line: 2, error: expect.stringContaining("引用符") });
	});
});

describe("formatCsv", () => {
	it("quotes values only when needed and uses CRLF", () => {
		expect(formatCsv([["a", "b,c", 'd"e', "f\ng", " pad", ""]])).toBe(
			'a,"b,c","d""e","f\ng"," pad",\r\n',
		);
	});

	it("round-trips through parseCsv", () => {
		const rows = [
			["url", "note"],
			["https://example.com/?a=1,2", 'メモ "引用" と\n改行'],
		];
		expect(cells(formatCsv(rows))).toEqual(rows);
	});
});

describe("decodeCsv", () => {
	it("reads UTF-8 and strips the BOM", () => {
		const bytes = new TextEncoder().encode("﻿url,note\nhttps://example.com,テスト\n");
		expect(decodeCsv(bytes.buffer as ArrayBuffer)).toEqual({
			ok: true,
			text: "url,note\nhttps://example.com,テスト\n",
		});
	});

	it("falls back to Shift_JIS", () => {
		// "url,note\nhttps://example.com,テスト\n" の Shift_JIS
		const head = new TextEncoder().encode("url,note\nhttps://example.com,");
		const bytes = new Uint8Array([...head, 0x83, 0x65, 0x83, 0x58, 0x83, 0x67, 0x0a]);
		expect(decodeCsv(bytes.buffer)).toEqual({
			ok: true,
			text: "url,note\nhttps://example.com,テスト\n",
		});
	});

	it("fails when neither encoding fits", () => {
		const result = decodeCsv(new Uint8Array([0x80, 0xff, 0xfe]).buffer);
		expect(result.ok).toBe(false);
	});
});
