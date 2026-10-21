/**
 * 管理画面の日時は日本時間（UTC+9、夏時間なし）で表示・入力する。
 * サーバー側でレンダリングするためブラウザのタイムゾーンは使えない。
 * D1 には従来どおり UTC の ISO 8601 文字列で保存する。
 */
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const INPUT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/;
const HAS_TIMEZONE = /(Z|[+-]\d{2}:?\d{2})$/;

/**
 * D1 に保存された日時を epoch ミリ秒にする。SQLite の datetime('now') 形式
 * （"2024-01-01 00:00:00"）のようにタイムゾーンが無いものは UTC とみなす。
 */
export function parseStoredDate(value: string): number {
	const iso = value.includes("T") ? value : value.replace(" ", "T");
	return Date.parse(HAS_TIMEZONE.test(iso) ? iso : `${iso}Z`);
}

/** 保存値を datetime-local 用の "YYYY-MM-DDTHH:mm"（日本時間）にする。不正値・null は空文字 */
export function toJstInputValue(value: string | null): string {
	if (!value) return "";
	const ms = parseStoredDate(value);
	if (Number.isNaN(ms)) return "";
	return new Date(ms + JST_OFFSET_MS).toISOString().slice(0, 16);
}

/** 保存値を "YYYY-MM-DD HH:mm"（日本時間）で表示する。不正値はそのまま返す */
export function formatJst(value: string): string {
	const input = toJstInputValue(value);
	return input ? input.replace("T", " ") : value;
}

/**
 * datetime-local の値（日本時間）を UTC の ISO 8601 文字列にする。
 * 空文字は null（期限なし）、形式が不正なら undefined を返す。
 */
export function parseJstInput(value: string): string | null | undefined {
	const trimmed = value.trim();
	if (trimmed === "") return null;
	if (!INPUT_PATTERN.test(trimmed)) return undefined;
	const ms = Date.parse(`${trimmed.length === 16 ? `${trimmed}:00` : trimmed}+09:00`);
	if (Number.isNaN(ms)) return undefined;
	return new Date(ms).toISOString();
}
