// Excludes visually confusing characters: 0 (zero), O (uppercase O), 1 (one), l (lowercase L), I (uppercase I)
export const CHARSET = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CHARSET_LENGTH = CHARSET.length;
// Largest multiple of CHARSET_LENGTH that fits in a byte (0-255), used for unbiased rejection sampling
const UNBIASED_MAX = Math.floor(256 / CHARSET_LENGTH) * CHARSET_LENGTH;

export function generateSlug(length = 6): string {
	let slug = "";
	while (slug.length < length) {
		const bytes = crypto.getRandomValues(new Uint8Array(length - slug.length));
		for (const byte of bytes) {
			if (byte < UNBIASED_MAX) {
				slug += CHARSET[byte % CHARSET_LENGTH];
				if (slug.length === length) break;
			}
		}
	}
	return slug;
}
