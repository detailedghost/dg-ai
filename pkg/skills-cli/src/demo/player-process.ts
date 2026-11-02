import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	renameSync,
	rmSync,
	unlinkSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { ensurePrivateDir, wslChromiumArgs } from "@dg/common/node";
import type { BrowserContext, Page } from "playwright-core";
import {
	type BridgeEnd,
	createBridge,
	tourOrigins,
	trustedSource,
} from "./bridge";
import { profileDir } from "./paths";
import { playerScript } from "./player-asset";
import {
	DEFAULT_TIMEOUT_MIN,
	type BrowserPlan,
	type PlayerJob,
} from "./player-job";
import { type LaunchPick, pickLaunch } from "../pw/core/browser";
import { type DemoResult, writeResult } from "./result";

export type PlayerSession = {
	context: BrowserContext;
	close(): Promise<void>;
};

type LocalPlan = Extract<BrowserPlan, { mode: "local" }>;
type WindowsPlan = Extract<BrowserPlan, { mode: "windows" }>;

export type Launchers = {
	pick(): LaunchPick;
	local(job: PlayerJob, plan: LocalPlan): Promise<PlayerSession>;
	windows(job: PlayerJob, plan: WindowsPlan): Promise<PlayerSession>;
};

export type PlayerHooks = {
	onProgress?(page: Page, index: number): void | Promise<void>;
	launch?(job: PlayerJob): Promise<PlayerSession>;
};

const VIEWPORT = { width: 1280, height: 720 };

const recording = (job: PlayerJob) => ({
	recordVideo: { dir: join(job.dir, "rec"), size: VIEWPORT },
});

async function launchLocal(
	job: PlayerJob,
	plan: LocalPlan,
): Promise<PlayerSession> {
	const { chromium } = await import("playwright-core");
	const profile = job.profile ?? profileDir();
	ensurePrivateDir(profile);
	const context = await chromium.launchPersistentContext(profile, {
		headless: plan.headless,
		...("channel" in plan.pick
			? { channel: plan.pick.channel }
			: { executablePath: plan.pick.executablePath }),
		args: wslChromiumArgs(),
		viewport: job.video || plan.headless ? VIEWPORT : null,
		...recording(job),
	});
	return { context, close: () => context.close() };
}

async function launchWindows(
	job: PlayerJob,
	plan: WindowsPlan,
): Promise<PlayerSession> {
	const { closeWindowsBrowser, startWindowsBrowser, windowsProfileDir } =
		await import("../pw/core/windows");
	const { chromium } = await import("playwright-core");
	const profile = await windowsProfileDir("demo");
	const windows = await startWindowsBrowser({
		browser: plan.browser,
		profileDir: profile,
		headless: false,
	});
	const browser = await chromium.connectOverCDP(windows.cdpUrl);
	const close = async (): Promise<void> => {
		await browser.close().catch(() => undefined);
		await closeWindowsBrowser(profile).catch(() => undefined);
	};
	const create = (record: boolean) =>
		browser.newContext({
			viewport: job.video ? VIEWPORT : null,
			...(record ? recording(job) : {}),
		});
	try {
		const context = await create(true).catch((error: unknown) => {
			if (job.video) throw error;
			return create(false);
		});
		return { context, close };
	} catch (error) {
		await close();
		throw error;
	}
}

const DEFAULT_LAUNCHERS: Launchers = {
	pick: () => pickLaunch(),
	local: launchLocal,
	windows: launchWindows,
};

export async function openSession(
	job: PlayerJob,
	launchers: Launchers = DEFAULT_LAUNCHERS,
): Promise<PlayerSession> {
	const plan: BrowserPlan = job.plan ?? {
		mode: "local",
		headless: true,
		pick: launchers.pick(),
		label: "chromium",
	};
	if (plan.mode === "local") return launchers.local(job, plan);
	try {
		return await launchers.windows(job, plan);
	} catch (error) {
		if (!job.video) throw error;
		const reason = (error instanceof Error ? error.message : String(error))
			.split("\n")[0];
		console.log(
			`demo: video through the Windows browser failed (${reason}); recording in a headless local Chromium instead`,
		);
		const pick = launchers.pick();
		return launchers.local(job, {
			mode: "local",
			headless: true,
			pick,
			label: "chromium",
		});
	}
}

