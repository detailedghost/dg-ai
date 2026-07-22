/**
 * Demo-tour player. Reads a `_demo` script from the entry URL (or resumes an
 * in-progress tour from storage after a navigation), then walks the steps,
 * spotlighting each target and showing an explanatory callout. Tour state lives
 * in storage.local so it survives page navigations — the content script re-attaches
 * on each load and picks up where it left off. Mirrors the feature-module pattern
 * of tab-grouping.ts; all UI is rendered into a WXT shadow root (no CSS bleed).
 */

import { browser } from "wxt/browser";
import { MSG } from "@/lib/demo-messages";
import type { TourScript, TourStep } from "@/lib/demo-types";
import { readDemoScript, stripDemoMarker } from "@/utils/demo-marker";
import { getConfig, setConfig, NARRATION_MODES } from "@/lib/config";

const ACCENT = "#6ea8fe";
// Default per-step hold in video mode; a step's numeric `advance` overrides it.
const DEFAULT_VIDEO_MS = 3500;
// Keyboard shortcut the user presses to start recording (see wxt.config commands).
const START_SHORTCUT = "Alt+Shift+D";

// ContentScriptContext is a WXT auto-import (a class value), so alias its instance type.
type Ctx = InstanceType<typeof ContentScriptContext>;

/** Internal tour playback state stored in storage.local (script + step index). */
type PlayState = { script: TourScript; index: number };

// --- exported pure helpers (testable without browser/DOM) ---

export function getNarrationMode(val: string): "both" | "voice" | "captions" {
	if (val === "voice" || val === "captions") return val;
	return "both";
}

export function reviewAction(action: "confirm" | "discard"): { type: string } {
	return {
		type:
			action === "confirm" ? MSG.videoConfirmDownload : MSG.videoDiscard,
	};
}

/** Minimal UI state shape used by handleTourMessage. */
export type TourState = { showingReview?: boolean; [key: string]: unknown };
export type TourStateUpdate = Partial<TourState>;

export function handleTourMessage(
	type: string,
	_state: TourState,
): TourStateUpdate | null {
	if (type === MSG.videoReview) return { showingReview: true };
	if (type === MSG.videoSaved || type === MSG.videoDiscard)
		return { showingReview: false };
	return null;
}

export function buildVideoReviewHtml(slug: string, hasVideo: boolean): string {
	const video = hasVideo
		? `<video id="dg-review-video" controls style="max-width:100%;margin-bottom:8px"></video>`
		: `<p style="color:#888">No preview available</p>`;
	return `<div class="dg-review-modal">
  <h3>Review Recording: ${slug}</h3>
  ${video}
  <div class="dg-review-actions">
    <button id="dg-review-download">Download</button>
    <button id="dg-review-discard">Discard</button>
  </div>
</div>`;
}

// --- end pure helpers ---

const isVideo = (s: TourScript): boolean => s.mode === "video";

/**
 * Persisted tour state (survives navigations within a tour). Keyed per-tab so an
 * active tour never leaks into other tabs — a global key let any <all_urls> content
 * script resume the tour, and even redirect unrelated tabs on a `navigate` step. We
 * ask the background which tab we're in; it also clears these keys on tab close.
 */
let myTabId = -1;
const stateKey = () => `demo_tour:${myTabId}`;
const recKey = () => `demo_recording:${myTabId}`;

// Per-step hold durations (ms) from the recorder, so visuals track the narration.
let videoDurations: number[] = [];
// Voice-only recording: the body text is spoken, so keep it off-screen (title stays).
let videoHideBody = false;

async function initTabId(): Promise<void> {
	try {
		const res = (await browser.runtime.sendMessage({ type: MSG.whoami })) as {
			tabId?: number | null;
		};
		myTabId = res?.tabId ?? -1;
	} catch {
		myTabId = -1;
	}
}

async function loadState(): Promise<PlayState | undefined> {
	const got = await browser.storage.local.get(stateKey());
	return got[stateKey()] as PlayState | undefined;
}
const saveState = (s: PlayState): Promise<void> =>
	browser.storage.local.set({ [stateKey()]: s });
const clearState = (): Promise<void> =>
	browser.storage.local.remove(stateKey());

