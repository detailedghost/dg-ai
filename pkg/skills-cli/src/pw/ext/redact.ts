import { redactText } from "@dg/common";

const MAX_TEXT_BYTES = 20_000;
const TRUNCATION_NOTICE = "\n...[truncated]";

/** Accessibility-snapshot-shaped password fields, e.g. `textbox "Password" [value="secret"]`. */
const PASSWORD_FIELD_VALUE =
	/((?:password|passwd|pwd|passcode)[^\n]{0,40}?(?:value|text)\s*[:=]\s*"?)([^"\n]*)("?)/gi;

export function redactPasswordFields(text: string): string {
	return text.replace(PASSWORD_FIELD_VALUE, (_match, before: string, _value: string, after: string) =>
		`${before}[redacted]${after}`,
	);
}

export function capText(text: string, maxBytes = MAX_TEXT_BYTES): string {
	if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
	return `${Buffer.from(text, "utf8").subarray(0, maxBytes).toString("utf8")}${TRUNCATION_NOTICE}`;
}

/** Defense in depth for `pw --ext` read verbs: mask password fields and token-like values, then cap size. */
export function redactExtOutput(text: string, maxBytes = MAX_TEXT_BYTES): string {
	return capText(redactText(redactPasswordFields(text)), maxBytes);
}
