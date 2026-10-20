import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";

const SKIP_DIRS = new Set([
	"node_modules",
	"venv",
	"__pycache__",
	"bin",
	"obj",
	"dist",
	"build",
	"target",
	"vendor",
]);

const KEEP_DOT_DIRS = new Set([".github"]);

/** List files under root, skipping build output and dot-directories except `.github`. */
export function walkFiles(root: string, maxDepth = 6): string[] {
	const out: string[] = [];
	const visit = (dir: string, depth: number) => {
		if (depth > maxDepth) return;
		let entries: string[];
		try {
			entries = readdirSync(dir);
		} catch {
			return;
		}
		for (const entry of entries) {
			const full = join(dir, entry);
			let st: ReturnType<typeof statSync>;
			try {
				st = statSync(full);
			} catch {
				continue;
			}
			if (st.isDirectory()) {
				if (SKIP_DIRS.has(entry)) continue;
				if (entry.startsWith(".") && !KEEP_DOT_DIRS.has(entry)) continue;
				visit(full, depth + 1);
			} else {
				out.push(full);
			}
		}
	};
	visit(root, 0);
	return out;
}

export function readText(path: string): string | null {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return null;
	}
}

export function locate(root: string, path: string, line: number): string {
	return `${relative(root, path) || basename(path)}:${line}`;
}