// Recording flag: set once the user starts capture, so a mid-tour navigation
// resumes auto-play instead of re-showing the "press to start" prompt.
async function isRecording(): Promise<boolean> {
	const got = await browser.storage.local.get(recKey());
	return got[recKey()] === true;
}
const setRecording = (on: boolean): Promise<void> =>
	on
		? browser.storage.local.set({ [recKey()]: true })
		: browser.storage.local.remove(recKey());

/** Whether two URLs share an origin (scheme+host+port). */
function sameOrigin(a: string, b: string): boolean {
	try {
		return (
			new URL(a, location.href).origin === new URL(b, location.href).origin
		);
	} catch {
		return false;
	}
}

/** Same URL ignoring the fragment, so marker-stripping isn't seen as a move. */
function sameUrl(a: string, b: string): boolean {
	try {
		const ua = new URL(a, location.href);
		const ub = new URL(b, location.href);
		return (
			ua.origin + ua.pathname + ua.search ===
			ub.origin + ub.pathname + ub.search
		);
	} catch {
		return a === b;
	}
}

// --- entry point (called by the content script on every page load) ---

export async function runDemoTour(ctx: Ctx): Promise<void> {
	await initTabId();
	const fromMarker = readDemoScript(location.href);
	if (fromMarker?.steps?.length) {
		await saveState({ script: fromMarker, index: 0 });
		await setRecording(false);
		// Strip the marker in place — same-document, no reload.
		history.replaceState(history.state, "", stripDemoMarker(location.href));
		await begin(ctx, fromMarker);
		return;
	}
	const state = await loadState();
	if (state) await begin(ctx, state.script);
}

/** Route to the right start: walkthrough plays immediately; video waits for the gesture. */
async function begin(ctx: Ctx, script: TourScript): Promise<void> {
	if (!isVideo(script)) {
		await playCurrent(ctx);
		return;
	}
	listenForRecorder(ctx);
	// Recording already running (mid-tour navigation) → keep playing; else prompt.
	if (await isRecording()) await playCurrent(ctx);
	else void showStartPrompt(ctx);
}

/** Handle background messages that drive video mode. */
function listenForRecorder(ctx: Ctx): void {
	browser.runtime.onMessage.addListener(
		(msg: {
			type?: string;
			filename?: string;
			error?: string;
			durations?: number[];
			hideBody?: boolean;
			dataUrl?: string;
		}) => {
			if (msg?.type === MSG.videoReview) {
				removeUi();
				void showVideoReview(ctx);
			} else if (msg?.type === MSG.videoPreparing) {
				removeUi();
				void renderModal(ctx, {
					title: "⏳ Preparing narration…",
					body: "Synthesizing voiceover for each step — this takes about a minute on first use. The tour will start automatically.",
				});
			} else if (msg?.type === MSG.videoStart) {
				void (async () => {
					videoDurations = msg.durations ?? [];
					videoHideBody = msg.hideBody === true;
					await setRecording(true);
					removeUi();
					await playCurrent(ctx);
				})();
			} else if (msg?.type === MSG.videoSaved) {
				void (async () => {
					await clearState();
					await setRecording(false);
					removeUi();
					void renderModal(ctx, {
						title: "✅ Recording saved",
						body: `Your demo video was saved to your Downloads folder as ${msg.filename ?? "dg-demo/…webm"}. You can close this tab.`,
					});
				})();
			} else if (msg?.type === MSG.videoError) {
				void (async () => {
					await clearState();
					await setRecording(false);
					removeUi();
					void renderModal(ctx, {
						title: "⚠️ Recording failed",
						body: msg.error
							? `The video could not be saved: ${msg.error}`
							: "The video could not be saved. Please try again.",
					});
				})();
			}
		},
	);
}

/** The URL a step belongs on: the most recent `navigate` at/before it, else startUrl. */
function expectedUrl(script: TourScript, index: number): string {
	for (let i = index; i >= 0; i--) {
		const nav = script.steps[i]?.navigate;
		if (nav) return nav;
	}
	return script.startUrl;
}

