/**
 * Demo-tour player. Reads a `_demo` script from the entry URL (or resumes an
 * in-progress tour from storage after a navigation), then walks the steps,
 * spotlighting each target and showing an explanatory callout. Tour state lives
 * in storage.local so it survives page navigations — the content script re-attaches
 * on each load and picks up where it left off. Mirrors the feature-module pattern
 * of tab-grouping.ts; all UI is rendered into a WXT shadow root (no CSS bleed).
 */

import { wait } from "@dg/common";
import {
	type CaptureStart,
	clearSpotlight,
	initializeMarkerPlayback,
	isVideo,
	type ModalHandle,
	type PendingMarkerCapture,
	type PlayState,
	runTour,
	sameOrigin,
	showEditPanel,
	showModal,
	showRecordPrompt,
	type TourHost,
	type UiHandle,
} from "@dg/tour-ui";
import { browser } from "wxt/browser";
import {
	narrationModeLabel,
	patchConfig,
	getConfig as readConfig,
	readNarrationMode,
} from "@/lib/config";
import { MSG } from "@/lib/demo-messages";
import type { TourScript } from "@/lib/demo-types";
import { wxtHost } from "@/lib/tour-host";
import {
	demoMarkerFragment,
	readDemoScript,
	readEditFlag,
	stripDemoMarker,
} from "@/utils/demo-marker";

/**
 * Where this browser lets the user rebind extension shortcuts.
 *
 * Named per browser rather than relying on a `chrome://` → `edge://` redirect, since
 * this string is displayed for the user to type: being right on both is cheaper than
 * being confidently wrong on one.
 */
export function shortcutsPageUrl(ua: string = navigator.userAgent): string {
	return ua.includes("Edg/")
		? "edge://extensions/shortcuts"
		: "chrome://extensions/shortcuts";
}

/**
 * Ask the background which shortcut Chrome bound to the record command, or null.
 *
 * Never assume the manifest's suggested key: if anything else already holds the combo
 * — most easily a stale unpacked copy of this extension — Chrome assigns ours nothing,
 * the keypress goes to that other extension, and printing the suggested key here tells
 * the user to press something this extension will never receive.
 */
async function readRecordShortcut(): Promise<string | null> {
	try {
		const res = (await browser.runtime.sendMessage({
			type: MSG.requestRecordShortcut,
		})) as { shortcut?: string | null } | undefined;
		return res?.shortcut ?? null;
	} catch {
		return null;
	}
}

// ContentScriptContext is a WXT auto-import (a class value), so alias its instance type.
type Ctx = InstanceType<typeof ContentScriptContext>;

/**
 * Persisted tour state (survives navigations within a tour). Keyed per-tab so an
 * active tour never leaks into other tabs — a global key let any <all_urls> content
 * script resume the tour, and even redirect unrelated tabs on a `navigate` step. We
 * ask the background which tab we're in; it also clears these keys on tab close.
 */
let myTabId = -1;
const stateKey = () => `demo_tour:${myTabId}`;
const recKey = () => `demo_recording:${myTabId}`;
const pendingMarkerKey = () => `demo_pending:${myTabId}`;
const MARKER_CAPTURE_KEY = "__dgDemoMarkerCapture";
type MarkerCaptureScope = typeof globalThis & {
	[MARKER_CAPTURE_KEY]?: Promise<void>;
};
const markerCaptureScope = () => globalThis as MarkerCaptureScope;

/** Reset content-script module state shared by Bun's single-process test runner. */
export function resetTabIdForTests(): void {
	abortRun();
	myTabId = -1;
	recorderListening = false;
}

function signalMarkerCapture(): () => void {
	const scope = markerCaptureScope();
	let resolve!: () => void;
	const pending = new Promise<void>((done) => {
		resolve = done;
	});
	scope[MARKER_CAPTURE_KEY] = pending;
	return () => {
		if (scope[MARKER_CAPTURE_KEY] === pending) delete scope[MARKER_CAPTURE_KEY];
		resolve();
	};
}

async function waitForMarkerCapture(): Promise<void> {
	await markerCaptureScope()[MARKER_CAPTURE_KEY];
}

/**
 * Bounded retry for the whoami round trip, because the worker can still be starting on
 * the first page load of a session and rejects a send with no receiver yet — the same
 * failure `sendToOffscreen` retries past in demo-recorder.ts.
 */
