import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Read YAML frontmatter from a plan or bundle directory; absent assignment returns null, invalid plans throw. */
export function resolveSlicePrimary(spec: string, slice: string): string | null {
	let file = resolve(spec);
	if (existsSync(file) && statSync(file).isDirectory()) file = join(file, "plan.md");
	let raw: string;
	try { raw = readFileSync(file, "utf8"); }
	catch (error) { throw new Error(`Failed to read spec ${spec}: ${error instanceof Error ? error.message : error}`); }
	const frontmatter = raw.replace(/^\uFEFF/, "").match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
	if (!frontmatter) throw new Error(`Spec has no YAML frontmatter: ${spec}`);
	let parsed: unknown;
	try { parsed = Bun.YAML.parse(frontmatter[1]); }
	catch (error) { throw new Error(`Invalid spec frontmatter in ${spec}: ${error instanceof Error ? error.message : error}`); }
	if (!record(parsed) || !Array.isArray(parsed.slices)) throw new Error(`Spec has no slices: ${spec}`);
	const found: unknown = parsed.slices.find((value: unknown) => record(value) && (typeof value.id === "string" || typeof value.id === "number") && String(value.id) === slice);
	if (!record(found)) throw new Error(`Slice not found in ${spec}: ${slice}`);
	if (!record(found.agents) || found.agents.primary == null || found.agents.primary === "") return null;
	if (typeof found.agents.primary !== "string") throw new Error(`Invalid primary agent for slice ${slice} in ${spec}`);
	return found.agents.primary;
}
