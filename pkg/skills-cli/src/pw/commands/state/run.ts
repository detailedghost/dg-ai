import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { scratchRoot } from "@dg/common/node";
import { UsageError } from "../../core/args";
import { resolve } from "../../core/registry";
import { call } from "../../core/socket";
import type { ClientEnv, ClientHandler, ParsedArgs } from "../../core/spec";
import { restoreState } from "../../core/state-restore";
import {
	formatSummary,
	importFile,
	importLegacyOnce,
	list,
	load,
	parseStorageState,
	remove,
	save,
	validateName,
} from "../../core/states";

const SUBCOMMANDS = ["save", "load", "list", "delete", "import"] as const;
type Subcommand = (typeof SUBCOMMANDS)[number];

const ARITY: Record<Subcommand, { min: number; max: number; usage: string }> = {
	save: { min: 1, max: 1, usage: "pw state save <name>" },
	load: { min: 1, max: 1, usage: "pw state load <name>" },
	list: { min: 0, max: 0, usage: "pw state list" },
	delete: { min: 1, max: 1, usage: "pw state delete <name>" },
	import: { min: 1, max: 2, usage: "pw state import <file> [name]" },
};

const notOpen = (session: string): string => `Browser '${session}' is not open. Run: pw open`;

function parseSubcommand(args: ParsedArgs): { sub: Subcommand; rest: string[] } {
	const [word, ...rest] = args.positionals;
	const sub = SUBCOMMANDS.find((candidate) => candidate === word);
	if (!sub) throw new UsageError(`Unknown state subcommand '${word ?? ""}': use ${SUBCOMMANDS.join(", ")}`);
	const { min, max, usage } = ARITY[sub];
	if (rest.length < min || rest.length > max) throw new UsageError(`Usage: ${usage}`);
	return { sub, rest };
}

async function saveSession(args: ParsedArgs, env: ClientEnv, name: string): Promise<number> {
	const record = resolve(args.session);
	if (!record) {
		env.err(notOpen(args.session));
		return 1;
	}
	const root = path.join(scratchRoot(), "pw");
	mkdirSync(root, { recursive: true, mode: 0o700 });
	const dir = mkdtempSync(path.join(root, "state-"));
	const file = path.join(dir, "state.json");
	try {
		const response = await call(record, {
			id: "state-save",
			method: "run",
			params: { argv: ["state-save", file], cwd: env.cwd, raw: true },
		});
		if ("error" in response || response.result.exitCode !== 0) {
			env.err("error" in response ? response.error : response.result.text);
			return 1;
		}
		const state = parseStorageState(readFileSync(file, "utf8"), file);
		save(name, state);
		env.out(`Saved state '${name}' (${state.cookies?.length ?? 0} cookies, ${state.origins?.length ?? 0} origins).`);
		return 0;
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

async function loadSession(args: ParsedArgs, env: ClientEnv, name: string): Promise<number> {
	const state = load(name);
	const record = resolve(args.session);
	if (!record) {
		env.err(notOpen(args.session));
		return 1;
	}
	return restoreState(record, name, state, env);
}

function run(sub: Subcommand, rest: string[], args: ParsedArgs, env: ClientEnv): Promise<number> | number {
	const [first = "", second] = rest;
	switch (sub) {
		case "save":
			return saveSession(args, env, first);
		case "load":
			return loadSession(args, env, first);
		case "list": {
			const summaries = list();
			if (summaries.length === 0) env.out("(no saved states) — run: pw state save <name>");
			else env.out(summaries.map(formatSummary).join("\n"));
			return 0;
		}
		case "delete":
			remove(first);
			env.out(`Deleted state '${first}'.`);
			return 0;
		case "import": {
			const name = importFile(path.resolve(env.cwd, first), second);
			env.out(`Imported state '${name}'.`);
			return 0;
		}
	}
}

const state: ClientHandler = async (args, env) => {
	const { sub, rest } = parseSubcommand(args);
	const [first, second] = rest;
	if (sub !== "import" && sub !== "list") validateName(first as string);
	if (sub === "import" && second !== undefined) validateName(second);
	try {
		importLegacyOnce(env.out);
		return await run(sub, rest, args, env);
	} catch (error) {
		if (error instanceof UsageError) throw error;
		env.err(error instanceof Error ? error.message : String(error));
		return 1;
	}
};

export default state;
