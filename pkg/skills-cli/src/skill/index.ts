import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type Audit, audit, formatAudit } from "./audit";
import { applyManifest, listSections, SplitError } from "./split";

export { audit, backReferencedHeadings, brokenLinks, isPipelineShaped } from "./audit";
export { applyManifest, detectDanglingReferences, findExistingRouter, listSections, parseSections } from "./split";

export const USAGE = `Usage: skill <audit|split> ...

  skill audit [skill-dir ...] [--threshold <tokens>] [--json] [--fix]
      Token weight and hygiene report. With no dirs, audits every skill under
      the user's Claude skills directory. Flags oversized entry files, a
      lowercase skill.md, junk files, broken relative .md links, and long
      frontmatter descriptions. --fix renames skill.md to SKILL.md and deletes
      junk files. Exit 1 while any issue remains.

  skill split --list <skill-dir> [--entry <file>]
      Print the entry's H2 sections as JSON.

  skill split --apply <manifest.json>
      Move sections verbatim into reference files. Manifest:
      {"skillDir": "...", "entry": "SKILL.md", "moves": [{"slug": "...", "dest": "references/x.md"}]}
      Backs up the skill dir under the AI state root at
      skill-cleanup/backups/<name>-<epoch>/ first. Exit 2 on a bad manifest.
`;

function defaultTargets(): string[] {
	const root = join(homedir(), ".claude", "skills");
	return readdirSync(root)
		.map((d) => join(root, d))
		.filter((d) => statSync(d).isDirectory());
}

function runAudit(args: string[]): number {
	const thresholdIdx = args.indexOf("--threshold");
	const threshold = thresholdIdx >= 0 ? Number(args[thresholdIdx + 1]) : 1500;
	const doFix = args.includes("--fix");
	const positional = args.filter((a, i) => !a.startsWith("--") && (thresholdIdx < 0 || i !== thresholdIdx + 1));
	const targets = positional.length > 0 ? positional : defaultTargets();
	const results: Audit[] = [];
	const failed: { target: string; error: string }[] = [];
	for (const t of targets) {
		try {
			const r = audit(t, threshold, doFix);
			if (r) results.push(r);
		} catch (error) {
			failed.push({ target: t, error: error instanceof Error ? error.message : String(error) });
		}
	}
	for (const f of failed) process.stderr.write(`skill audit: cannot read ${f.target}: ${f.error}\n`);
	if (args.includes("--json")) process.stdout.write(`${JSON.stringify({ threshold, results, failed }, null, 2)}\n`);
	else for (const r of results) process.stdout.write(`${formatAudit(r).join("\n")}\n`);
	return failed.length > 0 || results.some((r) => r.issues.length > 0) ? 1 : 0;
}

function runSplit(args: string[]): number {
	const [mode, target] = args;
	try {
		if (mode === "--list" && target) {
			const entryIdx = args.indexOf("--entry");
			const result = listSections(target, entryIdx !== -1 ? args[entryIdx + 1] : undefined);
			process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
			return 0;
		}
		if (mode === "--apply" && target) {
			const result = applyManifest(target);
			for (const w of result.warnings) process.stderr.write(`⚠ ${w}\n`);
			process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
			return 0;
		}
	} catch (error) {
		if (!(error instanceof SplitError)) throw error;
		process.stderr.write(`skill split: ${error.message}\n`);
		return 2;
	}
	process.stderr.write(USAGE);
	return 2;
}

export function main(argv: string[]): number {
	const [sub, ...rest] = argv;
	if (sub === "audit") return runAudit(rest);
	if (sub === "split") return runSplit(rest);
	if (sub === "--help" || sub === "-h") {
		process.stdout.write(USAGE);
		return 0;
	}
	process.stderr.write(USAGE);
	return 2;
}
