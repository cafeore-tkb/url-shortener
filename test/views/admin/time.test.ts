import { describe, expect, it } from "vitest";
import {
	formatJst,
	parseJstDateTime,
	parseJstInput,
	parseStoredDate,
	toJstInputValue,
} from "../../../src/views/admin/time";

describe("parseStoredDate", () => {
	it("treats SQLite datetime without timezone as UTC", () => {
		expect(parseStoredDate("2024-01-01 00:00:00")).toBe(Date.UTC(2024, 0, 1));
	});

	it("respects explicit timezones", () => {
		expect(parseStoredDate("2024-01-01T09:00:00+09:00")).toBe(Date.UTC(2024, 0, 1));
		expect(parseStoredDate("2024-01-01T00:00:00.000Z")).toBe(Date.UTC(2024, 0, 1));
	});
});

describe("toJstInputValue / formatJst", () => {
	it("converts UTC to JST", () => {
		expect(toJstInputValue("2024-01-01T15:30:00.000Z")).toBe("2024-01-02T00:30");
		expect(formatJst("2024-01-01 15:30:00")).toBe("2024-01-02 00:30");
	});

	it("returns empty for null or invalid input", () => {
		expect(toJstInputValue(null)).toBe("");
		expect(toJstInputValue("not a date")).toBe("");
		expect(formatJst("not a date")).toBe("not a date");
	});
});

describe("parseJstInput", () => {
	it("interprets datetime-local values as JST", () => {
		expect(parseJstInput("2024-01-02T00:30")).toBe("2024-01-01T15:30:00.000Z");
		expect(parseJstInput("2024-01-02T00:30:15")).toBe("2024-01-01T15:30:15.000Z");
	});

	it("returns null for empty input", () => {
		expect(parseJstInput("")).toBeNull();
		expect(parseJstInput("  ")).toBeNull();
	});

	it("returns undefined for malformed input", () => {
		expect(parseJstInput("tomorrow")).toBeUndefined();
		expect(parseJstInput("2024-13-40T25:99")).toBeUndefined();
	});
});

describe("parseJstDateTime", () => {
	it("interprets values without a timezone as JST", () => {
		expect(parseJstDateTime("2024-01-02 00:30")).toBe("2024-01-01T15:30:00.000Z");
		expect(parseJstDateTime("2024-01-02T00:30:15")).toBe("2024-01-01T15:30:15.000Z");
	});

	it("accepts the format Excel writes", () => {
		expect(parseJstDateTime("2024/1/2 0:30")).toBe("2024-01-01T15:30:00.000Z");
		expect(parseJstDateTime(" 2024/12/31 23:59:00 ")).toBe("2024-12-31T14:59:00.000Z");
	});

	it("respects explicit timezones", () => {
		expect(parseJstDateTime("2024-01-01T15:30:00Z")).toBe("2024-01-01T15:30:00.000Z");
		expect(parseJstDateTime("2024-01-01T15:30:00.250Z")).toBe("2024-01-01T15:30:00.250Z");
		expect(parseJstDateTime("2024-01-01T10:30:00-05:00")).toBe("2024-01-01T15:30:00.000Z");
	});

	it("returns null for empty input", () => {
		expect(parseJstDateTime("")).toBeNull();
		expect(parseJstDateTime("  ")).toBeNull();
	});

	it("rejects dates without a time and impossible dates", () => {
		expect(parseJstDateTime("2024-01-02")).toBeUndefined();
		expect(parseJstDateTime("tomorrow")).toBeUndefined();
		expect(parseJstDateTime("2026-02-30 00:00")).toBeUndefined();
		expect(parseJstDateTime("2026-02-28 24:00")).toBeUndefined();
		expect(parseJstDateTime("2026-02-30T00:00:00Z")).toBeUndefined();
	});
});