const pad = (n: number): string => String(n).padStart(2, "0");

function stamp(at = new Date()): string {
	const date = `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}`;
	return `${date}-${pad(at.getHours())}${pad(at.getMinutes())}`;
}

function freeName(path: string): string {
	if (!existsSync(path)) return path;
	const base = path.replace(/\.webm$/, "");
	for (let n = 2; ; n++) {
		const next = `${base}-${n}.webm`;
		if (!existsSync(next)) return next;
	}
}

function moveFile(from: string, to: string): void {
	mkdirSync(dirname(to), { recursive: true });
	try {
		renameSync(from, to);
	} catch {
		copyFileSync(from, to);
		unlinkSync(from);
	}
}

export async function runPlayer(
	job: PlayerJob,
	hooks: PlayerHooks = {},
): Promise<number> {
	ensurePrivateDir(job.dir);
	const origins = tourOrigins(job.script);
	let page: Page | undefined;
	const bridge = createBridge({
		job,
		onProgress: (index) => (page ? hooks.onProgress?.(page, index) : undefined),
	});
	let session: PlayerSession | undefined;
	let end: BridgeEnd;
	let video: string | undefined;
	let keepRaw = false;
	try {
		session = await (hooks.launch ?? openSession)(job);
		const { context } = session;
		const live = context.pages()[0] ?? (await context.newPage());
		page = live;
		await live.exposeBinding("__dgDemoBridge", (source, msg: unknown) =>
			trustedSource(source, origins) ? bridge.handle(msg) : undefined,
		);
		await live.addInitScript(playerScript());
		const tour = `window.__dgTour.run(${JSON.stringify(job.script)}, ${JSON.stringify(job.video ? { mode: "video" } : {})})`;
		const run = (): void => {
			if (!trustedSource({ frame: live.mainFrame(), page: live }, origins))
				return;
			void live.evaluate(tour).catch(() => undefined);
		};
		live.on("domcontentloaded", run);
		await live.goto(job.startUrl);

		let timer: ReturnType<typeof setTimeout> | undefined;
		const stopped: BridgeEnd = { outcome: "stopped" };
		const closed = new Promise<BridgeEnd>((resolve) =>
			context.once("close", () => resolve(stopped)),
		);
		const timedOut = new Promise<BridgeEnd>((resolve) => {
			timer = setTimeout(
				() => resolve(stopped),
				(job.timeoutMin ?? DEFAULT_TIMEOUT_MIN) * 60_000,
			);
		});
		end = await Promise.race([bridge.done, closed, timedOut]);
		clearTimeout(timer);
	} catch (error) {
		end = {
			outcome: "error",
			error: error instanceof Error ? error.message : String(error),
		};
		console.log(`demo ${job.slug}: ${end.error}`);
	}

	if (session) {
		const recorded = page?.video() ?? undefined;
		await session.context.close().catch(() => undefined);
		await session.close().catch(() => undefined);
		const source = recorded
			? await recorded.path().catch(() => undefined)
			: undefined;
		if (bridge.mode() === "video" && source) {
			const target = job.out ?? freeName(join(job.dir, `${job.slug}-${stamp()}.webm`));
			try {
				moveFile(source, target);
				if (!job.out) chmodSync(target, 0o600);
				video = target;
			} catch (error) {
				end = {
					outcome: "error",
					error: `could not save the video: ${error instanceof Error ? error.message : String(error)}; the raw recording stays in ${dirname(source)}`,
				};
				keepRaw = true;
			}
		}
		if (!keepRaw) rmSync(join(job.dir, "rec"), { recursive: true, force: true });
	}

	const result: DemoResult = {
		slug: job.slug,
		outcome: end.outcome,
		mode: bridge.mode(),
		steps: job.script.steps.length,
		...(video ? { video } : {}),
		plan: job.planPath,
		startedAt: bridge.startedAt,
		endedAt: new Date().toISOString(),
		...(end.error ? { error: end.error } : {}),
	};
	writeResult(result, job.dir);
	return end.outcome === "error" ? 1 : 0;
}
