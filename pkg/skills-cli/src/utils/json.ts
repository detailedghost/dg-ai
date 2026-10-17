export function emitJson(obj: unknown): void {
	process.stdout.write(JSON.stringify(obj, null, 2) + "\n");
}

export async function readJsonStdin<T = unknown>(): Promise<T> {
	const text = await Bun.stdin.text();
	return JSON.parse(text) as T;
}

export function escapeJsonString(s: string): string {
	let out = "";
	for (let i = 0; i < s.length; i++) {
		const code = s.charCodeAt(i);
		if (code === 0x5c) {
			out += "\\\\";
		} else if (code === 0x22) {
			out += '\\"';
		} else if (code === 0x0a) {
			out += "\\n";
		} else if (code === 0x0d) {
			out += "\\r";
		} else if (code === 0x09) {
			out += "\\t";
		} else if (code < 0x20) {
			out += `\\u${code.toString(16).padStart(4, "0")}`;
		} else {
			out += s[i];
		}
	}
	return out;
}