const WHOAMI_ATTEMPTS = 3;
const WHOAMI_BACKOFF_MS = 50;

/**
 * Learn which tab this content script runs in; returns whether it now knows.
 *
 * There is deliberately no sentinel fallback. A `-1` tab id makes all four keys above
 * process-global, so any `<all_urls>` content script could resume another tab's tour
 * and even redirect it on a `navigate` step, and `chrome.tabs.onRemoved` never cleans a
 * key for a tab that never existed. Callers skip per-tab storage entirely on false.
 */
async function initTabId(): Promise<boolean> {
	for (let attempt = 1; attempt <= WHOAMI_ATTEMPTS; attempt++) {
		try {
			const res = (await browser.runtime.sendMessage({ type: MSG.whoami })) as {
				tabId?: number | null;
			};
			if (typeof res?.tabId === "number") {
				myTabId = res.tabId;
				return true;
			}
		} catch {
			// No receiver yet — fall through to the backoff and ask again.
		}
		if (attempt < WHOAMI_ATTEMPTS) await wait(WHOAMI_BACKOFF_MS * attempt);
	}
	return false;
}

async function loadState(): Promise<PlayState | undefined> {
	const got = await browser.storage.local.get(stateKey());
	return got[stateKey()] as PlayState | undefined;
}
const saveState = (s: PlayState): Promise<void> =>
	browser.storage.local.set({ [stateKey()]: s });
const clearState = (): Promise<void> =>
	browser.storage.local.remove(stateKey());

const setRecording = (on: boolean): Promise<void> =>
	on
		? browser.storage.local.set({ [recKey()]: true })
		: browser.storage.local.remove(recKey());

// --- pending marker capture (survives a client-side auth redirect) ---

/**
 * Left in the pending key by the URL branch instead of removing it outright, so a
 * captureMarkerEarly write for the same marker that resolves later (behind whoami's
 * backoff) can see it and skip instead of resurrecting a consumed tour. Never a usable
 * capture itself — any load that reads one drops it (see resolvePendingMarker).
 */
type PendingMarkerClaim = {
	claimed: true;
	script: TourScript;
	claimedAt: number;
};

type PendingMarkerSlot = PendingMarkerCapture | PendingMarkerClaim;

const isClaim = (v: PendingMarkerSlot | undefined): v is PendingMarkerClaim =>
	!!v && "claimed" in v && v.claimed === true;

// Identity for suppressing a delayed captureMarkerEarly write: the marker payload itself.
const sameScript = (a: TourScript, b: TourScript): boolean =>
	JSON.stringify(a) === JSON.stringify(b);

// Long enough for a real IdP round-trip; short enough that an abandoned tab can't
// resurrect a stale tour on whatever unrelated page loads in it next.
const PENDING_MARKER_TTL_MS = 2 * 60 * 1000;

// Outlasts the claim→delayed-capture gap; short enough not to block a later new tour.
const CLAIM_SUPPRESS_MS = 10_000;

/**
 * Decide what to do with a stored pending capture on this page load: start its tour
 * (still within the TTL, and we're back on its own origin), drop it (expired or a
 * claim — never itself a usable capture), or leave it for a later load (not yet
 * expired, but this page isn't the tour's origin — e.g. we're transiently on an IdP's
 * login page mid-redirect).
 */
export function resolvePendingMarker(
	pending: PendingMarkerSlot | undefined,
	currentUrl: string,
	now: number,
): { action: "consume" | "drop" | "leave"; capture?: PendingMarkerCapture } {
	if (!pending) return { action: "leave" };
	if (isClaim(pending)) return { action: "drop" };
	if (now - pending.capturedAt > PENDING_MARKER_TTL_MS)
		return { action: "drop" };
	if (!sameOrigin(pending.script.startUrl, currentUrl, currentUrl))
		return { action: "leave" };
	return { action: "consume", capture: pending };
}

/**
 * Capture a `_demo` marker off the URL as early as possible (document_start) and
 * strip it immediately — so a client-side auth redirect that rewrites the URL before
 * document_idle runs can't discard the tour along with the fragment it lived in.
 * A no-op when the current URL carries no marker.
 */
