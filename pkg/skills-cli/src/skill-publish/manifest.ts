import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { resolveSkillAsset } from "../utils/skill-assets";
import type { Manifest, ToolSpec } from "./types";

export function introspectTools(absPath: string): ToolSpec[] {
	const content = readFileSync(absPath, "utf-8");
	const commandsMatch = content.match(/const\s+COMMANDS\s*[=:][^{]*\{([\s\S]*?)^}/m);
	const tools: ToolSpec[] = [];

	if (commandsMatch) {
		const body = commandsMatch[1];
		const entries = body.match(/(\w[\w-]*)\s*:/g) ?? [];
		for (const entry of entries) {
			const name = entry.replace(/\s*:/, "").trim();
			if (name && name !== "args" && name !== "summary" && name !== "run") {
				const summaryMatch = body.match(new RegExp(`${name}[^}]*summary\\s*:\\s*["'\`]([^"'\`]+)`));
				const summary = summaryMatch ? summaryMatch[1] : `Run ${name}`;
				tools.push({
					name,
					description: summary,
					inputSchema: { type: "object", properties: {}, required: [] },
				});
			}
		}
	}

	if (tools.length === 0) {
		tools.push({
			name: "run",
			description: "Run the tool",
			inputSchema: {
				type: "object",
				properties: { args: { type: "array", items: { type: "string" } } },
				required: [],
			},
		});
	}

	return tools;
}

export function cmdManifestDraft(args: string[]): number {
	let cliPath = "";
	let outDir = "";
	for (let i = 0; i < args.length; i++) {
		if (args[i] === "--out" && i + 1 < args.length) outDir = args[++i];
		else if (!args[i].startsWith("-")) cliPath = args[i];
	}

	if (!cliPath) {
		process.stderr.write("Usage: skill-publish manifest draft <cli-path> [--out <dir>]\n");
		return 1;
	}

	const absPath = resolve(cliPath);
	if (!existsSync(absPath)) {
		process.stderr.write(`File not found: ${absPath}\n`);
		return 1;
	}

	const name = basename(absPath, extname(absPath))
		.replace(/[^a-z0-9-]/g, "-")
		.toLowerCase();
	const tools = introspectTools(absPath);
	const targetDir = outDir ? resolve(outDir) : dirname(absPath);
	mkdirSync(targetDir, { recursive: true });

	const manifest: Manifest = {
		name,
		version: "0.1.0",
		description: `MCP server wrapping ${name}`,
		recipe: `Use this server's tools to interact with ${name}. Call the appropriate tool with the required arguments.`,
		tools,
	};

	const outPath = join(targetDir, `${name}.publish.json`);
	writeFileSync(outPath, JSON.stringify(manifest, null, 2));
	process.stdout.write(`${outPath}\n`);
	process.stderr.write(`Manifest drafted at ${outPath}\nPlease review and edit before proceeding.\n`);
	return 0;
}

let _schemaCache: Record<string, unknown> | null = null;

/** manifest.schema.json lives in the owning installed skill, never a hardcoded local path. */
function loadSchema(): Record<string, unknown> | null {
	if (_schemaCache) return _schemaCache;
	const path = resolveSkillAsset("skill-publish", "references/manifest.schema.json");
	_schemaCache = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
	return _schemaCache;
}

export async function ajvValidate(manifest: Record<string, unknown>, schema: Record<string, unknown>): Promise<string[]> {
	try {
		const { default: Ajv } = await import("ajv");
		const ajv = new Ajv({ allErrors: true });
		const validate = ajv.compile(schema);
		const valid = validate(manifest);
		if (!valid && validate.errors) {
			return validate.errors.map((e) => `Schema error at ${e.instancePath || "/"}: ${e.message}`);
		}
		return [];
	} catch (e) {
		return [`AJV validation failed: ${e}`];
	}
}

export async function validateWithAjv(manifest: Record<string, unknown>): Promise<string[]> {
	let schema: Record<string, unknown> | null;
	try {
		schema = loadSchema();
	} catch (e) {
		return [e instanceof Error ? e.message : String(e)];
	}
	if (!schema) return ["Schema not found"];
	return ajvValidate(manifest, schema);
}

export async function cmdManifestValidate(args: string[]): Promise<number> {
	const manifestPath = args[0];
	if (!manifestPath) {
		process.stderr.write("Usage: skill-publish manifest validate <manifest-path>\n");
		return 1;
	}

	const absPath = resolve(manifestPath);
	if (!existsSync(absPath)) {
		process.stderr.write(`File not found: ${absPath}\n`);
		return 1;
	}

	let manifest: Record<string, unknown>;
	try {
		manifest = JSON.parse(readFileSync(absPath, "utf-8")) as Record<string, unknown>;
	} catch (e) {
		process.stderr.write(`Invalid JSON: ${e}\n`);
		return 1;
	}

	const errors: string[] = [];
	errors.push(...(await validateWithAjv(manifest)));

	const serverName = manifest.name as string | undefined;
	const tools = (manifest.tools ?? []) as ToolSpec[];
	if (serverName) {
		const reservedName = `${serverName}_guide`;
		const collision = tools.find((t) => t.name === reservedName);
		if (collision) {
			errors.push(`Name collision: tool "${reservedName}" is reserved for the synthetic guide tool. Rename it.`);
		}
	}

	for (const tool of tools) {
		if (tool.long_running && !tool.resume_contract) {
			errors.push(`Tool "${tool.name}" has long_running:true but is missing required resume_contract field.`);
		}
	}

	if (errors.length > 0) {
		process.stderr.write(`${errors.join("\n")}\n`);
		return 1;
	}
	return 0;
}
