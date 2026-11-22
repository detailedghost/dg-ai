import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { describeError } from "@dg/common";
import { type DgPaths, resolveDgPaths } from "@dg/common/node/dg-paths";
import { compiledProgramPath, isCompiled, type ProgramName } from "@dg/common/node/program";
import { VERSION_DIR } from "./current";

const SELF_FINISHING = new Set(["install", "update", "upgrade"]);
const NEVER_FINISH = new Set(["hooks", "completion", "__complete", "agent", "daemon"]);

export const UNFINISHED_HINT = "dg: the upgrade is not finished; run dg upgrade once more to install the compiled dg";

function realLib(paths: DgPaths): string | undefined {
	try {
		return realpathSync(join(paths.dataDir, "lib"));
	} catch {
		return undefined;
	}
}

/** True when a 6.x launcher runs this release's bundle from `<data>/lib/<version>` and the compiled dg is missing. */
export function unfinishedUpgrade(main: string = Bun.main, paths: DgPaths = resolveDgPaths()): boolean {
	if (isCompiled(main) || basename(main) !== "dg.js") return false;
	const versionDir = dirname(main);
	if (!VERSION_DIR.test(basename(versionDir)) || dirname(versionDir) !== realLib(paths)) return false;
	return !existsSync(compiledProgramPath(paths.dataDir));
}

type FinishSeams = {
	unfinished?: () => boolean;
	finish?: () => Promise<void>;
	warn?: (line: string) => void;
};

async function writeLaunchers(): Promise<void> {
	const { writeCurrentLaunchers } = await import("./cli");
	const log = console.log;
	console.log = console.error;
	try {
		await writeCurrentLaunchers();
	} finally {
		console.log = log;
	}
}

/** Finishes a 6.0 or 6.1 self-update, whose old code never ran this release's `install launchers` step. */
export async function finishLegacyUpgrade(
	name: ProgramName,
	args: readonly string[],
	seams: FinishSeams = {},
): Promise<void> {
	const warn = seams.warn ?? ((line: string) => void process.stderr.write(`${line}\n`));
	if (!(seams.unfinished ?? unfinishedUpgrade)()) return;
	const word = (args[0] === "skills" ? args[1] : args[0]) ?? "";
	if (SELF_FINISHING.has(word)) return;
	if (name === "dg-agent" || name === "dg-daemon" || NEVER_FINISH.has(word) || word.startsWith("-")) {
		warn(UNFINISHED_HINT);
		return;
	}
	warn("dg: finishing the upgrade: installing the compiled dg and removing the old launchers");
	try {
		await (seams.finish ?? writeLaunchers)();
	} catch (error) {
		warn(`dg: the upgrade is not finished: ${describeError(error)}; run dg upgrade once more`);
	}
}
