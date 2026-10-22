import { homedir } from "node:os";
import type { Command } from "commander";
import { registerRawCommand } from "../utils/legacy-command";
import { claudeTarget } from "./claude";
import { codexTarget } from "./codex";
import { copilotTarget } from "./copilot";
import { grokTarget } from "./grok";
import { opencodeTarget } from "./opencode";
import { piTarget } from "./pi";
import { SYNC_MODES, SYNC_TARGET_IDS } from "./types";
import type { SyncContext, SyncMode, SyncTarget, SyncTargetId } from "./types";

const TARGETS: Record<SyncTargetId, SyncTarget<never>> = {
	copilot: copilotTarget as SyncTarget<never>,
	opencode: opencodeTarget as SyncTarget<never>,
	codex: codexTarget as SyncTarget<never>,
	claude: claudeTarget as SyncTarget<never>,
	pi: piTarget as SyncTarget<never>,
	grok: grokTarget as SyncTarget<never>,
};

function usage(): string {
	const lines = [
		"Usage: dg-skills sync <target> <probe|dry-run|apply|verify> [flags]",
		"",
		`Targets: ${SYNC_TARGET_IDS.join(", ")}`,
		"",
		"Per-target usage:",
		...SYNC_TARGET_IDS.map((id) => `  ${TARGETS[id].usage}`),
	];
	return lines.join("\n");
}

export function defaultSyncContext(): SyncContext {
	return {
		home: process.env.HOME || homedir(),
		cwd: process.cwd(),
		env: process.env,
	};
}

function isMode(value: string | undefined): value is SyncMode {
	return !!value && (SYNC_MODES as readonly string[]).includes(value);
}

/** Dispatch `sync <target> <mode> [flags]`; exported for direct, isolated-HOME testing. */
export async function syncMain(argv: string[], ctx: SyncContext = defaultSyncContext()): Promise<number> {
	if (argv[0] === "-h" || argv[0] === "--help" || argv.length === 0) {
		process.stdout.write(`${usage()}\n`);
		return argv.length === 0 ? 1 : 0;
	}

	const targetId = argv[0];
	const target = (SYNC_TARGET_IDS as readonly string[]).includes(targetId) ? TARGETS[targetId as SyncTargetId] : undefined;
	if (!target) {
		process.stderr.write(`sync: unknown target '${targetId}'\n\n${usage()}\n`);
		return 1;
	}

	const mode = argv[1];
	if (!isMode(mode)) {
		process.stderr.write(`sync ${targetId}: usage: ${target.usage}\n`);
		return 1;
	}

	const { flags, error } = target.parseFlags(argv.slice(2));
	if (error || !flags) {
		process.stderr.write(`sync ${targetId}: ${error ?? "invalid flags"}\n\nUsage: ${target.usage}\n`);
		return 1;
	}

	const method = mode === "dry-run" ? "dryRun" : mode;
	const report = await target[method](ctx, flags);
	process.stdout.write(`${report.render()}\n`);
	return report.ok ? 0 : 1;
}

export function registerSync(program: Command): void {
	registerRawCommand(program, {
		name: "sync",
		description: "Sync Claude-authored skills and agents into other AI tools (copilot, opencode, codex, claude, pi, grok).",
		run: (argv) => syncMain(argv),
	});
}
