type ValidationResult = { valid: true } | { valid: false; reason: string };

const RESERVED_SLUGS = ["admin", "api", "health", "favicon.ico"];
const SLUG_PATTERN = /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$/;

export function validateSlug(slug: string): ValidationResult {
	if (slug.length < 1 || slug.length > 128) {
		return { valid: false, reason: "Slug must be between 1 and 128 characters" };
	}
	if (RESERVED_SLUGS.includes(slug.toLowerCase())) {
		return { valid: false, reason: "Slug is reserved" };
	}
	if (!SLUG_PATTERN.test(slug)) {
		return {
			valid: false,
			reason: "Slug must start and end with alphanumeric and contain only alphanumeric or hyphens",
		};
	}
	if (slug.includes("--")) {
		return { valid: false, reason: "Slug must not contain consecutive hyphens" };
	}
	return { valid: true };
}

export function validateTargetUrl(url: string): ValidationResult {
	if (url.length === 0) {
		return { valid: false, reason: "URL must not be empty" };
	}
	if (url.length > 2048) {
		return { valid: false, reason: "URL must not exceed 2048 characters" };
	}
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return { valid: false, reason: "Invalid URL" };
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		return { valid: false, reason: "URL must use http or https protocol" };
	}
	return { valid: true };
}

export function validateGoneTitle(title: string): ValidationResult {
	if (title.length > 100) {
		return { valid: false, reason: "Title must not exceed 100 characters" };
	}
	return { valid: true };
}

export function validateGoneMessage(message: string): ValidationResult {
	if (message.length > 500) {
		return { valid: false, reason: "Message must not exceed 500 characters" };
	}
	return { valid: true };
}

export function validateGoneColor(color: string): ValidationResult {
	if (!/^#[0-9A-Fa-f]{6}$/.test(color)) {
		return { valid: false, reason: "Color must be a valid hex color (e.g. #FF0000)" };
	}
	return { valid: true };
}

export function validateGoneLogoUrl(url: string | null): ValidationResult {
	if (url === null) {
		return { valid: true };
	}
	if (url.length > 2048) {
		return { valid: false, reason: "Logo URL must not exceed 2048 characters" };
	}
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return { valid: false, reason: "Invalid logo URL" };
	}
	if (parsed.protocol !== "https:") {
		return { valid: false, reason: "Logo URL must use https protocol" };
	}
	return { valid: true };
}

export function validateFolderName(name: unknown): ValidationResult {
	if (typeof name !== "string" || name.trim().length === 0) {
		return { valid: false, reason: "Folder name must not be empty" };
	}
	if (name.trim().length > 100) {
		return { valid: false, reason: "Folder name must not exceed 100 characters" };
	}
	return { valid: true };
}

/** フォルダ ID の入力値。null は「フォルダなし（未分類 / トップレベル）」を表す */
export function validateFolderId(id: unknown, field = "folder_id"): ValidationResult {
	if (id === null || (typeof id === "number" && Number.isSafeInteger(id) && id > 0)) {
		return { valid: true };
	}
	return { valid: false, reason: `${field} must be a positive integer or null` };
}
