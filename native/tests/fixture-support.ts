import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface FixtureEmitter {
	emit(name: string, text: string): void;
	finish(hint: string): void;
}

export function createEmitter(dir: string, check: boolean, owned: (name: string) => boolean): FixtureEmitter {
	const written = new Set<string>();
	const stale: string[] = [];
	return {
		emit(name, text) {
			written.add(name);
			const file = join(dir, name);
			if (!check) {
				writeFileSync(file, text);
				return;
			}
			let current = "";
			try {
				current = readFileSync(file, "utf8");
			} catch {}
			if (current !== text) stale.push(name);
		},
		finish(hint) {
			for (const name of readdirSync(dir).filter(owned)) {
				if (written.has(name)) continue;
				if (check) stale.push(`${name} (orphan)`);
				else rmSync(join(dir, name));
			}
			if (check && stale.length) {
				console.error(`stale fixtures: ${stale.join(", ")}; ${hint}`);
				process.exit(1);
			}
		},
	};
}
