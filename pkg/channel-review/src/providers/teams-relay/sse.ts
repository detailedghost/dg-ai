export type SseFrame = { event?: string; id?: string; data: string };

export const SSE_MAX_CHARS = 1_000_000;

export class SseOverflowError extends Error {
	constructor() {
		super(`an event stream line or event passed ${SSE_MAX_CHARS} characters`);
	}
}

export function createSseParser(): { push(chunk: string): SseFrame[] } {
	let buffer = "";
	let skipLineFeed = false;
	let event: string | undefined;
	let id: string | undefined;
	let data: string[] = [];
	let dispatchable = false;
	let dataChars = 0;

	const field = (line: string): void => {
		if (line.startsWith(":")) return;
		const colon = line.indexOf(":");
		const name = colon === -1 ? line : line.slice(0, colon);
		let value = colon === -1 ? "" : line.slice(colon + 1);
		if (value.startsWith(" ")) value = value.slice(1);
		if (name === "event") {
			event = value;
			dispatchable = true;
		} else if (name === "id") {
			id = value;
		} else if (name === "data") {
			dataChars += value.length;
			if (dataChars > SSE_MAX_CHARS) throw new SseOverflowError();
			data.push(value);
			dispatchable = true;
		}
	};

	return {
		push(chunk) {
			buffer += chunk;
			const frames: SseFrame[] = [];
			let start = 0;
			for (let index = 0; index < buffer.length; index += 1) {
				const char = buffer[index];
				if (skipLineFeed && index === start) {
					skipLineFeed = false;
					if (char === "\n") {
						start += 1;
						continue;
					}
				}
				if (char !== "\n" && char !== "\r") continue;
				const line = buffer.slice(start, index);
				start = index + 1;
				if (char === "\r") {
					if (buffer[start] === "\n") {
						start += 1;
						index += 1;
					} else if (start === buffer.length) {
						skipLineFeed = true;
					}
				}
				if (line !== "") {
					field(line);
					continue;
				}
				if (dispatchable) frames.push({ event, id, data: data.join("\n") });
				event = undefined;
				id = undefined;
				data = [];
				dataChars = 0;
				dispatchable = false;
			}
			buffer = buffer.slice(start);
			if (buffer.length > SSE_MAX_CHARS) throw new SseOverflowError();
			return frames;
		},
	};
}