export async function captureMarkerEarly(): Promise<void> {
	const markerUrl = location.href;
	const script = readDemoScript(markerUrl);
	if (!script?.steps?.length) return;
	const finishCapture = signalMarkerCapture();
	try {
		// Read every field before stripping; otherwise `_edit=1` becomes false.
		const edit = readEditFlag(markerUrl);
		// Strip before awaiting so page routers cannot replay the marker.
		history.replaceState(history.state, "", stripDemoMarker(markerUrl));
		if (!(await initTabId())) {
			const kept = stripDemoMarker(location.href);
			history.replaceState(
				history.state,
				"",
				`${kept}${kept.includes("#") ? "&" : "#"}${demoMarkerFragment(script, edit)}`,
			);
			return;
		}
		const got = await browser.storage.local.get(pendingMarkerKey());
		const existing = got[pendingMarkerKey()] as PendingMarkerSlot | undefined;
		if (
			isClaim(existing) &&
			sameScript(existing.script, script) &&
			Date.now() - existing.claimedAt < CLAIM_SUPPRESS_MS
		) {
			await browser.storage.local.remove(pendingMarkerKey());
			return;
		}
		const capture: PendingMarkerCapture = {
			script,
			edit,
			capturedAt: Date.now(),
		};
		await browser.storage.local.set({ [pendingMarkerKey()]: capture });
	} finally {
		finishCapture();
	}
}

/** Consume a same-tab pending capture left by captureMarkerEarly, if usable here. */
async function takeUsablePendingMarker(): Promise<
	PendingMarkerCapture | undefined
> {
	const got = await browser.storage.local.get(pendingMarkerKey());
	const pending = got[pendingMarkerKey()] as PendingMarkerSlot | undefined;
	const decision = resolvePendingMarker(pending, location.href, Date.now());
	if (decision.action !== "leave")
		await browser.storage.local.remove(pendingMarkerKey());
	return decision.capture;
}

/** Claim this tab's pending marker as consumed, so a delayed capture write for the
 *  same marker can see it and skip instead of resurrecting a finished tour. */
const claimPendingMarker = (script: TourScript): Promise<void> =>
	browser.storage.local.set({
		[pendingMarkerKey()]: {
			claimed: true,
			script,
			claimedAt: Date.now(),
		} satisfies PendingMarkerClaim,
	});

/** The URL's own marker takes priority; else fall back to an earlier same-tab capture. */
async function resolveEntryMarker(): Promise<
	{ script: TourScript; edit: boolean } | undefined
> {
	let url = location.href;
	let fromUrl = readDemoScript(url);
	if (!fromUrl?.steps?.length) {
		await waitForMarkerCapture();
		url = location.href;
		fromUrl = readDemoScript(url);
	}
	if (fromUrl?.steps?.length) {
		// Snapshot edit alongside fromUrl, before the awaits below: a router that
		// rewrites the fragment during that round trip must not flip _edit=1 to false.
		const edit = readEditFlag(url);
		// Strip before the claim's await, mirroring captureMarkerEarly's item (a) fix.
		// Edit mode keeps it instead — a reload must still re-open the editor (durable).
		if (!edit) {
			history.replaceState(history.state, "", stripDemoMarker(location.href));
		}
		// Claim (not remove): a captureMarkerEarly write still in flight for this
		// marker must see it and skip, not resurrect it (see PendingMarkerClaim).
		await claimPendingMarker(fromUrl);
		return { script: fromUrl, edit };
	}
	const pending = await takeUsablePendingMarker();
	return pending ? { script: pending.script, edit: pending.edit } : undefined;
}

// --- entry point (called by the content script on every page load) ---

export async function runDemoTour(ctx: Ctx): Promise<void> {
	// Every key this reads or writes is per-tab; without an id they would all collide
	// with other tabs, so stay inert rather than touch a shared one.
	if (!(await initTabId())) return;
	const marker = await resolveEntryMarker();
	if (marker) {
		// resolveEntryMarker already stripped the URL (non-edit case) before its own
		// claim-write await — see the ordering comment there.
		await initializeMarkerPlayback(marker.script, saveState);
		await setRecording(false);
		if (marker.edit) await openEditor(ctx, marker.script);
		else await begin(ctx, marker.script);
		return;
	}
	const state = await loadState();
	if (state) await begin(ctx, state.script);
}

