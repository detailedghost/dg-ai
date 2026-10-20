export function die(msg: string): never {
	process.stderr.write(`dg-skills viz: ${msg}\n`);
	process.exit(1);
}

export function note(msg: string): void {
	process.stderr.write(`[viz] ${msg}\n`);
}
