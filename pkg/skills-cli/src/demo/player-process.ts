import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	renameSync,
	rmSync,
	unlinkSync,
} from "node:fs";
import { dirname, extname, join } from "node:path";
import { holdFor } from "@dg/common";
import {
	ensurePrivateDir,
	wslChromiumArgs,
	writeFileAtomic,
} from "@dg/common/node";
import type { Browser, BrowserContext } from "playwright-core";
import pkg from "../../package.json" with { type: "json" };
import { ensureNarrationAssets, isNetworkFailure } from "./narration-assets";
import { assembleNarrationWav } from "./narration";
import { profileDir } from "./paths";
import { guardedDest } from "../utils/layout-guard";
import {
	DEFAULT_TIMEOUT_MIN,
	type BrowserPlan,
	EnvRefusedError,
	type PlayerJob,
	SetupRefusedError,
	setupNeedsPerson,
	unsetFillVariables,
} from "./player-job";
import { type LaunchPick, pickLaunch } from "../pw/core/browser";
import { playbackSteps, recordTour, settle, VIEWPORT } from "./recorder/drive";
import { canEncode, type EncodeDeps, encodeMp4 } from "./recorder/encode";
import {
	narrationClips,
	narrationHolds,
	type SpokenClip,
	synthesize,
} from "./recorder/narrate";
import { type DemoResult, writeResult } from "./result";
import { clearOverlays, showCaption, THEME } from "./recorder/overlays";

export { VIEWPORT };

export type StorageState = Awaited<ReturnType<BrowserContext["storageState"]>>;

export type PlayerSession = {
	open(record: boolean, state?: StorageState): Promise<BrowserContext>;
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
	launch?(job: PlayerJob): Promise<PlayerSession>;
	fetch?: typeof fetch;
	synthesize?: typeof synthesize;
	encode?: EncodeDeps;
};

const OFFLINE_LINE =
	"narration assets are not downloaded; running captions-only";
const SETTLE_MS = 1_500;
const LOGIN_SETTLE_MS = 15_000;
const PERSON_PROMPT = "Type it here, then continue.";

export const contextOptions = (job: PlayerJob, record: boolean) => ({
	...(record
		? {
				screen: VIEWPORT,
				deviceScaleFactor: 1,
				recordVideo: { dir: join(job.dir, "rec"), size: VIEWPORT },
			}
		: {}),
});

type TabStorage = { origin: string; items: [string, string][] };

const readTabStorage = (): TabStorage => ({
	origin: location.origin,
	items: Object.entries(sessionStorage),
});

function seedTabStorage({ origin, items }: TabStorage): void {
	if (location.origin !== origin || sessionStorage.length > 0) return;
	for (const [name, value] of items) sessionStorage.setItem(name, value);
}

async function restoreState(context: BrowserContext, state: StorageState): Promise<void> {
	await context.addCookies(state.cookies);
	const seeded = state.origins.filter((origin) => origin.localStorage.length > 0);
	if (seeded.length === 0) return;
	const page = await context.newPage();
	try {
		for (const { origin, localStorage: items } of seeded) {
			await page.route(`${origin}/**`, (route) => route.fulfill({ contentType: "text/html", body: "" }));
			await page.goto(`${origin}/`);
			await page.evaluate((entries) => {
				for (const { name, value } of entries) localStorage.setItem(name, value);
			}, items);
			await page.unrouteAll();
		}
	} finally {
		await page.close();
	}
}