async function playCurrent(ctx: Ctx): Promise<void> {
	const state = await loadState();
	if (!state) return removeUi();
	const step = state.script.steps[state.index];
	if (!step) return isVideo(state.script) ? finishVideo(ctx) : finish();
	// Ensure we're on the step's page — works forward AND back across page
	// boundaries (Back to a step on an earlier page navigates there too).
	const want = expectedUrl(state.script, state.index);
	if (!sameUrl(location.href, want)) {
		// A `_demo` marker is untrusted, so a tour may only drive within its own
		// startUrl origin — never redirect the tab to another site.
		if (!sameOrigin(want, state.script.startUrl)) return finish();
		location.href = new URL(want, location.href).href;
		return;
	}
	await renderStep(ctx, state, step);
}

async function goTo(ctx: Ctx, index: number): Promise<void> {
	const state = await loadState();
	if (!state) return;
	await saveState({ ...state, index });
	removeUi();
	await playCurrent(ctx);
}

async function finish(): Promise<void> {
	removeUi();
	await clearState();
}

/** Video tour reached the end: stop the recorder and wait for the saved confirmation. */
function finishVideo(ctx: Ctx): void {
	removeUi();
	void renderModal(ctx, {
		title: "⏺ Wrapping up…",
		body: "Finishing the recording and saving your video. One moment.",
	});
	void browser.runtime.sendMessage({ type: MSG.videoStop });
}

// --- overlay rendering ---

let teardown: (() => void) | null = null;
function removeUi(): void {
	teardown?.();
	teardown = null;
}

function el<K extends keyof HTMLElementTagNameMap>(
	tag: K,
	style: Partial<CSSStyleDeclaration> = {},
): HTMLElementTagNameMap[K] {
	const node = document.createElement(tag);
	Object.assign(node.style, style);
	return node;
}

/** Poll for a selector for up to timeoutMs (elements may render after load). */
function waitForEl(
	selector: string,
	timeoutMs = 1500,
): Promise<HTMLElement | null> {
	const now = document.querySelector<HTMLElement>(selector);
	if (now) return Promise.resolve(now);
	return new Promise((resolve) => {
		const start = Date.now();
		const iv = setInterval(() => {
			const found = document.querySelector<HTMLElement>(selector);
			if (found || Date.now() - start > timeoutMs) {
				clearInterval(iv);
				resolve(found ?? null);
			}
		}, 100);
	});
}

async function renderStep(
	ctx: Ctx,
	state: PlayState,
	step: TourStep,
): Promise<void> {
	const video = isVideo(state.script);
	const target = step.selector ? await waitForEl(step.selector) : null;
	target?.scrollIntoView({ block: "center", inline: "center" });

	// teardown runs every cleanup at call-time, so later pushes are still honored.
	const cleanups: Array<() => void> = [];
	teardown = () => {
		for (const c of cleanups) c();
	};

	const ui = await createShadowRootUi(ctx, {
		name: "dg-demo-tour",
		position: "overlay",
		anchor: "html",
		zIndex: 2147483647,
		onMount: (container) =>
			buildOverlay(container, ctx, state, step, target, cleanups, video),
	});
	ui.mount();
	cleanups.push(() => ui.remove());

	if (video) {
		// Cue this step's narration clip, then hold for its recorder-supplied duration
		// (narration length, floored by any numeric `advance`) before advancing.
		void browser.runtime.sendMessage({
			type: MSG.playStep,
			index: state.index,
		});
		const hold =
			videoDurations[state.index] ??
			(typeof step.advance === "number" ? step.advance : DEFAULT_VIDEO_MS);
		const t = setTimeout(() => void goTo(ctx, state.index + 1), hold);
		cleanups.push(() => clearTimeout(t));
		return;
	}

	// Walkthrough: auto-advance after N ms when `advance` is a number.
	if (typeof step.advance === "number") {
		const t = setTimeout(() => void goTo(ctx, state.index + 1), step.advance);
		cleanups.push(() => clearTimeout(t));
	}
	// "click" — advance when the user clicks the spotlighted target.
	if (step.advance === "click" && target) {
		const onClick = () => void goTo(ctx, state.index + 1);
		target.addEventListener("click", onClick, { once: true });
		cleanups.push(() => target.removeEventListener("click", onClick));
	}
}

