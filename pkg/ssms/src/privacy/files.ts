import { chmodSync, mkdirSync, writeFileSync } from "node:fs";

export function writePrivateFile(dir: string, path: string, text: string): void {
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	chmodSync(dir, 0o700);
	writeFileSync(path, text, { mode: 0o600 });
	chmodSync(path, 0o600);
}
