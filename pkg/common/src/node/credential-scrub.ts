import { REDACTED } from "../redact";

const MIN_FORM_LENGTH = 4;

const lowerHex = (text: string) =>
	text.replace(/%[0-9A-F]{2}/g, (hex) => hex.toLowerCase());

function formsOf(value: string): string[] {
	const base64 = Buffer.from(value).toString("base64");
	const base64url = Buffer.from(value).toString("base64url");
	const encoded = encodeURIComponent(value);
	const form = new URLSearchParams({ v: value }).toString().slice(2);
	return [
		value,
		JSON.stringify(value).slice(1, -1),
		base64,
		base64.replace(/=+$/, ""),
		base64url,
		base64url.replace(/=+$/, ""),
		encoded,
		lowerHex(encoded),
		form,
		lowerHex(form),
	];
}

/** Every literal, encoded and padded form of each value, longest first, without duplicates or forms under 4 characters. */
export function secretForms(values: readonly string[]): string[] {
	const forms = new Set(
		values.flatMap(formsOf).filter((form) => form.length >= MIN_FORM_LENGTH),
	);
	return [...forms].sort((a, b) => b.length - a.length);
}

function matcher(forms: readonly string[]): RegExp | undefined {
	if (forms.length === 0) return undefined;
	return new RegExp(
		forms.map((form) => form.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"),
		"g",
	);
}

/** Replaces every form of every value with [redacted]. */
export function scrubText(text: string, values: readonly string[]): string {
	const pattern = matcher(secretForms(values));
	return pattern ? text.replace(pattern, REDACTED) : text;
}

export type Scrubber = {
	push(chunk: string): string;
	flush(): string;
};

/** Scrubs a chunked stream; only a tail that could start a secret form is held back until more data or flush, so a split value is caught and a prompt still shows. */
export function createScrubber(values: readonly string[]): Scrubber {
	const forms = secretForms(values);
	const pattern = matcher(forms);
	const hold = forms.length === 0 ? 0 : forms[0].length - 1;
	let buffer = "";
	return {
		push(chunk) {
			if (!pattern) return chunk;
			buffer += chunk;
			let keep = 0;
			for (let size = Math.min(hold, buffer.length); size > 0; size--) {
				const tail = buffer.slice(-size);
				if (forms.some((form) => form.length > size && form.startsWith(tail))) {
					keep = size;
					break;
				}
			}
			const cut = buffer.length - keep;
			let out = "";
			let consumed = 0;
			for (const match of buffer.matchAll(pattern)) {
				const start = match.index ?? 0;
				if (start >= cut) break;
				out += buffer.slice(consumed, start) + REDACTED;
				consumed = start + match[0].length;
			}
			const upTo = Math.max(consumed, cut);
			out += buffer.slice(consumed, upTo);
			buffer = buffer.slice(upTo);
			return out;
		},
		flush() {
			const rest = pattern ? buffer.replace(pattern, REDACTED) : buffer;
			buffer = "";
			return rest;
		},
	};
}

/** Pipes a byte stream to write through a scrubber. */
export async function scrubStream(
	source: ReadableStream<Uint8Array>,
	write: (text: string) => void,
	values: readonly string[],
): Promise<void> {
	const scrubber = createScrubber(values);
	const decoder = new TextDecoder();
	const emit = (text: string) => {
		if (text) write(text);
	};
	for await (const chunk of source)
		emit(scrubber.push(decoder.decode(chunk, { stream: true })));
	emit(scrubber.push(decoder.decode()));
	emit(scrubber.flush());
}