function buildOverlay(
	root: HTMLElement,
	ctx: Ctx,
	state: PlayState,
	step: TourStep,
	target: HTMLElement | null,
	cleanups: Array<() => void>,
	video: boolean,
): void {
	const total = state.script.steps.length;
	const last = state.index === total - 1;

	// Full-viewport layer; transparent to clicks so the page stays interactive.
	const layer = el("div", {
		position: "fixed",
		inset: "0",
		pointerEvents: "none",
		zIndex: "2147483647",
	});

	if (video) layer.appendChild(recIndicator());

	const highlight = el("div", { position: "fixed", pointerEvents: "none" });
	if (target) {
		const r = target.getBoundingClientRect();
		Object.assign(highlight.style, {
			left: `${r.left - 6}px`,
			top: `${r.top - 6}px`,
			width: `${r.width + 12}px`,
			height: `${r.height + 12}px`,
			border: `0.125rem solid ${ACCENT}`,
			borderRadius: "0.5rem",
			boxShadow: "0 0 0 624.9375rem rgba(0,0,0,0.55)",
		});
	} else {
		// No target → dim the whole viewport, card is centered.
		Object.assign(highlight.style, {
			inset: "0",
			background: "rgba(0,0,0,0.55)",
		});
	}
	layer.appendChild(highlight);

	const card = el("div", {
		position: "fixed",
		maxWidth: "20rem",
		background: "#1f2430",
		color: "#e6e6e6",
		borderRadius: "0.625rem",
		padding: "0.875rem 1rem",
		boxShadow: "0 0.5rem 1.875rem rgba(0,0,0,0.5)",
		font: "0.875rem/1.5 system-ui, -apple-system, sans-serif",
		pointerEvents: "auto",
	});

	const progress = el("div", {
		fontSize: "0.6875rem",
		letterSpacing: "0.04em",
		textTransform: "uppercase",
		color: "#8a93a6",
		marginBottom: "0.375rem",
	});
	progress.textContent = `${state.script.title ? `${state.script.title} · ` : ""}Step ${state.index + 1} of ${total}`;
	card.appendChild(progress);

	if (step.title) {
		const h = el("div", { fontWeight: "600", marginBottom: "0.25rem" });
		h.textContent = step.title;
		card.appendChild(h);
	}

	// Voice-only recording speaks the body, so omit the text box (title stays).
	if (!(video && videoHideBody)) {
		const body = el("div", { marginBottom: "0.75rem" });
		body.textContent = step.body;
		card.appendChild(body);
	}

	if (step.advance === "click" && target) {
		const hint = el("div", {
			fontSize: "0.75rem",
			color: ACCENT,
			marginBottom: "0.625rem",
		});
		hint.textContent = "↳ Click the highlighted element to continue";
		card.appendChild(hint);
	}

	// Video mode plays hands-free, so no manual controls.
	if (!video) {
		const controls = el("div", {
			display: "flex",
			gap: "0.5rem",
			justifyContent: "flex-end",
			alignItems: "center",
		});
		const btn = (label: string, primary: boolean): HTMLButtonElement => {
			const b = el("button", {
				cursor: "pointer",
				border: "0",
				borderRadius: "0.375rem",
				padding: "0.375rem 0.75rem",
				font: "inherit",
				background: primary ? ACCENT : "transparent",
				color: primary ? "#0b0f17" : "#c7cedb",
			});
			b.textContent = label;
			b.type = "button";
			return b;
		};

		const close = btn("✕", false);
		close.title = "End tour";
		close.style.marginRight = "auto";
		close.addEventListener("click", () => void finish());
		controls.appendChild(close);

		if (state.index > 0) {
			const prev = btn("Back", false);
			prev.addEventListener("click", () => void goTo(ctx, state.index - 1));
			controls.appendChild(prev);
		}
		const next = btn(last ? "Done" : "Next", true);
		next.addEventListener("click", () => void goTo(ctx, state.index + 1));
		controls.appendChild(next);
		card.appendChild(controls);
	}

	layer.appendChild(card);
	root.appendChild(layer);

	positionCard(card, target);
	// Keep the spotlight + card aligned as the page scrolls/resizes.
	const reflow = () => {
		if (target) {
			const r = target.getBoundingClientRect();
			highlight.style.left = `${r.left - 6}px`;
			highlight.style.top = `${r.top - 6}px`;
		}
		positionCard(card, target);
	};
	window.addEventListener("scroll", reflow, { passive: true });
	window.addEventListener("resize", reflow, { passive: true });
	cleanups.push(() => {
		window.removeEventListener("scroll", reflow);
		window.removeEventListener("resize", reflow);
	});
}