export async function launchLocal(
	job: PlayerJob,
	plan: LocalPlan,
): Promise<PlayerSession> {
	const { chromium } = await import("playwright-core");
	const profile = job.profile ?? guardedDest("demo-profile", profileDir());
	ensurePrivateDir(profile);
	let current: BrowserContext | undefined;
	return {
		async open(record, state) {
			current = await chromium.launchPersistentContext(profile, {
				headless: plan.headless,
				...("channel" in plan.pick
					? { channel: plan.pick.channel }
					: { executablePath: plan.pick.executablePath }),
				args: wslChromiumArgs(),
				viewport: VIEWPORT,
				...contextOptions(job, record),
			});
			if (state) await restoreState(current, state);
			return current;
		},
		close: async () => {
			await current?.close().catch(() => undefined);
		},
	};
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
	let browser: Browser | undefined;
	const close = async (): Promise<void> => {
		await browser?.close().catch(() => undefined);
		await closeWindowsBrowser(profile).catch(() => undefined);
	};
	try {
		browser = await chromium.connectOverCDP(windows.cdpUrl);
		const connected = browser;
		const open = (record: boolean, state?: StorageState) =>
			connected.newContext({
				viewport: VIEWPORT,
				...(state ? { storageState: state } : {}),
				...contextOptions(job, record),
			});
		await (await open(true)).close();
		return { open, close };
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
		if (setupNeedsPerson(job.script, process.env)) throw new SetupRefusedError();
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
	const ext = extname(path);
	const base = path.slice(0, path.length - ext.length);
	for (let n = 2; ; n++) {
		const next = `${base}-${n}${ext}`;
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

const messageOf = (error: unknown): string =>
	error instanceof Error ? error.message : String(error);

function waitForPerson(timeoutMs: number): NonNullable<Parameters<typeof recordTour>[2]["onMissingEnv"]> {
	return async ({ page, target, step, index, next }) => {
		const before = page.url();
		await showCaption(page, {
			eyebrow: step.title ?? `Step ${index + 1}`,
			body: PERSON_PROMPT,
			accent: THEME.setupAccent,
			top: false,
		});
		await target.focus();
		const upcoming = next?.selector ? page.locator(next.selector).first() : undefined;
		const waiting = upcoming && !(await upcoming.isVisible());
		const signals = [
			page.waitForURL((url) => url.href !== before, { timeout: timeoutMs }),
			target.evaluate(
				(el) =>
					new Promise<void>((resolve) => {
						const done = () => {
							if ((el as HTMLInputElement).value) resolve();
						};
						el.addEventListener("keydown", (event) => {
							if ((event as KeyboardEvent).key === "Enter") done();
						});
						el.addEventListener("blur", done);
					}),
			),
		];
		if (upcoming && waiting) signals.push(upcoming.waitFor({ state: "visible", timeout: timeoutMs }));
		await Promise.any(signals).catch(() => {
			throw new Error("timed out waiting for a person to continue");
		});
		await page
			.waitForURL((url) => url.href !== before, { timeout: SETTLE_MS })
			.catch(() => undefined);
		await settle(page, LOGIN_SETTLE_MS);
		await clearOverlays(page);
		return { navigated: page.url() !== before };
	};
}

type Narration = (SpokenClip | null)[] | undefined;

async function narrate(job: PlayerJob, context: BrowserContext, texts: string[], hooks: PlayerHooks): Promise<Narration> {
	try {
		const assetDir = await ensureNarrationAssets(pkg.version, { fetch: hooks.fetch });
		return await (hooks.synthesize ?? synthesize)(context, texts, { assetDir });
	} catch (error) {
		if (isNetworkFailure(error)) console.log(OFFLINE_LINE);
		else console.log(`demo ${job.slug}: narration failed (${messageOf(error)}); recorded without voice`);
		return undefined;
	}
}

type Finished = Pick<DemoResult, "video" | "encoded" | "audio">;

function finishVideo(
	job: PlayerJob,
	webm: string,
	voice: string | undefined,
	startMs: number,
	hooks: PlayerHooks,
): Finished {
	const target = job.out ?? freeName(join(job.dir, `${job.slug}-${stamp()}.mp4`));
	mkdirSync(dirname(target), { recursive: true });
	const outcome = encodeMp4({ webm, out: target, audio: voice, startMs }, hooks.encode);
	if (outcome.encoded) {
		if (voice) rmSync(voice, { force: true });
		if (!job.out) chmodSync(target, 0o600);
		return { video: target, encoded: true, audio: voice ? "muxed" : "none" };
	}
	const raw = target.replace(/\.mp4$/, ".webm");
	const kept = job.out ? raw : freeName(raw);
	moveFile(webm, kept);
	if (!job.out) chmodSync(kept, 0o600);
	let audio: Finished["audio"] = "none";
	if (voice) {
		moveFile(voice, kept.replace(/\.webm$/, ".wav"));
		audio = "sidecar";
	}
	console.log(`demo ${job.slug}: ffmpeg not found; kept the raw webm. Install ffmpeg to get an MP4.`);
	return { video: kept, encoded: false, audio };
}

export async function runPlayer(
	job: PlayerJob,
	hooks: PlayerHooks = {},
): Promise<number> {
	ensurePrivateDir(job.dir);
	const startedAt = new Date().toISOString();
	const recDir = join(job.dir, "rec");
	const voiceFile = join(job.dir, "voice.wav");
	const timeoutMs = (job.timeoutMin ?? DEFAULT_TIMEOUT_MIN) * 60_000;
	const opened = new Set<BrowserContext>();
	const closing = new Set<BrowserContext>();
	let cancelled = false;
	const pending = new Set<ReturnType<typeof setTimeout>>();
	let stop: () => void = () => undefined;
	const stopped = new Promise<"stopped">((resolve) => {
		stop = () => {
			cancelled = true;
			for (const wait of pending) clearTimeout(wait);
			pending.clear();
			resolve("stopped");
		};
	});
	const pause = (ms: number): Promise<void> =>
		new Promise((resolve) => {
			if (cancelled) return;
			const wait = setTimeout(() => {
				pending.delete(wait);
				resolve();
			}, ms);
			pending.add(wait);
		});
	const timer = setTimeout(stop, timeoutMs);
	let session: PlayerSession | undefined;
	let finished: Finished = { encoded: false, audio: "none" };
	let startOffsetMs: number | undefined;
	let end: { outcome: DemoResult["outcome"]; error?: string } = { outcome: "done" };
	let refusal: number | undefined;
	let keepRaw = false;

	const open = async (record: boolean, state?: StorageState): Promise<BrowserContext> => {
		const context = await (session as PlayerSession).open(record, state);
		if (cancelled) {
			await context.close().catch(() => undefined);
			throw new Error("the run was stopped");
		}
		opened.add(context);
		context.once("close", () => {
			if (!closing.has(context)) stop();
		});
		return context;
	};
	const close = async (context: BrowserContext): Promise<void> => {
		closing.add(context);
		await context.close().catch(() => undefined);
	};
	const freshPage = async (context: BrowserContext) => {
		const initial = context.pages()[0];
		const page = await context.newPage();
		const openedAt = Date.now();
		if (initial) await initial.close().catch(() => undefined);
		return { page, openedAt };
	};

	const run = async (): Promise<void> => {
		const steps = playbackSteps(job.script);
		const missing = unsetFillVariables(steps.map(({ step }) => step), process.env)[0];
		if (missing) throw new EnvRefusedError(missing);
		const launched = await (hooks.launch ?? openSession)(job);
		if (cancelled) {
			await launched.close().catch(() => undefined);
			return;
		}
		session = launched;

		const setup = job.script.setup;
		let state: StorageState | undefined;
		let tab: TabStorage | undefined;
		if (setup && !setup.includeInTour && setup.steps.length > 0) {
			const context = await open(false);
			const { page } = await freshPage(context);
			await recordTour(
				page,
				{ startUrl: job.script.startUrl, steps: setup.steps },
				{
					env: process.env,
					overlays: false,
					hold: () => 0,
					pause,
					onMissingEnv: waitForPerson(timeoutMs),
					onSkippedStep: (index) =>
						console.log(`demo ${job.slug}: skipped setup step ${index + 1} after the sign-in`),
				},
			);
			state = await context.storageState({ indexedDB: true });
			tab = await page.evaluate(readTabStorage).catch(() => undefined);
			await close(context);
		}

		const context = await open(true, state);
		if (tab && tab.items.length > 0) await context.addInitScript(seedTabStorage, tab);
		const texts = steps.map(({ step }) => step.body);
		const clips = job.narration ? await narrate(job, context, texts, hooks) : undefined;
		const recorded = steps.map(({ step }) => step);
		const holds = clips ? narrationHolds(recorded, clips) : recorded.map((step) => holdFor(step, null));
		const { page: live, openedAt: recordingStart } = await freshPage(context);
		const result = await recordTour(live, job.script, {
			env: process.env,
			overlays: true,
			hold: (_, i) => holds[i] ?? 0,
			pause,
			now: () => Date.now() - recordingStart,
		});
		startOffsetMs = result.startMs;
		const video = live.video();
		await close(context);
		if (cancelled) return;
		const webm = video ? await video.path().catch(() => undefined) : undefined;
		if (!webm) throw new Error("no video was written: the browser could not record this run");

		const placed = clips
			? narrationClips(clips, result.offsets, canEncode(hooks.encode) ? result.startMs : 0)
			: [];
		if (placed.length > 0) {
			const wav = assembleNarrationWav(placed);
			writeFileAtomic(voiceFile, Buffer.from(wav.buffer, wav.byteOffset, wav.byteLength), 0o600);
		}
		try {
			finished = finishVideo(job, webm, placed.length > 0 ? voiceFile : undefined, result.startMs, hooks);
		} catch (error) {
			keepRaw = true;
			const voice = placed.length > 0 ? ` and the narration in ${voiceFile}` : "";
			throw new Error(`could not save the video: ${messageOf(error)}; the raw recording stays in ${recDir}${voice}`);
		}
	};

	const attempt = run().then(
		() => undefined,
		(error: unknown) => error,
	);
	const winner = await Promise.race([attempt, stopped]);
	clearTimeout(timer);
	if (winner === "stopped") end = { outcome: "stopped" };
	else if (winner !== undefined) {
		const error = winner;
		end = { outcome: "error", error: messageOf(error) };
		if (error instanceof SetupRefusedError || error instanceof EnvRefusedError) {
			refusal = error.exitCode;
			console.error(error.message);
		} else console.log(`demo ${job.slug}: ${end.error}`);
	}

	for (const context of opened) await close(context);
	await session?.close().catch(() => undefined);
	if (!keepRaw) rmSync(recDir, { recursive: true, force: true });
	if (end.outcome !== "done" && !keepRaw) rmSync(voiceFile, { force: true });

	const result: DemoResult = {
		slug: job.slug,
		outcome: end.outcome,
		mode: "video",
		steps: job.script.steps.length,
		...(finished.video ? { video: finished.video } : {}),
		encoded: finished.encoded,
		audio: finished.audio,
		...(finished.video && startOffsetMs !== undefined ? { startOffsetMs } : {}),
		plan: job.planPath,
		startedAt,
		endedAt: new Date().toISOString(),
		...(end.error ? { error: end.error } : {}),
	};
	writeResult(result, job.dir);
	if (refusal !== undefined) return refusal;
	return end.outcome === "error" ? 1 : 0;
}
