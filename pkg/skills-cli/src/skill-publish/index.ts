import { cmdAnalyze } from "./analyze";
import { cmdGenerate } from "./generate";
import { cmdManifestDraft, cmdManifestValidate } from "./manifest";
import { cmdPluginDraft, cmdPluginGenerate, cmdPluginValidate } from "./plugin";

export * from "./analyze";
export * from "./checkout";
export * from "./generate";
export * from "./manifest";
export * from "./plugin";
export * from "./types";

type Runner = (args: string[]) => number | Promise<number>;

const COMMANDS: Record<string, { args: string; summary: string; run: Runner }> = {
	analyze: {
		args: "<cli-path>",
		summary: "Phase 0: readiness check — detect Bun-TS / native-addon / non-publishable",
		run: cmdAnalyze,
	},
	manifest: {
		args: "draft|validate <path> [--out <dir>]",
		summary: "Phase 1: draft or validate the two-zoned manifest",
		run: (args) => {
			const sub = args[0];
			if (sub === "draft") return cmdManifestDraft(args.slice(1));
			if (sub === "validate") return cmdManifestValidate(args.slice(1));
			process.stderr.write("Usage: skill-publish manifest draft|validate <path>\n");
			return 1;
		},
	},
	generate: {
		args: "<manifest-path> [--out-dir <dir>] [--repo-owner <owner>]",
		summary: "Phase 2: deterministic codegen of a stdio MCP server",
		run: cmdGenerate,
	},
	plugin: {
		args: "draft <name> --skill <slug>... | validate <manifest> | generate <manifest> [--root <plugins/dg>]",
		summary: "Package skills into the dg plugin's canonical skills tree: draft, validate, or generate",
		run: (args) => {
			const sub = args[0];
			if (sub === "draft") return cmdPluginDraft(args.slice(1));
			if (sub === "validate") return cmdPluginValidate(args.slice(1));
			if (sub === "generate") return cmdPluginGenerate(args.slice(1));
			process.stderr.write("Usage: skill-publish plugin draft|validate|generate ...\n");
			return 1;
		},
	},
};

function usage(): string {
	const lines = ["skill-publish — package a Bun-TS CLI as an MCP server, or bundle skills into the dg plugin", "Usage:"];
	for (const [name, spec] of Object.entries(COMMANDS)) {
		lines.push(`  skill-publish ${name} ${spec.args}`);
		lines.push(`      ${spec.summary}`);
	}
	return lines.join("\n");
}

export async function main(argv: string[]): Promise<number> {
	const [cmd, ...rest] = argv;
	if (!cmd || cmd === "--help" || cmd === "-h") {
		if (!cmd) {
			process.stderr.write(`${usage()}\n`);
			return 1;
		}
		process.stdout.write(`${usage()}\n`);
		return 0;
	}

	const command = COMMANDS[cmd];
	if (!command) {
		process.stderr.write(`Unknown command: ${cmd}\nUsage: skill-publish --help\n`);
		return 1;
	}

	try {
		return await command.run(rest);
	} catch (err) {
		process.stderr.write(`${cmd} failed: ${err instanceof Error ? err.message : String(err)}\n`);
		return 1;
	}
}