/** Place the card under the target if it fits, else above, else centered. */
function positionCard(card: HTMLElement, target: HTMLElement | null): void {
	const vw = window.innerWidth;
	const vh = window.innerHeight;
	const cw = card.offsetWidth;
	const ch = card.offsetHeight;
	if (!target) {
		card.style.left = `${(vw - cw) / 2}px`;
		card.style.top = `${(vh - ch) / 2}px`;
		return;
	}
	const r = target.getBoundingClientRect();
	const below = r.bottom + 12;
	const top = below + ch <= vh ? below : Math.max(12, r.top - ch - 12);
	const left = Math.min(Math.max(12, r.left), vw - cw - 12);
	card.style.left = `${left}px`;
	card.style.top = `${top}px`;
}

// --- video-mode chrome (REC badge + centered modals) ---

function recIndicator(): HTMLElement {
	const wrap = el("div", {
		position: "fixed",
		top: "0.875rem",
		right: "1rem",
		display: "flex",
		alignItems: "center",
		gap: "0.375rem",
		padding: "0.3125rem 0.625rem",
		borderRadius: "62.4375rem",
		background: "rgba(20,10,12,0.82)",
		color: "#ffd7d7",
		font: "600 0.75rem system-ui, sans-serif",
		pointerEvents: "none",
	});
	const dot = el("span", {
		width: "0.5625rem",
		height: "0.5625rem",
		borderRadius: "50%",
		background: "#ff4d4f",
		boxShadow: "0 0 0.375rem #ff4d4f",
	});
	const label = el("span");
	label.textContent = "REC";
	wrap.append(dot, label);
	return wrap;
}

/** Centered dialog on a dimmed backdrop — used for the start prompt and status messages. */
async function renderModal(
	ctx: Ctx,
	opts: { title: string; body: string; kbd?: string },
): Promise<void> {
	removeUi();
	const cleanups: Array<() => void> = [];
	teardown = () => {
		for (const c of cleanups) c();
	};
	const ui = await createShadowRootUi(ctx, {
		name: "dg-demo-modal",
		position: "overlay",
		anchor: "html",
		zIndex: 2147483647,
		onMount: (root) => {
			const layer = el("div", {
				position: "fixed",
				inset: "0",
				background: "rgba(0,0,0,0.6)",
				display: "flex",
				alignItems: "center",
				justifyContent: "center",
				pointerEvents: "auto",
				zIndex: "2147483647",
			});
			const card = el("div", {
				maxWidth: "23.75rem",
				margin: "0 1.25rem",
				background: "#1f2430",
				color: "#e6e6e6",
				borderRadius: "0.75rem",
				padding: "1.25rem 1.375rem",
				boxShadow: "0 0.5rem 1.875rem rgba(0,0,0,0.5)",
				font: "0.875rem/1.6 system-ui, -apple-system, sans-serif",
				textAlign: "center",
			});
			const h = el("div", {
				fontSize: "1rem",
				fontWeight: "600",
				marginBottom: "0.5rem",
			});
			h.textContent = opts.title;
			const b = el("div");
			b.textContent = opts.body;
			card.append(h, b);
			if (opts.kbd) {
				const line = el("div", {
					marginTop: "0.875rem",
					fontSize: "0.8125rem",
					color: "#8a93a6",
				});
				const key = el("kbd", {
					background: "#0b0f17",
					border: "0.0625rem solid #3a4256",
					borderRadius: "0.375rem",
					padding: "0.1875rem 0.5rem",
					color: "#e6e6e6",
					font: "inherit",
				});
				key.textContent = opts.kbd;
				line.append("Shortcut: ", key);
				card.appendChild(line);
			}
			layer.appendChild(card);
			root.appendChild(layer);
		},
	});
	ui.mount();
	cleanups.push(() => ui.remove());
}

