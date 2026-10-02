const emailPattern = /[A-Z0-9._%+-]+@([A-Z0-9.-]+\.[A-Z]{2,})/gi;
const phonePattern =
	/\b(?:\+?1[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?)\d{3}[-.\s]?\d{4}\b/g;
const longNumberPattern = /\b\d{5,}\b/g;

export function fromDomain(from: string): string {
	const match = from.match(/@([^>\s]+)/);
	return match?.[1]?.toLowerCase() ?? "unknown";
}

export function redactText(input: string, maxLength = 160): string {
	return input
		.replace(emailPattern, "[email:$1]")
		.replace(phonePattern, "[phone]")
		.replace(longNumberPattern, "[number]")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, maxLength);
}

export function assertNoEmailAddress(input: string): void {
	if (/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(input)) {
		throw new Error("Refusing to emit raw email address in redacted output.");
	}
}

/** Redacts email addresses recursively in strings and object keys; preserves private originals and does not sanitize tokens. */
export function redactPublicValue(value: unknown): unknown {
	if (typeof value === "string")
		return value.replace(emailPattern, "[email:$1]");
	if (Array.isArray(value)) return value.map(redactPublicValue);
	if (value && typeof value === "object")
		return Object.fromEntries(
			Object.entries(value).map(([key, entry]) => [
				key.replace(emailPattern, "[email:$1]"),
				redactPublicValue(entry),
			]),
		);
	return value;
}
