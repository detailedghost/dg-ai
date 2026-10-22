/**
 * Normalize a SKILL.md's frontmatter to OpenCode-recognized fields only:
 * `name`, `description`, `license`, `compatibility`, `metadata`.
 */

import { rewriteScratchPaths } from "./scratch-rewrite";

const RECOGNIZED = new Set(["name", "description", "license", "compatibility", "metadata"]);

/** Parse frontmatter via Bun.YAML, falling back to a tolerant line-by-line reader. */
function parseFm(raw: string): Record<string, unknown> {
	try {
		const d = Bun.YAML.parse(raw);
		if (d && typeof d === "object" && !Array.isArray(d)) return d as Record<string, unknown>;
	} catch {}
	const out: Record<string, string> = {};
	const lines = raw.split("\n");
	let i = 0;
	while (i < lines.length) {
		const m = lines[i].match(/^(\w[\w-]*):\s*(.*)/);
		if (!m) {
			i++;
			continue;
		}
		let [, key, val] = m;
		val = val.trim();
		if (!val || val.startsWith(">") || val.startsWith("|")) {
			const parts: string[] = [];
			i++;
			while (i < lines.length && /^[ \t]/.test(lines[i])) {
				parts.push(lines[i].trim());
				i++;
			}
			val = parts.join(" ");
		} else {
			i++;
		}
		if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
			val = val.slice(1, -1);
		}
		out[key] = val;
	}
	return out;
}

/** Emit a YAML scalar, quoting if needed to survive round-trip. */
function safeScalar(v: unknown): string {
	if (typeof v !== "string") return String(v);
	if (/[:{}[\],#&*?|<>=!%@`'"\\]/.test(v) || /^\s|\s$/.test(v) || v === "" || v.includes("\n")) {
		return `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
	}
	return v;
}

export type SkillTransformResult =
	| { ok: true; content: string }
	| { ok: false; message: string };

/** Transform one SKILL.md's text, rewriting scratch paths and dropping unrecognized frontmatter keys. */
export function transformSkillText(text: string, env: NodeJS.ProcessEnv = process.env): SkillTransformResult {
	const rewritten = rewriteScratchPaths(text, env);

	const fmMatch = rewritten.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);
	if (!fmMatch) return { ok: false, message: "no frontmatter" };

	const rawFm = fmMatch[1];
	const body = rewritten.slice(fmMatch[0].length);
	const fm = parseFm(rawFm);

	if (!fm.name || !fm.description) return { ok: false, message: "frontmatter missing name or description" };

	const out: Record<string, unknown> = {};
	for (const k of RECOGNIZED) {
		if (k in fm) out[k] = fm[k];
	}

	const yamlLines: string[] = ["---"];
	for (const [k, v] of Object.entries(out)) {
		yamlLines.push(`${k}: ${safeScalar(v)}`);
	}
	yamlLines.push("---", "");

	return { ok: true, content: yamlLines.join("\n") + body.replace(/^\n+/, "") };
}
