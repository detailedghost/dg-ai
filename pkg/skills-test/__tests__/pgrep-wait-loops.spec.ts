import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "./test-support";

const SCANNED = [
	"plugins/dg/skills/**/*.{md,mjs,js,ts,sh}",
	"plugins/dg/agents/**/*.md",
	"pkg/*/src/**/*template*",
	"pkg/*/src/**/templates/**",
	"pkg/launcher/shims/*.sh",
];

const PGREP = /\bpgrep((?:\s+-[A-Za-z]+)+)\s+("[^"]*"|'[^']*'|[^\s;|&)]+)/g;
const WAIT = /\b(while|until)\b|\btail\s+--pid=/;

function bareWaitLoops(text: string): string[] {
	const found: string[] = [];
	const lines = text.split("\n");
	for (const [i, line] of lines.entries()) {
		if (!WAIT.test(lines.slice(Math.max(0, i - 2), i + 1).join("\n"))) continue;
		for (const m of line.matchAll(PGREP)) {
			if (!/f/.test(m[1] ?? "")) continue;
			const pattern = (m[2] ?? "").replace(/^["']|["']$/g, "");
			if (pattern.startsWith("[") || pattern === "<pattern>") continue;
			found.push(line.trim());
		}
	}
	return found;
}

function scannedFiles(): string[] {
	const files = new Set<string>();
	for (const pattern of SCANNED)
		for (const file of new Bun.Glob(pattern).scanSync({ cwd: REPO_ROOT })) files.add(file);
	return [...files].sort();
}

describe("pgrep -f wait loops", () => {
	test("the checker flags a bare pattern and allows a self-excluding one", () => {
		expect(bareWaitLoops('until ! pgrep -f "codex review"; do sleep 5; done')).toHaveLength(1);
		expect(bareWaitLoops("while pgrep -f run-local; do sleep 5; done")).toHaveLength(1);
		expect(bareWaitLoops('tail --pid=$(pgrep -of "bun test") -f /dev/null')).toHaveLength(1);
		expect(bareWaitLoops("until ! pgrep -f '[c]odex review'; do sleep 5; done")).toEqual([]);
		expect(bareWaitLoops('pgrep -f "codex review"')).toEqual([]);
		expect(bareWaitLoops('while true; do\n  pgrep -f "bun test" || break\n  sleep 5\ndone')).toHaveLength(1);
	});

	test("no skill, agent or template tells an agent to wait on a bare pgrep -f pattern", () => {
		const files = scannedFiles();
		expect(files.length).toBeGreaterThan(50);
		const hits = files.flatMap((file) =>
			bareWaitLoops(readFileSync(join(REPO_ROOT, file), "utf8")).map((line) => `${file}: ${line}`),
		);
		expect(hits).toEqual([]);
	});
});