/** The "press to start" dialog shown before a video recording begins. */
async function showStartPrompt(ctx: Ctx): Promise<void> {
	removeUi();
	const config = await getConfig();
	const cleanups: Array<() => void> = [];
	teardown = () => {
		for (const c of cleanups) c();
	};
	const ui = await createShadowRootUi(ctx, {
		name: "dg-demo-modal",
		position: "overlay",
		anchor: "html",
		zIndex: 2147483647,
		onMount: (root) => {
			const layer = el("div", {
				position: "fixed",
				inset: "0",
				background: "rgba(0,0,0,0.6)",
				display: "flex",
				alignItems: "center",
				justifyContent: "center",
				pointerEvents: "auto",
				zIndex: "2147483647",
			});
			const card = el("div", {
				maxWidth: "23.75rem",
				margin: "0 1.25rem",
				background: "#1f2430",
				color: "#e6e6e6",
				borderRadius: "0.75rem",
				padding: "1.25rem 1.375rem",
				boxShadow: "0 0.5rem 1.875rem rgba(0,0,0,0.5)",
				font: "0.875rem/1.6 system-ui, -apple-system, sans-serif",
				textAlign: "center",
			});

			const h = el("div", {
				fontSize: "1rem",
				fontWeight: "600",
				marginBottom: "0.5rem",
			});
			h.textContent = "🎬 Video demo ready";

			const b = el("div");
			b.textContent =
				"This tour records itself and saves a video to your Downloads. Click the DeeGee toolbar icon — or press the shortcut below — to start recording, then sit back and watch.";

			const narrationRow = el("div", { marginBottom: "8px" });
			const label = el("label", { fontSize: "13px", color: "#555" });
			label.setAttribute("for", "dg-narration-mode");
			label.textContent = "Narration";

			const select = el("select", { marginLeft: "6px", fontSize: "13px" });
			select.id = "dg-narration-mode";
			for (const { value, label: optLabel } of NARRATION_MODES) {
				const opt = document.createElement("option");
				opt.value = value;
				opt.textContent = optLabel;
				if (value === config.narration) opt.selected = true;
				select.appendChild(opt);
			}
			select.addEventListener("change", () => {
				const narration = getNarrationMode(select.value);
				void setConfig({ ...config, narration });
			});
			narrationRow.append(label, select);

			const line = el("div", {
				marginTop: "0.875rem",
				fontSize: "0.8125rem",
				color: "#8a93a6",
			});
			const key = el("kbd", {
				background: "#0b0f17",
				border: "0.0625rem solid #3a4256",
				borderRadius: "0.375rem",
				padding: "0.1875rem 0.5rem",
				color: "#e6e6e6",
				font: "inherit",
			});
			key.textContent = START_SHORTCUT;
			line.append("Shortcut: ", key);

			card.append(h, b, narrationRow, line);
			layer.appendChild(card);
			root.appendChild(layer);
		},
	});
	ui.mount();
	cleanups.push(() => ui.remove());
}

/** Fetch the recorded data URL from the background and render the review overlay. */
async function showVideoReview(ctx: Ctx): Promise<void> {
	let dataUrl: string | null = null;
	try {
		const res = (await browser.runtime.sendMessage({
			type: MSG.requestVideoData,
		})) as { dataUrl: string | null } | undefined;
		dataUrl = res?.dataUrl ?? null;
	} catch {
		// Render with no preview rather than crashing.
	}

	const state = await loadState();
	const slug =
		state?.script.title ??
		(() => {
			try {
				return new URL(location.href).hostname;
			} catch {
				return "demo";
			}
		})();

	const cleanups: Array<() => void> = [];
	teardown = () => {
		for (const c of cleanups) c();
	};

	const ui = await createShadowRootUi(ctx, {
		name: "dg-demo-review",
		position: "overlay",
		anchor: "html",
		zIndex: 2147483647,
		onMount: (root) => {
			root.innerHTML = buildVideoReviewHtml(slug, dataUrl != null);

			const video = root.querySelector<HTMLVideoElement>("#dg-review-video");
			if (video && dataUrl) video.src = dataUrl;

			root
				.querySelector("#dg-review-download")
				?.addEventListener("click", () => {
					void browser.runtime.sendMessage(reviewAction("confirm"));
					void clearState();
					void setRecording(false);
					removeUi();
				});

			root
				.querySelector("#dg-review-discard")
				?.addEventListener("click", () => {
					void browser.runtime.sendMessage(reviewAction("discard"));
					videoDurations = [];
					videoHideBody = false;
					void (async () => {
						const s = await loadState();
						if (s) await saveState({ ...s, index: 0 });
						await setRecording(false);
						removeUi();
						void showStartPrompt(ctx);
					})();
				});
		},
	});
	ui.mount();
	cleanups.push(() => ui.remove());
}
