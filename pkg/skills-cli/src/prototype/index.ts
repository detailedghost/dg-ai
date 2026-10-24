import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { validateVerdict } from "@dg/common";
import { resolveSkillAsset } from "../utils/skill-assets";
import {
	dgProtoPath,
	protoScratchPath,
	resolveDownloadsDir,
} from "../utils/proto-paths";
import { type Flags, parseFlags } from "./args";
import { protoDir, type SentinelPaths, sentinelPaths } from "./paths";
import {
	awaitDecision,
	confirm,
	formatDecision,
	formatWait,
	readSource,
	status,
	wait,
} from "./sentinels";
import { runServe } from "./serve";
import {
	loadState,
	openInBrowser,
	runUi,
	statusSession,
	stopChain,
	waitSession,
} from "./ui";

/**
 * Non-destructive fallback for `status <name>` when no local sentinel is
 * pending: a `--ext` slug records its verdict as a browser download, not a
 * sentinel file, so a bare local "pending" can still be hiding an unclaimed
 * `--ext` pick. Never consumes anything — `proto --ext plant` remains the
 * only way to claim and export an `--ext` verdict. A verdict file older than
 * `reloadPath` predates the current local session (`ui` bumps `.reload` on
 * every start and reuse) and is ignored, so a slug reused by a brand-new
 * local prototype can't surface a stale decision from an unrelated earlier
 * run; with no `.reload` yet, there is no session to compare against, so the
 * verdict is trusted as before. `resolveDownloads` is overridable for tests;
 * resolving it lazily inside the try means a user with no Downloads folder
 * detectable (e.g. WSL with no `wslpath`) still gets a plain local "pending"
 * instead of a crash.
 */
export function extStatus(
	name: string,
	reloadPath: string,
	resolveDownloads: () => string = resolveDownloadsDir,
): string | undefined {
	const reloadMs = (() => {
		try {
			return statSync(reloadPath).mtimeMs;
		} catch {
			return undefined;
		}
	})();
	for (const resolvePath of [
		() => join(resolveDownloads(), dgProtoPath(name, "verdict.json")),
		() => protoScratchPath(name, "verdict.json"),
	]) {
		try {
			const path = resolvePath();
			if (!existsSync(path)) continue;
			if (reloadMs !== undefined && statSync(path).mtimeMs < reloadMs)
				continue;
			const verdict = validateVerdict(JSON.parse(readFileSync(path, "utf8")));
			if (verdict.slug !== name) continue;
			return verdict.action === "reject"
				? "rejected"
				: `${verdict.action}:${verdict.selectedKey}`;
		} catch {
			continue;
		}
	}
	return undefined;
}

/**
 * Write a status result, recording who made it when known, and refuse with a
 * non-zero exit when `--require-pending` asked for "pending" and got
 * something else — the hand-over check that catches a stale or self-test
 * pick before the page is reported live, or before anything waits on it.
 */
function reportStatus(
	paths: SentinelPaths,
	resolved: string,
	flags: Flags,
	name: string,
): number {
	if (flags.requirePending && resolved !== "pending") {
		process.stderr.write(
			`prototype: status for "${name}" is "${resolved}", not "pending" — refusing to report the page as newly live\n`,
		);
		return 1;
	}
	if (flags.json) {
		write(
			`${JSON.stringify({ status: resolved, source: readSource(paths) ?? null })}\n`,
		);
	} else {
		write(`${resolved}\n`);
	}
	return 0;
}

export const USAGE = `Usage: prototype <command> [options]

  ui <manifest|plan.json|-> [--chain=NAME] [--series] [--light] [--port=N] [--timeout=SEC] [--no-open]
                                                 Render, serve, open, and block for one decision
  serve <html-file> <name> [--light] [--port=PORT] [--idle=SEC] [--dir=PATH]
                                                 Serve a self-contained prototype page
  wait <name> [--timeout=SEC] [--light] [--json]  Block until a variant is selected or rejected
  confirm <name> <variant> [--light] [--notes=TEXT] [--selftest] [--source=TEXT]
                                                 Write the selection sentinel (and optional notes).
                                                 --selftest writes to <name>-selftest instead.
                                                 --source names who decided (default "cli").
  status <name> [--light] [--json] [--require-pending]
                                                 Print the selection, "rejected", or "pending"
  stop <name>                                    Stop a ui session's server and drop its state
  path <name> [--light]                          Print the selection sentinel path
  await-decision <name> [--timeout=SEC] [--light] [--json]
                                                 Block until a plan decision is written
  decision-path <name> [--light]                 Print the decision file path
  reload-path <name> [--light]                   Print the reload token file path
  changes-path <name> [--light]                  Print the "what changed" manifest path
  components                                     Print the installed switcher templates directory
  webmcp                                         Print the WebMCP tool definitions as JSON
  open <url|file>                                Open a prototype URL or file in the browser
`;

