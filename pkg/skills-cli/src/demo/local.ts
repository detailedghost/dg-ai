import { spawn } from "node:child_process";
import { closeSync, openSync, readFileSync, rmSync } from "node:fs";
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
import { demosDir, demosWriteDir } from "./paths";
import { loadScript, savePlan } from "./plan-file";
import {
	DEFAULT_TIMEOUT_MIN,
	type BrowserPlan,
	type NarrationChoice,
	type PlayerArgv,
	type PlayerJob,
	SETUP_NEEDS_PERSON,
	setupNeedsPerson,
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
	narration?: NarrationChoice;
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

const NARRATIONS: readonly string[] = ["both", "voice", "captions"];
const VOICE_ID = /^[a-z]{2}_[a-z]{1,32}$/;

function savedChoice(dir: string): { narration?: NarrationChoice; voice?: string } {
	try {
		const saved = JSON.parse(readFileSync(join(dir, "choice.json"), "utf8")) as {
			narration?: NarrationChoice;
			voice?: string;
		};
		return {
			...(saved.narration && NARRATIONS.includes(saved.narration)
				? { narration: saved.narration }
				: {}),
			...(saved.voice && VOICE_ID.test(saved.voice) ? { voice: saved.voice } : {}),
		};
	} catch {
		return {};
	}
}

function saveNarrationChoice(dir: string, narration: NarrationChoice): void {
	let existing: Record<string, unknown> = {};
	try {
		const parsed: unknown = JSON.parse(readFileSync(join(dir, "choice.json"), "utf8"));
		if (parsed && typeof parsed === "object") existing = parsed as Record<string, unknown>;
	} catch {
		existing = {};
	}
	writeFileAtomic(
		join(dir, "choice.json"),
		JSON.stringify({ ...existing, narration }),
		0o600,
	);
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
	if (opts.narration && !opts.video) {
		console.error(
			"demo: --narration needs --video; the start screen offers it otherwise",
		);
		return 1;
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
	if (
		plan.mode === "local" &&
		plan.headless &&
		setupNeedsPerson(script)
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
	const saved = opts.video ? savedChoice(dir) : {};
	const narration = opts.narration ?? saved.narration;
	if (opts.video && opts.narration) saveNarrationChoice(dir, opts.narration);
	const planPath = savePlan(script, dir);
	const job: PlayerArgv = {
		slug,
		planPath,
		dir,
		video: opts.video === true,
		startUrl: script.startUrl,
		plan,
		...(opts.out ? { out: opts.out } : {}),
		...(narration ? { narration } : {}),
		...(narration && saved.voice ? { voice: saved.voice } : {}),
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
