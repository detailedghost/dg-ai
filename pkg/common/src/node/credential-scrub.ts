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

function coveredSpans(text: string, forms: readonly string[], carried: number): [number, number][] {
	const spans: [number, number][] = carried > 0 ? [[0, carried]] : [];
	for (const form of forms)
		for (let at = text.indexOf(form); at !== -1; at = text.indexOf(form, at + 1))
			spans.push([at, at + form.length]);
	spans.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
	const merged: [number, number][] = [];
	for (const [from, to] of spans) {
		const last = merged.at(-1);
		if (last && from < last[1]) last[1] = Math.max(last[1], to);
		else merged.push([from, to]);
	}
	return merged;
}

function redactBefore(text: string, forms: readonly string[], cut: number, carried: number) {
	let out = "";
	let pos = 0;
	for (const [from, to] of coveredSpans(text, forms, carried)) {
		if (from >= cut) break;
		out += text.slice(pos, from) + (carried > 0 && from === 0 ? "" : REDACTED);
		pos = to;
	}
	out += text.slice(pos, Math.max(pos, cut));
	return { out, carried: Math.max(0, Math.max(pos, carried) - cut) };
}

/** Replaces every form of every value with [redacted]; overlapping forms share one marker. */
export function scrubText(text: string, values: readonly string[]): string {
	return redactBefore(text, secretForms(values), text.length, 0).out;
}

export type Scrubber = {
	push(chunk: string): string;
	flush(): string;
};

/** Scrubs a chunked stream; only a tail that could start a secret form is held back until more data or flush, so a split value is caught and a prompt still shows. */
export function createScrubber(values: readonly string[]): Scrubber {
	const forms = secretForms(values);
	const hold = forms.length === 0 ? 0 : forms[0].length - 1;
	let buffer = "";
	let carried = 0;
	return {
		push(chunk) {
			if (forms.length === 0) return chunk;
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
			const result = redactBefore(buffer, forms, cut, carried);
			buffer = buffer.slice(cut);
			carried = result.carried;
			return result.out;
		},
		flush() {
			const rest = redactBefore(buffer, forms, buffer.length, carried).out;
			buffer = "";
			carried = 0;
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
