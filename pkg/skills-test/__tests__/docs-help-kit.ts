import { join } from "node:path";
import { fenceEnv } from "../../skills-cli/__tests__/fence-env";
import { makeTempDir, REPO_ROOT } from "./test-support";

export type HelpRun = { code: number; stdout: string; stderr: string };

const CODE_SPAN = /`([^`\n]+)`/g;
const FENCE = /^(```|~~~)[^\n]*\n([\s\S]*?)^\1[ \t]*$/gm;
const TAIL = "dg ([\\w-]+)([^\\n`&;|)]*)";
const SPAN_FORM = new RegExp("(?<=(?:^|[&|(]|[$>] )[ \\t]*)" + TAIL, "gm");
const FENCE_FORM = new RegExp("(?<=(?:^|[&;|(]|[$>] )[ \\t]*)" + TAIL, "gm");

type Region = { code: string; fenced: boolean };

function regions(text: string): Region[] {
	const fenced = [...text.matchAll(FENCE)].map((m) => ({ code: m[2], fenced: true }));
	const rest = text.replace(FENCE, "\n");
	return [...fenced, ...[...rest.matchAll(CODE_SPAN)].map((m) => ({ code: m[1], fenced: false }))];
}

export function codeRegions(text: string): string[] {
	return regions(text).map((r) => r.code);
}

export function dgCommandForms(text: string): string[][] {
	const forms: string[][] = [];
	for (const { code, fenced } of regions(text))
		for (const m of code.replace(/^[ \t]*dg: .*$/gm, "").matchAll(fenced ? FENCE_FORM : SPAN_FORM)) {
			const words = [m[1], ...m[2].split(/\s+/)].filter(Boolean);
			forms.push(words.map((w) => w.replace(/[.,;:)]+$/, "")));
		}
	return forms;
}

export function dgGroups(text: string): string[] {
	return [...new Set(dgCommandForms(text).map((words) => words[0]))];
}

export async function runDgHelp(words: readonly string[]): Promise<HelpRun> {
	const proc = Bun.spawn([process.execPath, join("pkg", "dg", "src", "index.ts"), ...words, "--help"], {
		cwd: REPO_ROOT,
		env: { ...process.env, ...fenceEnv(), DG_HOME: makeTempDir("dg-docs-help-") },
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { code, stdout, stderr };
}