let run: AbortController | null = null;
let ui: UiHandle | null = null;
let modalProgress: ModalHandle["update"] | null = null;
let captureWaiter: ((start: CaptureStart) => void) | null = null;
let pendingCapture: CaptureStart | null = null;

function removeUi(): void {
	ui?.remove();
	ui = null;
	modalProgress = null;
}

function abortRun(): void {
	run?.abort();
	run = null;
	captureWaiter = null;
	pendingCapture = null;
	removeUi();
}

/** The extension host: per-tab storage plus consent, end screen, recorder and editor. */
async function tourHost(ctx: Ctx): Promise<TourHost> {
	return {
		...(await wxtHost(ctx, myTabId)),
		actionConsent: true,
		endScreen: true,
		recorder: {
			capture: (signal) =>
				new Promise<CaptureStart>((resolve) => {
					if (pendingCapture) {
						resolve(pendingCapture);
						pendingCapture = null;
						return;
					}
					captureWaiter = resolve;
					signal.addEventListener(
						"abort",
						() => {
							if (captureWaiter === resolve) captureWaiter = null;
						},
						{ once: true },
					);
					promptToRecord(ctx);
				}),
			wrapUp: () =>
				showUi(ctx, (host) =>
					showModal(host, {
						title: "⏺ Wrapping up…",
						body: "Finishing the recording and saving your video. One moment.",
					}),
				),
		},
		openEditor: (script) => openEditor(ctx, script),
	};
}

async function showUi(
	ctx: Ctx,
	mount: (host: TourHost) => Promise<UiHandle>,
): Promise<void> {
	removeUi();
	ui = await mount(await wxtHost(ctx, myTabId));
}

/** Play the tour through @dg/tour-ui; resolves once it waits on the user or ends. */
function startRun(ctx: Ctx, script: TourScript): Promise<void> {
	run?.abort();
	const controller = new AbortController();
	run = controller;
	return new Promise<void>((ready) => {
		void (async () => {
			try {
				const result = await runTour(await tourHost(ctx), script, {
					mode: script.mode ?? "walkthrough",
					signal: controller.signal,
					onIdle: ready,
				});
				if (result.outcome === "error")
					console.error("[dg-ai-extension] demo tour failed", result.error);
			} finally {
				if (run === controller) run = null;
				ready();
			}
		})();
	});
}

async function begin(ctx: Ctx, script: TourScript): Promise<void> {
	// Listen during setup too: the record gesture is refused until handoff, and the
	// explanation has nowhere to land without this.
	if (isVideo(script)) listenForRecorder(ctx);
	await startRun(ctx, script);
}

/** Show the record prompt, reporting rather than swallowing a failure to render it. */
function promptToRecord(ctx: Ctx): void {
	void (async () => {
		const [narration, shortcut] = await Promise.all([
			readNarrationMode(),
			readRecordShortcut(),
		]);
		await showUi(ctx, (host) =>
			showRecordPrompt(host, {
				shortcut,
				narrationLabel: narrationModeLabel(narration),
				shortcutsUrl: shortcutsPageUrl(),
			}),
		);
	})().catch((e) => {
		console.error("[dg-ai-extension] could not show the record prompt", e);
	});
}

async function resume(ctx: Ctx): Promise<void> {
	const state = await loadState();
	if (state) await startRun(ctx, state.script);
	else removeUi();
}

// Setup registers this, then the post-handoff begin() would register it again —
// and two listeners means every videoStart advances the tour twice.
let recorderListening = false;

/** How long the "not ready to record" notice holds the screen before the step returns. */
const BLOCKED_NOTICE_MS = 4000;

/** Longer than the blocked notice — a failure message needs to be readable. */
const ERROR_NOTICE_MS = 7000;

type RecorderMessage = {
	type?: string;
	filename?: string;
	error?: string;
	reason?: string;
	durations?: number[];
	hideBody?: boolean;
	progress?: number;
	label?: string;
	narrate?: boolean;
};

function onCaptureStart(ctx: Ctx, start: CaptureStart): void {
	removeUi();
	const waiter = captureWaiter;
	captureWaiter = null;
	if (waiter) return waiter(start);
	pendingCapture = start;
	void resume(ctx);
}

