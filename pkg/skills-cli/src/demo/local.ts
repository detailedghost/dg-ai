import { spawn } from "node:child_process";
import { closeSync, existsSync, lstatSync, openSync, realpathSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { slugify } from "@dg/common";
import {
	ensurePrivateDir,
	isWSL,
	selfCommand,
	writeFileAtomic,
} from "@dg/common/node";
import { wslPlan } from "../pw/commands/open/run";
import {
	BrowserMissingError,
	type LaunchPick,
	pickLaunch,
} from "../pw/core/browser";
import { downloadedChromium } from "../pw/core/downloaded";
import { timestampedName } from "../pw/core/response";
import { exePath } from "../pw/core/windows";
import type { TourScript } from "../utils/plan-format";
import { demosDir, demosWriteDir } from "./paths";
import { loadScript, savePlan } from "./plan-file";
import {
	DEFAULT_TIMEOUT_MIN,
	EnvRefusedError,
	type BrowserPlan,
	type PlayerArgv,
	type PlayerJob,
	SETUP_NEEDS_PERSON,
	setupNeedsPerson,
	unsetFillVariables,
} from "./player-job";
import { playbackSteps } from "./recorder/drive";
import { playerPid } from "./result";

export type LocalDeps = {
	isWSL(): boolean;
	windowsBrowserPresent(): boolean;
	pickLaunch(): LaunchPick;
	spawn(argv: string[], logPath: string): { pid: number };
	inGitWorkTree(dir: string): boolean;
};

export type LocalOpts = {
	print?: boolean;
	edit?: boolean;
	out?: string;
	narration?: boolean;
	browser?: "chrome" | "msedge" | "chromium";
	windows?: boolean;
	wslHeaded?: boolean;
	timeout?: number;
};

function spawnDetached(argv: string[], logPath: string): { pid: number } {
	const [program, ...args] = argv;
	if (!program) throw new Error("demo: no player command to run");
	const log = openSync(logPath, "a", 0o600);
	try {
		const child = spawn(program, args, {
			detached: true,
			stdio: ["ignore", log, log],
		});
		child.on("error", () => undefined);
		child.unref();
		if (child.pid === undefined)
			throw new Error(`demo: could not start the player (${program})`);
		return { pid: child.pid };
	} finally {
		closeSync(log);
	}
}

export const defaultLocalDeps: LocalDeps = {
	isWSL,
	windowsBrowserPresent: () =>
		exePath("chrome") !== null || exePath("msedge") !== null,
	pickLaunch: () => pickLaunch(),
	spawn: spawnDetached,
	inGitWorkTree: (dir) => {
		const result = Bun.spawnSync(
			["git", "-C", dir, "rev-parse", "--is-inside-work-tree"],
			{ stdout: "pipe", stderr: "ignore" },
		);
		return result.exitCode === 0 && result.stdout.toString().trim() === "true";
	},
};

function isSymlink(path: string): boolean {
	try {
		return lstatSync(path).isSymbolicLink();
	} catch {
		return false;
	}
}

function nearestExistingDir(path: string): string {
	let dir = dirname(path);
	while (!existsSync(dir)) dir = dirname(dir);
	return realpathSync(dir);
}

function pickFor(opts: LocalOpts, deps: LocalDeps): LaunchPick {
	if (opts.browser === "chromium") {
		const executablePath = downloadedChromium()?.executablePath;
		if (!executablePath) throw new BrowserMissingError();
		return { executablePath };
	}
	return opts.browser ? { channel: opts.browser } : deps.pickLaunch();
}

const labelOf = (pick: LaunchPick): string =>
	"channel" in pick ? pick.channel : "chromium";

function windowsBrowser(opts: LocalOpts): "chrome" | "msedge" | undefined {
	return opts.browser === "chrome" || opts.browser === "msedge"
		? opts.browser
		: undefined;
}

class RefusedError extends Error {
	constructor(
		message: string,
		readonly exitCode: number,
	) {
		super(message);
	}
}

function resolvePlan(
	opts: LocalOpts,
	deps: LocalDeps,
): { plan: BrowserPlan; warning?: string } {
	if (opts.windows) {
		if (!deps.isWSL()) throw new RefusedError("demo: --windows needs WSL", 1);
		if (opts.browser === "chromium")
			throw new RefusedError(
				"demo: --windows drives Chrome or Edge; use --browser chrome or --browser msedge",
				1,
			);
		if (!deps.windowsBrowserPresent())
			throw new RefusedError(new BrowserMissingError().message, 3);
		return { plan: { mode: "windows", browser: windowsBrowser(opts) } };
	}
	let headless = false;
	let warning: string | undefined;
	if (deps.isWSL()) {
		const wsl = wslPlan(
			{
				...(opts.wslHeaded ? { "wsl-headed": true } : {}),
				...(opts.browser ? { browser: opts.browser } : {}),
			},
			deps.windowsBrowserPresent(),
		);
		if (wsl.mode === "windows")
			return { plan: { mode: "windows", browser: windowsBrowser(opts) } };
		headless = wsl.headless;
		warning = wsl.warning;
	}
	const pick = pickFor(opts, deps);
	return {
		plan: { mode: "local", headless, pick, label: labelOf(pick) },
		...(warning ? { warning } : {}),
	};
}

const planLabel = (plan: BrowserPlan): string =>
	plan.mode === "windows"
		? `the Windows ${plan.browser ?? "browser"}`
		: plan.label;

export async function playLocal(
	script: TourScript,
	opts: LocalOpts,
	deps: LocalDeps = defaultLocalDeps,
): Promise<number> {
	if (opts.print || opts.edit) {
		console.error("demo: --print/--edit need --ext");
		return 1;
	}
	let resolved: ReturnType<typeof resolvePlan>;
	try {
		resolved = resolvePlan(opts, deps);
	} catch (error) {
		if (
			!(error instanceof BrowserMissingError) &&
			!(error instanceof RefusedError)
		)
			throw error;
		console.error(error.message);
		return error.exitCode;
	}
	const out = opts.out ? resolve(opts.out) : undefined;
	if (out && !out.endsWith(".mp4")) {
		console.error("demo: --out must name a .mp4 file");
		return 1;
	}
	if (out && isSymlink(out)) {
		console.error("demo: --out must not be a symlink");
		return 1;
	}
	if (out && deps.inGitWorkTree(nearestExistingDir(out))) {
		console.error("demo: --out must be outside a git work tree");
		return 1;
	}
	const [unset] = unsetFillVariables(
		playbackSteps(script).map(({ step }) => step),
		process.env,
	);
	if (unset) {
		console.error(new EnvRefusedError(unset).message);
		return 2;
	}
	const { plan, warning } = resolved;
	if (
		plan.mode === "local" &&
		plan.headless &&
		setupNeedsPerson(script, process.env)
	) {
		console.error(SETUP_NEEDS_PERSON);
		return 2;
	}
	if (warning) console.error(warning);

	const slug = slugify(script.title ?? "demo");
	const running = playerPid(slug);
	if (running !== undefined) {
		console.error(`a player for ${slug} is already running (pid ${running})`);
		return 1;
	}
	const dir = join(demosWriteDir(), slug);
	ensurePrivateDir(demosDir());
	ensurePrivateDir(dir);
	rmSync(join(dir, `${slug}.result.json`), { force: true });
	const planPath = savePlan(script, dir);
	const job: PlayerArgv = {
		slug,
		planPath,
		dir,
		startUrl: script.startUrl,
		plan,
		...(out ? { out } : {}),
		...(opts.narration ? { narration: true } : {}),
		timeoutMin: opts.timeout ?? DEFAULT_TIMEOUT_MIN,
	};
	const { pid } = deps.spawn(
		selfCommand(["demo", "player", JSON.stringify(job)]),
		join(dir, timestampedName("player", "log")),
	);
	writeFileAtomic(join(dir, "player.pid"), String(pid), 0o600);

	const title = script.title ?? slug;
	const where = planLabel(plan);
	console.log(
		`demo "${title}": recording in ${where}. Results: dg-skills demo status ${slug}`,
	);
	return 0;
}

export async function servePlayer(json: string): Promise<number> {
	const { runPlayer } = await import("./player-process");
	const argv = JSON.parse(json) as PlayerArgv;
	const job: PlayerJob = { ...argv, script: loadScript(argv.planPath) };
	return runPlayer(job);
}
