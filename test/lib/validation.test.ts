import { describe, expect, it } from "vitest";
import {
	validateFolderId,
	validateFolderName,
	validateGoneColor,
	validateGoneLogoUrl,
	validateGoneMessage,
	validateGoneTitle,
	validateSlug,
	validateTargetUrl,
} from "../../src/lib/validation";

describe("validateSlug", () => {
	it("accepts valid slugs", () => {
		expect(validateSlug("hello")).toEqual({ valid: true });
		expect(validateSlug("a")).toEqual({ valid: true });
		expect(validateSlug("my-slug")).toEqual({ valid: true });
		expect(validateSlug("ABC123")).toEqual({ valid: true });
		expect(validateSlug("a1b2c3")).toEqual({ valid: true });
	});

	it("rejects empty slug", () => {
		const result = validateSlug("");
		expect(result.valid).toBe(false);
	});

	it("rejects slug exceeding 128 characters", () => {
		const result = validateSlug("a".repeat(129));
		expect(result.valid).toBe(false);
	});

	it("accepts slug at max length", () => {
		expect(validateSlug("a".repeat(128))).toEqual({ valid: true });
	});

	it("rejects slug starting with hyphen", () => {
		const result = validateSlug("-hello");
		expect(result.valid).toBe(false);
	});

	it("rejects slug ending with hyphen", () => {
		const result = validateSlug("hello-");
		expect(result.valid).toBe(false);
	});

	it("rejects consecutive hyphens", () => {
		const result = validateSlug("he--llo");
		expect(result.valid).toBe(false);
	});

	it("rejects special characters", () => {
		expect(validateSlug("hello world").valid).toBe(false);
		expect(validateSlug("hello/world").valid).toBe(false);
		expect(validateSlug("hello.world").valid).toBe(false);
		expect(validateSlug("hello_world").valid).toBe(false);
	});

	it("rejects reserved words", () => {
		expect(validateSlug("admin").valid).toBe(false);
		expect(validateSlug("api").valid).toBe(false);
		expect(validateSlug("health").valid).toBe(false);
		expect(validateSlug("favicon.ico").valid).toBe(false);
	});

	it("rejects reserved words case-insensitively", () => {
		expect(validateSlug("Admin").valid).toBe(false);
		expect(validateSlug("API").valid).toBe(false);
		expect(validateSlug("HEALTH").valid).toBe(false);
	});
});

describe("validateTargetUrl", () => {
	it("accepts valid http URLs", () => {
		expect(validateTargetUrl("http://example.com")).toEqual({ valid: true });
	});

	it("accepts valid https URLs", () => {
		expect(validateTargetUrl("https://example.com/path?q=1")).toEqual({ valid: true });
	});

	it("rejects empty URL", () => {
		expect(validateTargetUrl("").valid).toBe(false);
	});

	it("rejects URL exceeding 2048 characters", () => {
		const result = validateTargetUrl(`https://example.com/${"a".repeat(2048)}`);
		expect(result.valid).toBe(false);
	});

	it("rejects ftp protocol", () => {
		expect(validateTargetUrl("ftp://example.com").valid).toBe(false);
	});

	it("rejects javascript protocol", () => {
		expect(validateTargetUrl("javascript:alert(1)").valid).toBe(false);
	});

	it("rejects invalid URL", () => {
		expect(validateTargetUrl("not-a-url").valid).toBe(false);
	});
});

describe("validateGoneTitle", () => {
	it("accepts valid title", () => {
		expect(validateGoneTitle("Page Gone")).toEqual({ valid: true });
	});

	it("accepts empty title", () => {
		expect(validateGoneTitle("")).toEqual({ valid: true });
	});

	it("accepts title at max length", () => {
		expect(validateGoneTitle("a".repeat(100))).toEqual({ valid: true });
	});

	it("rejects title exceeding 100 characters", () => {
		expect(validateGoneTitle("a".repeat(101)).valid).toBe(false);
	});
});

describe("validateGoneMessage", () => {
	it("accepts valid message", () => {
		expect(validateGoneMessage("This page has been removed")).toEqual({ valid: true });
	});

	it("accepts message at max length", () => {
		expect(validateGoneMessage("a".repeat(500))).toEqual({ valid: true });
	});

	it("rejects message exceeding 500 characters", () => {
		expect(validateGoneMessage("a".repeat(501)).valid).toBe(false);
	});
});

describe("validateGoneColor", () => {
	it("accepts valid hex colors", () => {
		expect(validateGoneColor("#FF0000")).toEqual({ valid: true });
		expect(validateGoneColor("#aabbcc")).toEqual({ valid: true });
		expect(validateGoneColor("#123456")).toEqual({ valid: true });
	});

	it("rejects invalid hex colors", () => {
		expect(validateGoneColor("FF0000").valid).toBe(false);
		expect(validateGoneColor("#FFF").valid).toBe(false);
		expect(validateGoneColor("#GGGGGG").valid).toBe(false);
		expect(validateGoneColor("#FF00001").valid).toBe(false);
	});
});

describe("validateGoneLogoUrl", () => {
	it("accepts null", () => {
		expect(validateGoneLogoUrl(null)).toEqual({ valid: true });
	});

	it("accepts valid https URL", () => {
		expect(validateGoneLogoUrl("https://example.com/logo.png")).toEqual({ valid: true });
	});

	it("rejects http URL", () => {
		expect(validateGoneLogoUrl("http://example.com/logo.png").valid).toBe(false);
	});

	it("rejects URL exceeding 2048 characters", () => {
		const result = validateGoneLogoUrl(`https://example.com/${"a".repeat(2048)}`);
		expect(result.valid).toBe(false);
	});

	it("rejects invalid URL", () => {
		expect(validateGoneLogoUrl("not-a-url").valid).toBe(false);
	});
});

describe("validateFolderName", () => {
	it("accepts a name of 1 to 100 characters after trimming", () => {
		expect(validateFolderName("Work")).toEqual({ valid: true });
		expect(validateFolderName(` ${"a".repeat(100)} `)).toEqual({ valid: true });
	});

	it("rejects empty, whitespace-only, too long and non-string names", () => {
		expect(validateFolderName("").valid).toBe(false);
		expect(validateFolderName("   ").valid).toBe(false);
		expect(validateFolderName("a".repeat(101)).valid).toBe(false);
		expect(validateFolderName(123).valid).toBe(false);
	});
});

describe("validateFolderId", () => {
	it("accepts a positive integer or null", () => {
		expect(validateFolderId(1)).toEqual({ valid: true });
		expect(validateFolderId(null)).toEqual({ valid: true });
	});

	it("rejects other values and names the field in the reason", () => {
		expect(validateFolderId(0).valid).toBe(false);
		expect(validateFolderId(1.5).valid).toBe(false);
		expect(validateFolderId("1").valid).toBe(false);
		expect(validateFolderId(-1, "parent_id")).toEqual({
			valid: false,
			reason: "parent_id must be a positive integer or null",
		});
	});
});