async function onRecorderMessage(ctx: Ctx, msg: RecorderMessage): Promise<void> {
	switch (msg?.type) {
		case MSG.videoClearUi:
			// Offscreen is about to capture — clear the "preparing" overlay, then
			// confirm after a painted frame so it's never in the recording.
			removeUi();
			clearSpotlight();
			requestAnimationFrame(() =>
				requestAnimationFrame(() =>
					browser.runtime.sendMessage({
						type: MSG.captureCleared,
						target: "background",
					}),
				),
			);
			return;
		case MSG.videoRearm:
			return rearmAfterDiscard(ctx);
		case MSG.videoPreparing: {
			const voiced = msg.narrate !== false;
			await showUi(ctx, async (host) => {
				const modal = await showModal(host, {
					title: voiced ? "⏳ Preparing narration…" : "⏳ Preparing recording…",
					body: voiced
						? "Loading the local voice model and synthesizing each step. The tour will start automatically."
						: "Preparing the tab for capture. The tour will start automatically.",
					progress: 0,
					progressLabel: voiced
						? "Loading local voice model"
						: "Preparing recording",
				});
				modalProgress = modal.update;
				return modal;
			});
			return;
		}
		case MSG.narrationProgress:
			if (typeof msg.progress === "number")
				modalProgress?.(msg.progress, msg.label);
			return;
		case MSG.videoStart:
			return onCaptureStart(ctx, {
				durations: msg.durations ?? [],
				hideBody: msg.hideBody === true,
			});
		case MSG.videoSaved:
			abortRun();
			await clearState();
			await setRecording(false);
			await showUi(ctx, (host) =>
				showModal(host, {
					title: "✅ Recording saved",
					body: `Your demo video was saved to your Downloads folder as ${msg.filename ?? "dg-demo/…webm"}. You can close this tab.`,
				}),
			);
			return;
		case MSG.videoError:
			// Keep the tour: a failed recording used to clear it, so every retry meant
			// walking the whole setup phase again to get back to where it broke.
			abortRun();
			await setRecording(false);
			await showUi(ctx, (host) =>
				showModal(host, {
					title: "⚠️ Recording failed",
					body: msg.error
						? `${msg.error} — the tour is still here, so you can try again.`
						: "The recording could not be saved. The tour is still here, so you can try again.",
				}),
			);
			setTimeout(() => {
				void (async () => {
					if (await loadState()) promptToRecord(ctx);
					else removeUi();
				})();
			}, ERROR_NOTICE_MS);
			return;
		case MSG.videoBlocked:
			abortRun();
			await showUi(ctx, (host) =>
				showModal(host, {
					title: "⏺ Not ready to record yet",
					body: msg.reason ?? "Recording can't start from here yet.",
				}),
			);
			setTimeout(() => void resume(ctx), BLOCKED_NOTICE_MS);
			return;
	}
}

/** Handle background messages that drive video mode. */
function listenForRecorder(ctx: Ctx): void {
	if (recorderListening) return;
	recorderListening = true;
	browser.runtime.onMessage.addListener((msg: RecorderMessage) => {
		void onRecorderMessage(ctx, msg);
	});
}

/** Open the review/edit stepper, wired to this tab's storage and settings. */
async function openEditor(ctx: Ctx, script: TourScript): Promise<void> {
	abortRun();
	const config = await readConfig();
	const handle = await showEditPanel(await wxtHost(ctx, myTabId), script, {
		narration: config.narration,
		voice: config.voice,
		onSetting: (patch) => void patchConfig(patch),
		start: (reviewed) => begin(ctx, reviewed),
	});
	ui = handle;
}

/**
 * Put this tab back where another take can start, after a discard in the review tab.
 *
 * This has to run here rather than in the review page or the background: both
 * outcomes are page overlays that need the content script's `ctx`. Review only
 * decides *that* the user wants another take; the tour tab still decides what that
 * means for it.
 */
export async function rearmAfterDiscard(ctx: Ctx): Promise<void> {
	const s = await loadState();
	await setRecording(false);
	abortRun();
	// Launched from the editor → return there; otherwise re-prompt.
	if (s?.fromEdit) {
		await clearState();
		await openEditor(ctx, s.script);
		return;
	}
	if (s) await saveState({ ...s, index: 0 });
	promptToRecord(ctx);
}
