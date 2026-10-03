import { existsSync } from "node:fs";
import { getStringFlag } from "../../cli/args";
import type { CliContext } from "../../cli/context";
import { printJson } from "../../cli/output";

type SliceValidation = {
	id?: string;
	name?: string;
	hasAgents: boolean;
	primary?: string;
	qa: string[];
};

const knownAgents = new Set([
	"arch",
	"checkpoint",
	"copilot-antagonist",
	"csharp",
	"dba",
	"design",
	"devops",
	"js",
	"lore",
	"python",
	"qa-code",
	"qa-devops",
	"qa-perf",
	"qa-writer",
	"reviewer",
	"security",
	"shell",
	"spec-writer",
	"wave",
]);

export async function validateSpecCommand(context: CliContext): Promise<void> {
	const specPath = getStringFlag(
		context.args.flags,
		"spec-path",
		context.args.rest[0],
	);
	if (!specPath) {
		throw new Error("validate spec requires --spec-path <path>");
	}
	if (!existsSync(specPath)) {
		throw new Error(`Spec file not found: ${specPath}`);
	}
	const text = await Bun.file(specPath).text();
	const frontmatter = extractFrontmatter(text, specPath);
	const slices = parseSlices(frontmatter);
	const errors: string[] = [];
	if (!/^id:\s*\S+/m.test(frontmatter)) {
		errors.push("frontmatter.id is required");
	}
	if (!/^status:\s*\S+/m.test(frontmatter)) {
		errors.push("frontmatter.status is required");
	}
	if (slices.length === 0) {
		errors.push("frontmatter.slices must contain at least one slice");
	}
	for (const [index, slice] of slices.entries()) {
		const label = slice.id ?? slice.name ?? `slice[${index}]`;
		if (!slice.id) {
			errors.push(`${label}: id is required`);
		}
		if (!slice.name) {
			errors.push(`${label}: name is required`);
		}
		if (!slice.hasAgents || !slice.primary) {
			errors.push(`${label}: agents.primary is required`);
		}
		if (slice.primary && !knownAgents.has(slice.primary)) {
			errors.push(`${label}: unknown primary agent ${slice.primary}`);
		}
		for (const agent of slice.qa) {
			if (!knownAgents.has(agent)) {
				errors.push(`${label}: unknown qa agent ${agent}`);
			}
		}
	}
	const summary = {
		kind: "spec-validation-summary",
		specPath,
		valid: errors.length === 0,
		slices: slices.length,
		errors,
	};
	printJson(summary);
	if (errors.length > 0) {
		throw new Error(`Spec validation failed with ${errors.length} error(s)`);
	}
}

function extractFrontmatter(text: string, specPath: string): string {
	const match = /^---\n([\s\S]*?)\n---/.exec(text);
	if (!match) {
		throw new Error(`Spec frontmatter not found: ${specPath}`);
	}
	return match[1] ?? "";
}

function parseSlices(frontmatter: string): SliceValidation[] {
	const lines = frontmatter.split("\n");
	const slices: SliceValidation[] = [];
	let inSlices = false;
	let current: SliceValidation | undefined;
	let inAgents = false;

	for (const line of lines) {
		if (/^slices:\s*$/.test(line)) {
			inSlices = true;
			continue;
		}
		if (!inSlices) {
			continue;
		}
		if (/^\S/.test(line) && !/^slices:\s*$/.test(line)) {
			break;
		}
		const sliceStart = /^\s{2}-\s+id:\s*(.+?)\s*$/.exec(line);
		if (sliceStart) {
			current = { id: unquote(sliceStart[1] ?? ""), hasAgents: false, qa: [] };
			slices.push(current);
			inAgents = false;
			continue;
		}
		if (!current) {
			continue;
		}
		const name = /^\s{4}name:\s*(.+?)\s*$/.exec(line);
		if (name) {
			current.name = unquote(name[1] ?? "");
			continue;
		}
		if (/^\s{4}agents:\s*$/.test(line)) {
			current.hasAgents = true;
			inAgents = true;
			continue;
		}
		if (inAgents) {
			const primary = /^\s{6}primary:\s*(.+?)\s*$/.exec(line);
			if (primary) {
				current.primary = unquote(primary[1] ?? "");
				continue;
			}
			const qa = /^\s{6}qa:\s*\[(.*?)\]\s*$/.exec(line);
			if (qa) {
				current.qa = (qa[1] ?? "")
					.split(",")
					.map((value) => unquote(value.trim()))
					.filter(Boolean);
			}
		}
	}
	return slices;
}

function unquote(value: string): string {
	return value.replace(/^["']|["']$/g, "").trim();
}
