/** Write one pretty-printed JSON value followed by a newline. */
export function emitJson(obj: unknown): void {
	process.stdout.write(JSON.stringify(obj, null, 2) + "\n");
}

/** Read stdin fully and parse JSON; T is a compile-time assertion, not runtime validation. */
export async function readJsonStdin<T = unknown>(): Promise<T> {
	const text = await Bun.stdin.text();
	return JSON.parse(text) as T;
}
