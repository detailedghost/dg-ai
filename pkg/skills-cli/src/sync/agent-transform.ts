/**
 * Transform a Claude-format subagent file into OpenCode or Copilot format.
 * Pure function: callers own file I/O and surface `TransformError.code` as needed.
 */

import * as path from "node:path";
import { rewriteScratchPaths } from "./scratch-rewrite";

const COLOR_MAP: Record<string, string> = {
	red: "error",
	orange: "warning",
	yellow: "warning",
	green: "success",
	cyan: "info",
	blue: "info",
	purple: "accent",
	pink: "accent",
	gray: "secondary",
	grey: "secondary",
	white: "secondary",
	black: "primary",
};

/** Canonical model IDs — single source of truth for both targets. */
const MODEL_MAP: Record<string, string> = {
	opus: "claude-opus-4-8",
	sonnet: "claude-sonnet-4-6",
	haiku: "claude-haiku-4-5",
	inherit: "",
};

const TOOL_TO_PERMISSION: Record<string, string> = {
	read: "read",
	write: "edit",
	edit: "edit",
	glob: "glob",
	grep: "grep",
	list: "list",
	bash: "bash",
	task: "task",
	webfetch: "webfetch",
	websearch: "websearch",
	todowrite: "todowrite",
	todoread: "todowrite",
	lsp: "lsp",
	skill: "skill",
};

const THEME_TOKENS = new Set(["primary", "secondary", "accent", "success", "warning", "error", "info"]);
const FRONTMATTER_RE = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)([\s\S]*)$/;

export type AgentTransformTarget = "opencode" | "copilot";

export interface AgentTransformOk {
	ok: true;
	filename: string;
	content: string;
}

export interface AgentTransformErr {
	ok: false;
	/** 2 = YAML parse error, 3 = path-traversal guard (CWE-22). */
	code: 2 | 3;
	message: string;
}

export type AgentTransformResult = AgentTransformOk | AgentTransformErr;

