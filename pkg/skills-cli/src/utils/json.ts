/** Write one pretty-printed JSON value followed by a newline. */
export function emitJson(obj: unknown): void {
	process.stdout.write(`${JSON.stringify(obj, null, 2)}\n`);
}
