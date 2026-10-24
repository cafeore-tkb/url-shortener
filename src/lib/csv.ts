/** CSV の 1 レコード。line はレコードが始まるファイル上の行番号（1 始まり） */
export type CsvRecord = { line: number; cells: string[] };

export type CsvParseResult =
	| { ok: true; records: CsvRecord[] }
	| { ok: false; line: number; error: string };

export type CsvDecodeResult = { ok: true; text: string } | { ok: false; error: string };

/**
 * アップロードされた CSV のバイト列を文字列にする。UTF-8（BOM 付き可）として読めなければ
 * Shift_JIS とみなす。日本語版 Excel の「CSV（コンマ区切り）」は Shift_JIS で保存されるため。
 */
export function decodeCsv(bytes: ArrayBuffer): CsvDecodeResult {
	for (const encoding of ["utf-8", "shift_jis"]) {
		let decoder: TextDecoder;
		try {
			// BOM は既定（ignoreBOM: false）で取り除かれる
			decoder = new TextDecoder(encoding, { fatal: true });
		} catch {
			continue;
		}
		try {
			return { ok: true, text: decoder.decode(bytes) };
		} catch {
			// 次の文字コードを試す
		}
	}
	return {
		ok: false,
		error: "文字コードを判別できませんでした。UTF-8 または Shift_JIS で保存してください。",
	};
}

/**
 * RFC 4180 形式の CSV を読む。区切りはカンマで、値にカンマ・改行・" を含む場合は " で囲み、
 * 中の " は "" と書く。改行は CRLF / LF / CR のどれでもよく、値の中の改行は LF にそろえる。
 * 囲みの外にある " はそのまま値の一部として扱う（Excel などが書き出す CSV より緩く読む）。
 */
export function parseCsv(text: string): CsvParseResult {
	const src = text.replace(/\r\n?/g, "\n");
	const records: CsvRecord[] = [];
	let cells: string[] = [];
	let cell = "";
	let quoted = false;
	let line = 1;
	let recordLine = 1;
	let quoteLine = 1;

	for (let i = 0; i < src.length; i++) {
		const ch = src[i];
		if (quoted) {
			if (ch === '"') {
				if (src[i + 1] === '"') {
					cell += '"';
					i++;
				} else {
					quoted = false;
				}
			} else {
				if (ch === "\n") line++;
				cell += ch;
			}
		} else if (ch === '"' && cell === "") {
			quoted = true;
			quoteLine = line;
		} else if (ch === ",") {
			cells.push(cell);
			cell = "";
		} else if (ch === "\n") {
			cells.push(cell);
			records.push({ line: recordLine, cells });
			cells = [];
			cell = "";
			line++;
			recordLine = line;
		} else {
			cell += ch;
		}
	}

	if (quoted) {
		return { ok: false, line: quoteLine, error: '引用符（"）が閉じられていません' };
	}
	// 最後の行に改行が無い場合
	if (cell !== "" || cells.length > 0) {
		cells.push(cell);
		records.push({ line: recordLine, cells });
	}
	return { ok: true, records };
}

/** Excel が UTF-8 と判定できるよう、ダウンロードさせる CSV の先頭に付ける BOM */
export const CSV_BOM = "\uFEFF";

/**
 * 行の配列を RFC 4180 形式の CSV（改行は CRLF）にする。カンマ・改行・" を含む値と、
 * 前後に空白がある値（読み込み時に除かれるため）は " で囲む。
 */
export function formatCsv(rows: string[][]): string {
	const quote = (value: string) =>
		/[",\r\n]|^\s|\s$/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
	return rows.map((row) => `${row.map(quote).join(",")}\r\n`).join("");
}
