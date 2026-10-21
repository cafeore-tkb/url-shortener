import { describe, expect, it } from "vitest";
import { CHARSET, generateSlug } from "../../src/lib/slug-generator";

const ALLOWED_CHARS = new RegExp(`^[${CHARSET}]+$`);
const CONFUSING_CHARS = /[0Ol1I]/;

describe("generateSlug", () => {
	it("generates a slug of default length 6", () => {
		const slug = generateSlug();
		expect(slug).toHaveLength(6);
	});

	it("generates a slug of custom length", () => {
		const slug = generateSlug(8);
		expect(slug).toHaveLength(8);
	});

	it("only contains allowed characters", () => {
		for (let i = 0; i < 1000; i++) {
			expect(generateSlug()).toMatch(ALLOWED_CHARS);
		}
	});

	it("never contains visually confusing characters", () => {
		for (let i = 0; i < 1000; i++) {
			expect(generateSlug()).not.toMatch(CONFUSING_CHARS);
		}
	});

	it("generates different values on successive calls", () => {
		const a = generateSlug();
		const b = generateSlug();
		expect(a).not.toBe(b);
	});
});