const NAME_COMMANDS: Record<string, readonly string[]> = {
	wait: ["--timeout", "--light", "--json"],
	confirm: ["--light", "--notes", "--selftest", "--source"],
	status: ["--light", "--json", "--require-pending"],
	path: ["--light"],
	"await-decision": ["--timeout", "--light", "--json"],
	"decision-path": ["--light"],
	"reload-path": ["--light"],
	"changes-path": ["--light"],
};

function locate(name: string, flags: Flags): SentinelPaths {
	return sentinelPaths(
		protoDir(name, { cwd: process.cwd(), light: flags.light }),
	);
}

function write(text: string): void {
	process.stdout.write(text);
}

async function runNamed(command: string, argv: string[]): Promise<number> {
	const flags = parseFlags(argv, NAME_COMMANDS[command] ?? []);
	const [name, variant] = flags.rest;
	if (!name || (command === "confirm" && !variant)) {
		process.stderr.write(USAGE);
		return 1;
	}
	const session =
		command === "wait" || command === "status" ? loadState(name) : undefined;
	if (command === "wait" && session)
		return waitSession(session, flags.timeoutSec);
	if (command === "status" && session) {
		return reportStatus(
			sentinelPaths(session.sentinelDir),
			statusSession(session),
			flags,
			name,
		);
	}
	const targetName = flags.selftest ? `${name}-selftest` : name;
	const paths = locate(targetName, flags);
	switch (command) {
		case "wait": {
			const result = await wait(paths, flags.timeoutSec);
			write(formatWait(result, flags.json));
			return result.status === "timeout" ? 1 : 0;
		}
		case "await-decision": {
			const result = await awaitDecision(paths, flags.timeoutSec);
			write(formatDecision(result, flags.json));
			return result.status === "timeout" ? 1 : 0;
		}
		case "confirm":
			confirm(paths, variant as string, flags.notes, flags.source);
			return 0;
		case "status": {
			const local = status(paths);
			return reportStatus(
				paths,
				local === "pending" ? (extStatus(name, paths.reload) ?? local) : local,
				flags,
				name,
			);
		}
		case "path":
			write(`${paths.selection}\n`);
			return 0;
		case "decision-path":
			write(`${paths.decision}\n`);
			return 0;
		case "reload-path":
			write(`${paths.reload}\n`);
			return 0;
		default:
			write(`${paths.changes}\n`);
			return 0;
	}
}

/** Entry point for the local prototype commands; resolves to an exit status, or nothing while a server runs. */
export async function main(argv: string[]): Promise<number | undefined> {
	const [command, ...rest] = argv;
	if (!command) {
		process.stderr.write(USAGE);
		return 1;
	}
	if (command === "--help" || command === "-h") {
		write(USAGE);
		return 0;
	}
	try {
		if (command === "ui") return await runUi(rest);
		if (command === "serve") return await runServe(rest);
		if (command === "stop" && rest[0]) {
			write(stopChain(rest[0]));
			return 0;
		}
		if (command === "components") {
			write(`${resolveSkillAsset("proto", "assets")}\n`);
			return 0;
		}
		if (command === "webmcp") {
			write(
				readFileSync(
					resolveSkillAsset("proto", join("assets", "webmcp-tools.json")),
					"utf8",
				),
			);
			return 0;
		}
		if (command === "open" && rest[0]) {
			if (await openInBrowser(rest[0])) return 0;
			process.stderr.write(
				`prototype: no browser opener found; visit: ${rest[0]}\n`,
			);
			return 1;
		}
		if (command in NAME_COMMANDS) return await runNamed(command, rest);
		process.stderr.write(USAGE);
		return 1;
	} catch (error) {
		process.stderr.write(
			`prototype: ${error instanceof Error ? error.message : String(error)}\n`,
		);
		return 1;
	}
}
