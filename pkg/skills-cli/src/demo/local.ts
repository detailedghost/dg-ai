import { spawn } from "node:child_process";
import { closeSync, openSync, rmSync } from "node:fs";
import { join } from "node:path";
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
import { demosDir } from "./paths";
import { loadScript, savePlan } from "./plan-file";
import {
	DEFAULT_TIMEOUT_MIN,
	type BrowserPlan,
	type PlayerArgv,
	type PlayerJob,
} from "./player-job";
import { playerPid } from "./result";

export type LocalDeps = {
	isWSL(): boolean;
	windowsBrowserPresent(): boolean;
	pickLaunch(): LaunchPick;
	spawn(argv: string[], logPath: string): { pid: number };
};

export type LocalOpts = {
	video?: boolean;
	print?: boolean;
	edit?: boolean;
	out?: string;
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
};

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
	if (opts.out && !opts.out.endsWith(".webm")) {
		console.error("demo: --out must name a .webm file");
		return 1;
	}
	const { plan, warning } = resolved;
	if (plan.mode === "local" && plan.headless && !opts.video) {
		console.error(
			"demo: the start screen needs a visible browser; pass --video for an unattended recording, or --windows / --wsl-headed",
		);
		return 2;
	}
	if (warning) console.error(warning);

	const slug = slugify(script.title ?? "demo");
	const running = playerPid(slug);
	if (running !== undefined) {
		console.error(`a player for ${slug} is already running (pid ${running})`);
		return 1;
	}
	const dir = join(demosDir(), slug);
	ensurePrivateDir(demosDir());
	ensurePrivateDir(dir);
	rmSync(join(dir, `${slug}.result.json`), { force: true });
	const planPath = savePlan(script, dir);
	const job: PlayerArgv = {
		slug,
		planPath,
		dir,
		video: opts.video === true,
		startUrl: script.startUrl,
		plan,
		...(opts.out ? { out: opts.out } : {}),
		timeoutMin: opts.timeout ?? DEFAULT_TIMEOUT_MIN,
	};
	const { pid } = deps.spawn(
		selfCommand(["demo", "__player", JSON.stringify(job)]),
		join(dir, timestampedName("player", "log")),
	);
	writeFileAtomic(join(dir, "player.pid"), String(pid), 0o600);

	const title = script.title ?? slug;
	const where = planLabel(plan);
	console.log(
		job.video
			? `demo "${title}": recording in ${where}. Results: dg-skills demo status ${slug}`
			: `demo "${title}": start screen open in ${where}. The human picks there. Results: dg-skills demo status ${slug}`,
	);
	return 0;
}

export async function servePlayer(json: string): Promise<number> {
	const { runPlayer } = await import("./player-process");
	const argv = JSON.parse(json) as PlayerArgv;
	const job: PlayerJob = { ...argv, script: loadScript(argv.planPath) };
	return runPlayer(job);
}