/** Quote bare `#rrggbb` hex values so Bun.YAML doesn't treat them as comments. */
function quoteUnquotedHex(yaml: string): string {
	return yaml.replace(/^(\s*\w[\w-]*\s*:\s*)(#[0-9a-fA-F]{3,6})\s*$/gm, '$1"$2"');
}

function parseSimpleYamlScalar(value: string): unknown {
	const v = value.trim();
	if (!v) return "";
	if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
		if (v.startsWith('"')) {
			try {
				return JSON.parse(v);
			} catch {
				return v.slice(1, -1);
			}
		}
		return v.slice(1, -1).replace(/''/g, "'");
	}
	if (v === "true") return true;
	if (v === "false") return false;
	if (v === "null" || v === "~") return null;
	if (/^[+-]?\d+(?:\.\d+)?$/.test(v)) return Number(v);
	if (v.startsWith("[") && v.endsWith("]")) {
		const inner = v.slice(1, -1).trim();
		return inner ? inner.split(",").map((part) => parseSimpleYamlScalar(part)) : [];
	}
	return v;
}

function parseYamlMapping(yaml: string): Record<string, unknown> {
	const bunYaml = (Bun as unknown as { YAML?: { parse?: (input: string) => unknown } }).YAML;
	if (typeof bunYaml?.parse === "function") {
		const parsed = bunYaml.parse(yaml);
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
			throw new Error(`frontmatter is not a mapping: ${typeof parsed}`);
		return parsed as Record<string, unknown>;
	}

	const out: Record<string, unknown> = {};
	for (const rawLine of yaml.split(/\r?\n/)) {
		if (!rawLine.trim() || rawLine.trimStart().startsWith("#")) continue;
		const match = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(rawLine);
		if (!match) throw new Error(`unsupported YAML frontmatter line: ${rawLine}`);
		out[match[1]] = parseSimpleYamlScalar(match[2]);
	}
	return out;
}

function splitFrontmatter(text: string): { fm: Record<string, unknown>; body: string } {
	const m = FRONTMATTER_RE.exec(text);
	if (!m) throw new Error("file does not start with YAML frontmatter");
	return { fm: parseYamlMapping(quoteUnquotedHex(m[1])), body: m[2] };
}

function translateColor(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const v = value.trim().toLowerCase();
	if (!v) return null;
	if (v.startsWith("#") && (v.length === 4 || v.length === 7)) return v;
	if (THEME_TOKENS.has(v)) return v;
	return COLOR_MAP[v] ?? null;
}

function translateTools(tools: unknown): Record<string, string> | null {
	let items: Record<string, unknown>;
	if (typeof tools === "string") {
		items = Object.fromEntries(
			tools
				.split(",")
				.filter((t) => t.trim())
				.map((t) => [t.trim(), true]),
		);
	} else if (Array.isArray(tools)) {
		items = Object.fromEntries(tools.map((t) => [String(t).trim(), true]).filter(([k]) => k));
	} else if (tools && typeof tools === "object") {
		items = tools as Record<string, unknown>;
	} else {
		return null;
	}

	const perm: Record<string, string> = {};
	for (const [key, val] of Object.entries(items)) {
		const mapped = TOOL_TO_PERMISSION[key.toLowerCase()];
		if (mapped == null) continue;
		const action = val ? "allow" : "deny";
		if (perm[mapped] === "allow") continue;
		perm[mapped] = action;
	}
	return Object.keys(perm).length > 0 ? perm : null;
}

/** A value containing `/` is already fully qualified: pass through for opencode, strip `anthropic/` for copilot. */
function translateModel(value: unknown, target: AgentTransformTarget): string | null {
	if (typeof value !== "string") return null;
	const v = value.trim();
	if (!v) return null;
	if (v.includes("/")) {
		if (target === "copilot") return v.replace(/^anthropic\//, "");
		return v;
	}
	const bare = MODEL_MAP[v.toLowerCase()];
	if (bare == null || bare === "") return null;
	return target === "opencode" ? `anthropic/${bare}` : bare;
}

function transformOpencode(
	fm: Record<string, unknown>,
	body: string,
): { name: string; outFm: Record<string, unknown>; outBody: string } {
	const name = fm.name;
	if (typeof name !== "string" || !name.trim()) throw new Error("frontmatter missing required `name` field");
	const description = fm.description;
	if (typeof description !== "string" || !description.trim())
		throw new Error("frontmatter missing required `description` field");

	const out: Record<string, unknown> = {
		description: description.trim(),
		mode: fm.mode ?? "subagent",
	};
	const color = translateColor(fm.color);
	if (color) out.color = color;
	const model = translateModel(fm.model, "opencode");
	if (model) out.model = model;
	const perm = translateTools(fm.tools);
	if (perm) out.permission = perm;

	for (const key of ["temperature", "top_p", "hidden"] as const) {
		if (key in fm && !(key in out)) out[key] = fm[key];
	}

	return { name: name.trim(), outFm: out, outBody: body };
}

function transformCopilot(
	fm: Record<string, unknown>,
	body: string,
	/** Fallback name derived from source filename when frontmatter has no name field. */
	fileBasename = "",
): { name: string; outFm: Record<string, unknown>; outBody: string } {
	const rawName = fm.name;
	const name = typeof rawName === "string" && rawName.trim() ? rawName.trim() : fileBasename;
	const description =
		typeof fm.description === "string" && fm.description.trim()
			? fm.description.trim()
			: `${name || "agent"} custom agent`;

	const out: Record<string, unknown> = { name, description };

	const model = translateModel(fm.model, "copilot");
	if (model) out.model = model;

	const normalizedBody = body.replace(/^\n+/, "").trimEnd() || `You are ${name}.`;

	return { name, outFm: out, outBody: normalizedBody };
}

/**
 * Serialize a scalar for block YAML. Double-quotes any string that isn't plain-safe:
 * contains `: `, leading `#`/`-`/`?`/`*`/`&`/`!`/`@`/backtick, leading/trailing
 * whitespace, looks like a bool/null/number, or contains `"` or `\`.
 */
function yamlScalar(v: unknown): string {
	if (typeof v === "boolean" || typeof v === "number") return String(v);
	if (typeof v !== "string") return JSON.stringify(v);

	const UNSAFE_LEAD = /^[\s#\-?*&!@`]/;
	const PLAIN_UNSAFE =
		UNSAFE_LEAD.test(v) ||
		/:\s/.test(v) ||
		/\s$/.test(v) ||
		/^(true|false|null|~|yes|no|on|off)$/i.test(v) ||
		/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(v) ||
		/^0x[0-9a-fA-F]+$/.test(v) ||
		v === "" ||
		v.includes('"') ||
		v.includes("\\") ||
		v.includes("\n");

	if (!PLAIN_UNSAFE) return v;
	return `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
}

/** Emit block-style YAML for a flat object (values are scalars or one-level-deep objects). */
function blockYaml(fm: Record<string, unknown>): string {
	const lines: string[] = [];
	for (const [k, v] of Object.entries(fm)) {
		if (v !== null && typeof v === "object" && !Array.isArray(v)) {
			lines.push(`${k}:`);
			for (const [sk, sv] of Object.entries(v as Record<string, unknown>)) {
				lines.push(`  ${sk}: ${yamlScalar(sv)}`);
			}
		} else {
			lines.push(`${k}: ${yamlScalar(v)}`);
		}
	}
	return lines.join("\n");
}

function emitOpencode(fm: Record<string, unknown>, body: string): string {
	const yamlText = blockYaml(fm);
	return `---\n${yamlText}\n---\n\n${body.replace(/^\n+/, "")}`;
}

function emitCopilot(fm: Record<string, unknown>, body: string): string {
	const lines: string[] = ["---"];
	for (const [k, v] of Object.entries(fm)) {
		lines.push(`${k}: ${JSON.stringify(v)}`);
	}
	lines.push("---", "", body);
	return `${lines.join("\n").trimEnd()}\n`;
}

/** Path-traversal guard (CWE-22) for a frontmatter `name` field used as a filename stem. */
function checkTraversal(name: string): void {
	const safeName = path.basename(name);
	if ((name.includes("/") || name.startsWith(".")) && name !== safeName) {
		throw Object.assign(new Error(`path traversal in name field: ${JSON.stringify(name)}`), { code: 3 });
	}
}

/**
 * Transform one Claude agent file's text into the target tool's format.
 * `fileBasename` (the source filename stem) is the Copilot fallback name
 * when frontmatter has no `name` field.
 */
export function transformAgentText(
	text: string,
	target: AgentTransformTarget,
	fileBasename: string,
): AgentTransformResult {
	let fm: Record<string, unknown>;
	let body: string;
	try {
		({ fm, body } = splitFrontmatter(text));
	} catch (e: unknown) {
		if (target === "copilot") {
			fm = {};
			body = text;
		} else {
			return { ok: false, code: 2, message: (e as Error).message };
		}
	}

	let name: string;
	let outFm: Record<string, unknown>;
	let outBody: string;
	try {
		if (target === "copilot") {
			({ name, outFm, outBody } = transformCopilot(fm, body, fileBasename));
		} else {
			({ name, outFm, outBody } = transformOpencode(fm, body));
		}
		outBody = rewriteScratchPaths(outBody);
	} catch (e: unknown) {
		const err = e as { code?: number; message: string };
		if (err.code === 3) return { ok: false, code: 3, message: err.message };
		return { ok: false, code: 2, message: err.message };
	}

	try {
		checkTraversal(name);
	} catch (e: unknown) {
		return { ok: false, code: 3, message: (e as Error).message };
	}

	const ext = target === "copilot" ? ".agent.md" : ".md";
	const filename = `${path.basename(name)}${ext}`;
	const content = target === "copilot" ? emitCopilot(outFm, outBody) : emitOpencode(outFm, outBody);
	return { ok: true, filename, content };
}
