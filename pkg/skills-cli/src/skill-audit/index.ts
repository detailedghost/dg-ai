import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { type Audit, audit } from "./audit";

export * from "./audit";

/** A directory with its own SKILL.md/skill.md is one skill; otherwise, if it has subdirectories,
 * treat it as a skills root and audit each child — the explicit form of the legacy default scan. */
function expandTarget(t: string): string[] {
	if (existsSync(join(t, "SKILL.md")) || existsSync(join(t, "skill.md"))) return [t];
	try {
		if (!statSync(t).isDirectory()) return [t];
	} catch {
		return [t];
	}
	const children = readdirSync(t)
		.map((d) => join(t, d))
		.filter((d) => {
			try {
				return statSync(d).isDirectory();
			} catch {
				return false;
			}
		});
	return children.length > 0 ? children : [t];
}

const USAGE = [
	"usage: skill-audit <skill-dir...> [--threshold <tokens>] [--json] [--fix]",
	"",
	"  --threshold <tokens>  flag an entry point over this approximate token count (default 1500)",
	"  --json                emit a machine-readable report instead of the text summary",
	"  --fix                 apply mechanical repairs: rename skill.md -> SKILL.md, delete junk files",
].join("\n");

/** Per-dir token-weight and hygiene report. Threshold/json/fix flags match the legacy CLI; targets
 * must be given explicitly (no implicit default directory). */
export function main(argv: string[]): number {
	if (argv.includes("--help") || argv.includes("-h")) {
		process.stdout.write(`${USAGE}\n`);
		return 0;
	}

	const thresholdIdx = argv.indexOf("--threshold");
	const threshold = thresholdIdx >= 0 ? Number(argv[thresholdIdx + 1]) : 1500;
	const asJson = argv.includes("--json");
	const doFix = argv.includes("--fix");
	const positional = argv.filter((a, i) => !a.startsWith("--") && (thresholdIdx < 0 || i !== thresholdIdx + 1));

	if (positional.length === 0) {
		process.stderr.write(`${USAGE}\n`);
		return 2;
	}

	const targets = positional.flatMap(expandTarget);
	const results = targets.map((t) => audit(t, threshold, doFix)).filter((r): r is Audit => r !== null);

	if (asJson) {
		process.stdout.write(`${JSON.stringify({ threshold, results }, null, 2)}\n`);
	} else {
		for (const r of results) {
			const tag = r.vendor ? " [vendor]" : "";
			const entries = r.files.filter((f) => f.isEntryPoint);
			const refs = r.files.filter((f) => !f.isEntryPoint).sort((a, b) => b.tokens - a.tokens);
			const epTok = entries.reduce((s, f) => s + f.tokens, 0);
			const refTok = r.totalTokens - epTok;
			process.stdout.write(`\n## ${r.skill}${tag} — EP ≈${epTok} tok  (+${refTok} on-demand, ${refs.length} refs)\n`);
			for (const e of entries) process.stdout.write(`  entry  ${e.path.padEnd(40)} ≈${e.tokens} tok\n`);
			for (const f of refs.slice(0, 8)) process.stdout.write(`  ref    ${f.path.padEnd(40)} ≈${f.tokens} tok\n`);
			if (refs.length > 8) process.stdout.write(`  …and ${refs.length - 8} smaller reference files\n`);
			for (const fx of r.fixed) process.stdout.write(`  ✔ ${fx}\n`);
			for (const i of r.issues) process.stdout.write(`  ⚠ ${i}\n`);
		}
	}

	return results.some((r) => r.issues.length > 0) ? 1 : 0;
}
