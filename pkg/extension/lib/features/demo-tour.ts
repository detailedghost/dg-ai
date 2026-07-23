/**
 * Demo-tour player. Reads a `_demo` script from the entry URL (or resumes an
 * in-progress tour from storage after a navigation), then walks the steps,
 * spotlighting each target and showing an explanatory callout. Tour state lives
 * in storage.local so it survives page navigations — the content script re-attaches
 * on each load and picks up where it left off. Mirrors the feature-module pattern
 * of tab-grouping.ts; all UI is rendered into a WXT shadow root (no CSS bleed).
 */

import { formatAdvance, parseAdvance, toPlanMarkdown } from "@dg/common";
import { browser } from "wxt/browser";
import { getConfig, NARRATION_MODES, setConfig } from "@/lib/config";
import { MSG } from "@/lib/demo-messages";
import type {
	StepAction,
	TourMode,
	TourScript,
	TourStep,
} from "@/lib/demo-types";
import {
	demoMarkerFragment,
	readDemoScript,
	readEditFlag,
	stripDemoMarker,
} from "@/utils/demo-marker";

const ACCENT = "#6ea8fe";
// Default per-step hold in video mode; a step's numeric `advance` overrides it.
const DEFAULT_VIDEO_MS = 3500;
// Keyboard shortcut the user presses to start recording (see wxt.config commands).
const START_SHORTCUT = "Alt+Shift+D";

const MONO = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

/**
 * Brutalist-neon theme mirroring the settings page (options/style.css): monospace,
 * hard 2px borders, square corners, a hard offset accent shadow. Injected into each
 * overlay's shadow root so inline `var(--…)` styles resolve and stay theme-aware.
 */
const DEMO_THEME_CSS = `
:host {
  --panel: #ffffff; --ink: #0a0a0a; --muted: #52525b;
  --line: #0a0a0a; --accent: #0891b2; --accent2: #c026d3; --code-bg: #f4f4f5;
}
@media (prefers-color-scheme: dark) {
  :host {
    --panel: #111111; --ink: #e8e8e8; --muted: #8a8a8a;
    --line: #e8e8e8; --accent: #00f0ff; --accent2: #ff2bd6; --code-bg: #000000;
  }
}
.dg-field:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 0.125rem var(--accent); }
.dg-btn:hover:not(:disabled) { background: var(--accent); color: #000; border-color: var(--accent); }
.dg-btn:disabled { opacity: 0.5; }
.dg-review-modal {
  position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%);
  width: min(28rem, 90vw); background: var(--panel); color: var(--ink);
  border: 0.125rem solid var(--line); box-shadow: 0.375rem 0.375rem 0 var(--accent);
  padding: 1rem 1.125rem; font: 0.8125rem/1.5 ${MONO}; z-index: 2147483647;
}
.dg-review-modal h3 { margin: 0 0 0.75rem; font-size: 0.9375rem; text-transform: uppercase; letter-spacing: 0.06em; }
.dg-review-actions { display: flex; gap: 0.5rem; margin-top: 0.75rem; }
.dg-review-modal button {
  cursor: pointer; border: 0.125rem solid var(--line); border-radius: 0;
  padding: 0.4375rem 0.75rem; text-transform: uppercase; letter-spacing: 0.06em;
  font: 0.75rem ${MONO}; background: transparent; color: var(--ink);
}
.dg-review-modal button:hover { background: var(--accent); color: #000; border-color: var(--accent); }
.dg-review-modal #dg-review-download { background: var(--accent); color: #000; border-color: var(--accent); }
`;

/** Append the brutalist theme stylesheet to an overlay's shadow root. */
function injectTheme(root: ParentNode): void {
	const style = document.createElement("style");
	style.textContent = DEMO_THEME_CSS;
	root.appendChild(style);
}

// ContentScriptContext is a WXT auto-import (a class value), so alias its instance type.
type Ctx = InstanceType<typeof ContentScriptContext>;

/** Internal tour playback state stored in storage.local (script + step index). */
type PlayState = {
	script: TourScript;
	index: number;
	/** Highest index whose action already ran, so a nav-triggered reload won't repeat it. */
	acted?: number;
	/** Launched from the review editor — a walkthrough end bounces back into it. */
	fromEdit?: boolean;
};

// --- exported pure helpers (testable without browser/DOM) ---

export function getNarrationMode(val: string): "both" | "voice" | "captions" {
	if (val === "voice" || val === "captions") return val;
	return "both";
}

export function reviewAction(action: "confirm" | "discard"): { type: string } {
	return {
		type: action === "confirm" ? MSG.videoConfirmDownload : MSG.videoDiscard,
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

/** Escape text for safe interpolation into an HTML string. */
export function escapeHtml(s: string): string {
	return s.replace(
		/[&<>"']/g,
		(c) =>
			({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
				c
			] as string,
	);
}

export function buildVideoReviewHtml(slug: string, hasVideo: boolean): string {
	const video = hasVideo
		? `<video id="dg-review-video" controls style="max-width:100%;margin-bottom:8px"></video>`
		: `<p style="color:#888">No preview available</p>`;
	return `<div class="dg-review-modal">
  <h3>Review Recording: ${escapeHtml(slug)}</h3>
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
const editKey = () => `demo_edit:${myTabId}`;

/** Read (and clear) the editor's resume cursor — set before a step-driven navigation. */
async function takeEditCursor(): Promise<number> {
	const got = await browser.storage.local.get(editKey());
	await browser.storage.local.remove(editKey());
	const v = got[editKey()];
	return typeof v === "number" ? v : 0;
}
const setEditCursor = (n: number): Promise<void> =>
	browser.storage.local.set({ [editKey()]: n });

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
		const edit = readEditFlag(location.href);
		await saveState({ script: fromMarker, index: 0 });
		await setRecording(false);
		if (edit) {
			// Keep the marker in the URL so a reload re-opens the editor (durable).
			await showEditPanel(ctx, fromMarker);
		} else {
			// Strip the marker in place — same-document, no reload.
			history.replaceState(history.state, "", stripDemoMarker(location.href));
			await begin(ctx, fromMarker);
		}
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
			if (msg?.type === MSG.videoClearUi) {
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
			} else if (msg?.type === MSG.videoReview) {
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
	if (!step) return isVideo(state.script) ? finishVideo(ctx) : finish(ctx);
	// Ensure we're on the step's page — works forward AND back across page
	// boundaries (Back to a step on an earlier page navigates there too).
	const want = expectedUrl(state.script, state.index);
	if (!sameUrl(location.href, want)) {
		// A `_demo` marker is untrusted, so a tour may only drive within its own
		// startUrl origin — never redirect the tab to another site.
		if (!sameOrigin(want, state.script.startUrl)) return finish(ctx);
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

async function finish(ctx: Ctx): Promise<void> {
	removeUi();
	const state = await loadState();
	await clearState();
	// A walkthrough launched from the editor bounces back to it at step 1.
	if (state?.fromEdit) await showEditPanel(ctx, state.script);
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

/** Click the target, or type text into it char-by-char (visible in the recording). */
function performAction(action: StepAction, target: HTMLElement): void {
	if (action.do === "click") {
		target.click();
		return;
	}
	const field = target as HTMLInputElement;
	field.focus();
	field.value = "";
	const text = action.value;
	let i = 0;
	const tick = (): void => {
		if (i >= text.length) return;
		field.value += text[i++];
		field.dispatchEvent(new Event("input", { bubbles: true }));
		setTimeout(tick, 70);
	};
	tick();
}

/** Run a step's action once — guarded so a nav-triggered reload doesn't repeat it. */
async function maybePerformAction(
	state: PlayState,
	step: TourStep,
	target: HTMLElement | null,
): Promise<void> {
	if (!step.action || !target) return;
	if ((state.acted ?? -1) >= state.index) return;
	await saveState({ ...state, acted: state.index });
	const { action } = step;
	setTimeout(() => performAction(action, target), 600);
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
		onMount: (container) => {
			injectTheme(container);
			buildOverlay(container, ctx, state, step, target, cleanups, video);
		},
	});
	ui.mount();
	cleanups.push(() => ui.remove());

	void maybePerformAction(state, step, target);

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

	// Walkthrough is user-paced (Next/Back); numeric timings are video-only, so they
	// don't auto-advance here (a video plan would otherwise self-run and vanish).
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
			border: "0.125rem solid var(--accent)",
			borderRadius: "0",
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
		background: "var(--panel)",
		color: "var(--ink)",
		border: "0.125rem solid var(--line)",
		borderRadius: "0",
		padding: "0.875rem 1rem",
		boxShadow: "0.375rem 0.375rem 0 var(--accent)",
		font: `0.8125rem/1.5 ${MONO}`,
		pointerEvents: "auto",
	});

	const progress = el("div", {
		fontSize: "0.6875rem",
		letterSpacing: "0.12em",
		textTransform: "uppercase",
		fontWeight: "600",
		color: "var(--accent)",
		marginBottom: "0.375rem",
	});
	progress.textContent = `${state.script.title ? `${state.script.title} · ` : ""}Step ${state.index + 1} of ${total}`;
	card.appendChild(progress);

	if (step.title) {
		const h = el("div", {
			fontWeight: "700",
			textTransform: "uppercase",
			letterSpacing: "0.04em",
			marginBottom: "0.25rem",
		});
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
			color: "var(--accent)",
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
		const btn = pillButton;

		const close = btn("✕", false);
		close.title = "End tour";
		close.style.marginRight = "auto";
		close.addEventListener("click", () => void finish(ctx));
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
			injectTheme(root);
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
				background: "var(--panel)",
				color: "var(--ink)",
				border: "0.125rem solid var(--line)",
				borderRadius: "0",
				padding: "1.25rem 1.375rem",
				boxShadow: "0.375rem 0.375rem 0 var(--accent)",
				font: `0.8125rem/1.6 ${MONO}`,
				textAlign: "center",
			});
			const h = el("div", {
				fontSize: "1rem",
				fontWeight: "700",
				textTransform: "uppercase",
				letterSpacing: "0.04em",
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
					color: "var(--muted)",
				});
				const key = el("kbd", {
					background: "var(--code-bg)",
					border: "0.125rem solid var(--line)",
					borderRadius: "0",
					padding: "0.1875rem 0.5rem",
					color: "var(--accent)",
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
			injectTheme(root);
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
				background: "var(--panel)",
				color: "var(--ink)",
				border: "0.125rem solid var(--line)",
				borderRadius: "0",
				padding: "1.25rem 1.375rem",
				boxShadow: "0.375rem 0.375rem 0 var(--accent)",
				font: `0.8125rem/1.6 ${MONO}`,
				textAlign: "center",
			});

			const h = el("div", {
				fontSize: "1rem",
				fontWeight: "700",
				textTransform: "uppercase",
				letterSpacing: "0.04em",
				marginBottom: "0.5rem",
			});
			h.textContent = "🎬 Video demo ready";

			const b = el("div");
			b.textContent =
				"This tour records itself and saves a video to your Downloads. Click the DeeGee toolbar icon — or press the shortcut below — to start recording, then sit back and watch.";

			const narrationRow = el("div", { marginTop: "0.875rem" });
			const label = el("label", {
				fontSize: "0.8125rem",
				textTransform: "uppercase",
				letterSpacing: "0.12em",
				color: "var(--muted)",
			});
			label.setAttribute("for", "dg-narration-mode");
			label.textContent = "Narration";

			const select = el("select", {
				marginLeft: "0.375rem",
				fontSize: "0.8125rem",
				background: "var(--code-bg)",
				color: "var(--ink)",
				border: "0.125rem solid var(--line)",
				borderRadius: "0",
				padding: "0.1875rem 0.375rem",
				font: `0.8125rem ${MONO}`,
			});
			select.className = "dg-field";
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
				color: "var(--muted)",
			});
			const key = el("kbd", {
				background: "var(--code-bg)",
				border: "0.125rem solid var(--line)",
				borderRadius: "0",
				padding: "0.1875rem 0.5rem",
				color: "var(--accent)",
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
			injectTheme(root); // after innerHTML so the style element survives

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
						await setRecording(false);
						removeUi();
						// Launched from the editor → return there; otherwise re-prompt.
						if (s?.fromEdit) {
							await clearState();
							await showEditPanel(ctx, s.script);
						} else {
							if (s) await saveState({ ...s, index: 0 });
							void showStartPrompt(ctx);
						}
					})();
				});
		},
	});
	ui.mount();
	cleanups.push(() => ui.remove());
}

// --- review/edit stepper (opened by the `_edit` marker before playing) ---

const EDIT_SPOT_ID = "dg-edit-spotlight";

/** One editable step row in the panel (strings; timing parses to `advance`). */
export type DraftStep = {
	title: string;
	selector: string;
	body: string;
	timing: string;
	navigate: string;
	actKind: "" | "click" | "fill";
	actText: string;
};
type Draft = { title: string; mode: TourMode; rows: DraftStep[] };

/** Serialize the panel's draft back into a clean, runnable TourScript. */
export function draftToScript(startUrl: string, draft: Draft): TourScript {
	const steps: TourStep[] = draft.rows.map((r) => {
		const step: TourStep = { body: r.body.trim() };
		if (r.title.trim()) step.title = r.title.trim();
		if (r.selector.trim()) step.selector = r.selector.trim();
		if (r.navigate.trim()) step.navigate = r.navigate.trim();
		if (r.actKind === "click") step.action = { do: "click" };
		else if (r.actKind === "fill")
			step.action = { do: "fill", value: r.actText };
		const adv = parseAdvance(r.timing);
		if (adv !== undefined) step.advance = adv;
		return step;
	});
	const out: TourScript = { startUrl, steps, mode: draft.mode };
	if (draft.title.trim()) out.title = draft.title.trim();
	return out;
}

function editSlug(s: string): string {
	return s.replace(/[^a-z0-9-_]+/gi, "-").toLowerCase() || "demo";
}

/** Editor navigation state: a step being reviewed, or the final actions screen. */
export type EditPhase = { kind: "step"; cursor: number } | { kind: "done" };
export type EditEvent = "next" | "back" | "approve" | "editAgain";

/**
 * The review stepper as a generator state machine: it yields the current phase and
 * resumes on each `.next(event)`, applying the transition. All navigation lives here
 * so the flow reads top-to-bottom and is unit-testable without any DOM. Prime with a
 * bare `.next()`, then drive it with events.
 */
export function* editMachine(
	total: number,
): Generator<EditPhase, never, EditEvent> {
	let cursor = 0;
	let done = false;
	while (true) {
		const event = yield done ? { kind: "done" } : { kind: "step", cursor };
		if (event === "approve") done = true;
		else if (event === "editAgain") {
			done = false;
			cursor = Math.max(0, total - 1);
		} else if (!done && event === "next" && cursor < total - 1) cursor++;
		else if (!done && event === "back" && cursor > 0) cursor--;
	}
}

/** Outline the current step's target on the live page (or clear it). */
function updateSpotlight(selector: string): void {
	document.getElementById(EDIT_SPOT_ID)?.remove();
	const t = selector ? document.querySelector<HTMLElement>(selector) : null;
	if (!t) return;
	t.scrollIntoView({ block: "center", inline: "center" });
	const r = t.getBoundingClientRect();
	const box = el("div", {
		position: "fixed",
		left: `${r.left - 6}px`,
		top: `${r.top - 6}px`,
		width: `${r.width + 12}px`,
		height: `${r.height + 12}px`,
		border: `0.125rem solid ${ACCENT}`,
		borderRadius: "0.5rem",
		boxShadow: "0 0 0 624.9375rem rgba(0,0,0,0.45)",
		pointerEvents: "none",
		zIndex: "2147483640",
	});
	box.id = EDIT_SPOT_ID;
	document.body.appendChild(box);
}

function clearSpotlight(): void {
	document.getElementById(EDIT_SPOT_ID)?.remove();
}

/** Whether an element is part of our own overlay UI (skip it while picking). */
function isOurEl(el: Element | null): boolean {
	const tag = el?.tagName?.toLowerCase() ?? "";
	return tag.startsWith("dg-") || (el?.id ?? "").startsWith("dg-");
}

/** A reasonably stable, unique CSS selector for a picked element. */
export function cssSelectorFor(el: Element): string {
	const uniq = (s: string): boolean => {
		try {
			return document.querySelectorAll(s).length === 1;
		} catch {
			return false;
		}
	};
	const attrEsc = (v: string): string => v.replace(/(["\\])/g, "\\$1");
	if (el.id && uniq(`#${CSS.escape(el.id)}`)) return `#${CSS.escape(el.id)}`;
	const tag = el.tagName.toLowerCase();
	for (const a of ["data-testid", "data-test", "aria-label", "name", "role"]) {
		const v = el.getAttribute(a);
		if (v && uniq(`${tag}[${a}="${attrEsc(v)}"]`))
			return `${tag}[${a}="${attrEsc(v)}"]`;
	}
	const parts: string[] = [];
	let node: Element | null = el;
	while (node && node.nodeType === 1) {
		const cur: Element = node;
		if (cur.id) {
			parts.unshift(`#${CSS.escape(cur.id)}`);
			break;
		}
		let part = cur.tagName.toLowerCase();
		const parent: Element | null = cur.parentElement;
		if (parent) {
			const sibs = [...parent.children].filter(
				(c) => c.tagName === cur.tagName,
			);
			if (sibs.length > 1) part += `:nth-of-type(${sibs.indexOf(cur) + 1})`;
		}
		parts.unshift(part);
		if (parts.length >= 6 || !parent || parent === document.documentElement)
			break;
		node = parent;
	}
	return parts.join(" > ");
}

let pickCleanup: (() => void) | null = null;

/** Enter click-to-target mode; `onPick` gets a selector for the clicked element. */
function startPicking(onPick: (selector: string) => void): void {
	pickCleanup?.();
	const hover = el("div", {
		position: "fixed",
		pointerEvents: "none",
		zIndex: "2147483641",
		border: `0.125rem dashed ${ACCENT}`,
		borderRadius: "0.25rem",
		background: "rgba(110,168,254,0.15)",
	});
	hover.id = "dg-pick-hover";
	const banner = el("div", {
		position: "fixed",
		top: "0.875rem",
		left: "50%",
		transform: "translateX(-50%)",
		zIndex: "2147483642",
		pointerEvents: "none",
		background: "rgba(20,10,12,0.9)",
		color: "#fff",
		padding: "0.375rem 0.75rem",
		borderRadius: "62rem",
		font: "600 0.75rem system-ui, sans-serif",
	});
	banner.id = "dg-pick-banner";
	banner.textContent = "Click an element to target · Esc to cancel";
	document.body.append(hover, banner);

	const move = (e: MouseEvent): void => {
		const t = document.elementFromPoint(e.clientX, e.clientY);
		if (!t || isOurEl(t)) {
			hover.style.display = "none";
			return;
		}
		const r = t.getBoundingClientRect();
		Object.assign(hover.style, {
			display: "block",
			left: `${r.left}px`,
			top: `${r.top}px`,
			width: `${r.width}px`,
			height: `${r.height}px`,
		});
	};
	const click = (e: MouseEvent): void => {
		const t = document.elementFromPoint(e.clientX, e.clientY);
		if (isOurEl(t)) return void cleanup(); // clicking our panel cancels picking
		e.preventDefault();
		e.stopPropagation();
		const sel = t ? cssSelectorFor(t) : "";
		cleanup();
		if (sel) onPick(sel);
	};
	const key = (e: KeyboardEvent): void => {
		if (e.key === "Escape") cleanup();
	};
	const cleanup = (): void => {
		document.removeEventListener("mousemove", move, true);
		document.removeEventListener("click", click, true);
		document.removeEventListener("keydown", key, true);
		hover.remove();
		banner.remove();
		pickCleanup = null;
	};
	document.addEventListener("mousemove", move, true);
	document.addEventListener("click", click, true);
	document.addEventListener("keydown", key, true);
	pickCleanup = cleanup;
}

/** A labeled input/textarea; writes back via `onInput` on every keystroke. */
function labeled(
	labelText: string,
	value: string,
	placeholder: string,
	onInput: (v: string) => void,
	multiline = false,
): HTMLElement {
	const wrap = el("div", { marginTop: "0.625rem" });
	const label = el("label", {
		display: "block",
		fontSize: "0.6875rem",
		textTransform: "uppercase",
		letterSpacing: "0.12em",
		color: "var(--muted)",
		marginBottom: "0.25rem",
	});
	label.textContent = labelText;
	const input = multiline
		? el("textarea", { minHeight: "3rem", resize: "vertical" })
		: el("input");
	input.className = "dg-field";
	Object.assign(input.style, {
		width: "100%",
		boxSizing: "border-box",
		background: "var(--code-bg)",
		color: "var(--ink)",
		border: "0.125rem solid var(--line)",
		borderRadius: "0",
		padding: "0.375rem 0.5rem",
		font: `0.8125rem ${MONO}`,
	});
	(input as HTMLInputElement).value = value;
	(input as HTMLInputElement).placeholder = placeholder;
	input.addEventListener("input", () =>
		onInput((input as HTMLInputElement).value),
	);
	wrap.append(label, input);
	return wrap;
}

function pillButton(label: string, primary: boolean): HTMLButtonElement {
	const b = el("button", {
		cursor: "pointer",
		border: "0.125rem solid var(--line)",
		borderRadius: "0",
		padding: "0.4375rem 0.75rem",
		textTransform: "uppercase",
		letterSpacing: "0.06em",
		font: `0.75rem ${MONO}`,
		background: primary ? "var(--accent)" : "transparent",
		color: primary ? "#000" : "var(--ink)",
		borderColor: primary ? "var(--accent)" : "var(--line)",
	});
	b.className = "dg-btn";
	b.type = "button";
	b.textContent = label;
	return b;
}

/** A square chevron nav button; muted + inert when `enabled` is false. */
function arrowButton(
	glyph: string,
	enabled: boolean,
	onClick: () => void,
): HTMLButtonElement {
	const b = el("button", {
		cursor: enabled ? "pointer" : "default",
		border: "0.125rem solid var(--line)",
		borderRadius: "0",
		padding: "0.25rem 0.625rem",
		font: `0.9375rem ${MONO}`,
		background: "transparent",
		color: "var(--ink)",
		opacity: enabled ? "1" : "0.4",
	});
	if (enabled) b.className = "dg-btn";
	b.type = "button";
	b.textContent = glyph;
	if (enabled) b.addEventListener("click", onClick);
	else b.disabled = true;
	return b;
}

/** Selector field with an inline 🎯 picker button that fills the input on click. */
function selectorField(row: DraftStep): HTMLElement {
	const wrap = el("div", { marginTop: "0.625rem" });
	const label = el("label", {
		display: "block",
		fontSize: "0.6875rem",
		textTransform: "uppercase",
		letterSpacing: "0.12em",
		color: "var(--muted)",
		marginBottom: "0.25rem",
	});
	label.textContent = "Selector";
	const inputRow = el("div", { position: "relative" });
	const input = el("input", {
		width: "100%",
		boxSizing: "border-box",
		background: "var(--code-bg)",
		color: "var(--ink)",
		border: "0.125rem solid var(--line)",
		borderRadius: "0",
		padding: "0.375rem 2rem 0.375rem 0.5rem",
		font: `0.8125rem ${MONO}`,
	});
	input.className = "dg-field";
	input.value = row.selector;
	input.placeholder = "CSS selector (blank = centered)";
	input.addEventListener("input", () => {
		row.selector = input.value;
		updateSpotlight(input.value);
	});
	const pick = el("button", {
		position: "absolute",
		right: "0.25rem",
		top: "50%",
		transform: "translateY(-50%)",
		border: "0",
		background: "transparent",
		cursor: "pointer",
		padding: "0 0.25rem",
		fontSize: "0.875rem",
		lineHeight: "1",
	});
	pick.type = "button";
	pick.textContent = "🎯";
	pick.title = "Target element — click, then click something on the page";
	pick.addEventListener("click", () =>
		startPicking((sel) => {
			input.value = sel;
			row.selector = sel;
			updateSpotlight(sel);
			// Programmatic set fires no input event — dispatch one so edits persist.
			input.dispatchEvent(new Event("input", { bubbles: true }));
		}),
	);
	inputRow.append(input, pick);
	wrap.append(label, inputRow);
	return wrap;
}

const FIELD_STYLE: Partial<CSSStyleDeclaration> = {
	width: "100%",
	boxSizing: "border-box",
	background: "var(--code-bg)",
	color: "var(--ink)",
	border: "0.125rem solid var(--line)",
	borderRadius: "0",
	padding: "0.375rem 0.5rem",
	font: `0.8125rem ${MONO}`,
};

/** Action field: a kind selector (none/click/type) + a text box shown for "type". */
function actionField(row: DraftStep): HTMLElement {
	const wrap = el("div", { marginTop: "0.625rem" });
	const label = el("label", {
		display: "block",
		fontSize: "0.6875rem",
		textTransform: "uppercase",
		letterSpacing: "0.12em",
		color: "var(--muted)",
		marginBottom: "0.25rem",
	});
	label.textContent = "Action (during playback)";
	const select = el("select", FIELD_STYLE);
	select.className = "dg-field";
	for (const [val, txt] of [
		["", "None"],
		["click", "Click the target"],
		["fill", "Type text into the target"],
	]) {
		const o = document.createElement("option");
		o.value = val;
		o.textContent = txt;
		if (val === row.actKind) o.selected = true;
		select.appendChild(o);
	}
	const textWrap = el("div", {
		marginTop: "0.375rem",
		display: row.actKind === "fill" ? "block" : "none",
	});
	const text = el("input", FIELD_STYLE);
	text.className = "dg-field";
	text.value = row.actText;
	text.placeholder = "Text to type";
	text.addEventListener("input", () => {
		row.actText = text.value;
	});
	textWrap.appendChild(text);
	select.addEventListener("change", () => {
		row.actKind = select.value as DraftStep["actKind"];
		textWrap.style.display = select.value === "fill" ? "block" : "none";
	});
	wrap.append(label, select, textWrap);
	return wrap;
}

/**
 * The review/edit stepper. Walks the steps one at a time — spotlighting each
 * target on the live page and letting the user improve its fields — then offers
 * Download / Play / Record on a final screen. All local; nothing leaves the tab.
 */
async function showEditPanel(ctx: Ctx, script: TourScript): Promise<void> {
	removeUi();
	const draft: Draft = {
		title: script.title ?? "",
		mode: script.mode ?? "walkthrough",
		rows: (script.steps ?? []).map((s) => ({
			title: s.title ?? "",
			selector: s.selector ?? "",
			body: s.body ?? "",
			timing: formatAdvance(s.advance),
			navigate: s.navigate ?? "",
			actKind: s.action?.do ?? "",
			actText: s.action?.do === "fill" ? s.action.value : "",
		})),
	};
	const machine = editMachine(draft.rows.length);
	let phase = machine.next().value; // prime → first phase (step 0)
	// Resume at the step we navigated for (a step-driven page change reloads us here).
	const resume = await takeEditCursor();
	for (let i = 0; i < resume; i++) phase = machine.next("next").value;
	const dispatch = (event: EditEvent): void => {
		phase = machine.next(event).value;
		void render();
	};

	// The page a step runs on: the most recent `navigate` at/before it, else startUrl.
	const pageUrl = (idx: number): string => {
		for (let i = idx; i >= 0; i--) {
			const nav = draft.rows[i]?.navigate.trim();
			if (nav) return nav;
		}
		return script.startUrl;
	};

	// Mirror the live draft into the URL fragment so a reload re-opens the editor
	// with edits intact (durable-via-URL). Cheap; called on edits + navigation.
	const persist = (): void => {
		const base = location.href.split("#")[0];
		const frag = demoMarkerFragment(
			draftToScript(script.startUrl, draft),
			true,
		);
		history.replaceState(history.state, "", `${base}#${frag}`);
	};

	const finish = async (mode: TourMode): Promise<void> => {
		draft.mode = mode;
		const s = draftToScript(script.startUrl, draft);
		// fromEdit so ending a walkthrough (or discarding a recording) returns here.
		await saveState({ script: s, index: 0, fromEdit: true });
		await setRecording(false);
		clearSpotlight();
		// Drop the edit marker so playback isn't re-intercepted as editing on reload.
		history.replaceState(history.state, "", location.href.split("#")[0]);
		removeUi();
		await begin(ctx, s);
	};

	const download = (): void => {
		const md = toPlanMarkdown(draftToScript(script.startUrl, draft));
		const blob = new Blob([md], { type: "text/markdown" });
		const url = URL.createObjectURL(blob);
		const a = document.createElement("a");
		a.href = url;
		a.download = `${editSlug(draft.title)}.demo.md`;
		a.click();
		setTimeout(() => URL.revokeObjectURL(url), 1000);
	};

	// Remembered across re-renders so the box keeps its dragged position per step.
	let panelPos: { left: number; top: number } | null = null;

	/** Drag `card` by its `handle`, persisting the position into `panelPos`. */
	const makeDraggable = (card: HTMLElement, handle: HTMLElement): void => {
		handle.addEventListener("mousedown", (e) => {
			e.preventDefault();
			const rect = card.getBoundingClientRect();
			const offX = e.clientX - rect.left;
			const offY = e.clientY - rect.top;
			const onMove = (ev: MouseEvent): void => {
				const left = Math.max(0, ev.clientX - offX);
				const top = Math.max(0, ev.clientY - offY);
				panelPos = { left, top };
				Object.assign(card.style, {
					left: `${left}px`,
					top: `${top}px`,
					right: "auto",
					transform: "none",
				});
			};
			const onUp = (): void => {
				document.removeEventListener("mousemove", onMove, true);
				document.removeEventListener("mouseup", onUp, true);
			};
			document.addEventListener("mousemove", onMove, true);
			document.addEventListener("mouseup", onUp, true);
		});
	};

	const panel = (headerText: string): HTMLElement => {
		const card = el("div", {
			position: "fixed",
			top: "50%",
			right: "1.25rem",
			transform: "translateY(-50%)",
			width: "20rem",
			maxHeight: "90vh",
			overflowY: "auto",
			background: "var(--panel)",
			color: "var(--ink)",
			border: "0.125rem solid var(--line)",
			borderRadius: "0",
			padding: "1rem 1.125rem",
			boxShadow: "0.375rem 0.375rem 0 var(--accent)",
			font: `0.8125rem/1.5 ${MONO}`,
			pointerEvents: "auto",
			zIndex: "2147483647",
		});
		if (panelPos)
			Object.assign(card.style, {
				top: `${panelPos.top}px`,
				left: `${panelPos.left}px`,
				right: "auto",
				transform: "none",
			});
		const header = el("div", {
			display: "flex",
			alignItems: "center",
			gap: "0.5rem",
			cursor: "move",
			userSelect: "none",
			marginBottom: "0.625rem",
			paddingBottom: "0.5rem",
			borderBottom: "0.125rem solid var(--line)",
		});
		const grip = el("span", { color: "var(--muted)", letterSpacing: "0.1em" });
		grip.textContent = "⠿";
		const label = el("div", {
			fontSize: "0.6875rem",
			textTransform: "uppercase",
			letterSpacing: "0.18em",
			fontWeight: "600",
			color: "var(--accent)",
		});
		label.textContent = headerText;
		header.append(grip, label);
		card.appendChild(header);
		makeDraggable(card, header);
		return card;
	};

	const buildStepCard = (root: HTMLElement, cursor: number): void => {
		const row = draft.rows[cursor];
		const card = panel("Review & edit");
		const total = draft.rows.length;
		const last = cursor === total - 1;

		if (cursor === 0)
			card.appendChild(
				labeled("Tour title", draft.title, "Tour title", (v) => {
					draft.title = v;
				}),
			);
		card.appendChild(
			labeled("Step title", row.title, "Step title", (v) => {
				row.title = v;
			}),
		);
		card.appendChild(selectorField(row));
		card.appendChild(
			labeled(
				"Body",
				row.body,
				"Callout text",
				(v) => {
					row.body = v;
				},
				true,
			),
		);
		card.appendChild(
			labeled("Timing", row.timing, "4s / click / next", (v) => {
				row.timing = v;
			}),
		);
		// Page URL: pre-filled with the step's effective page. Editing it to a new URL
		// records a `navigate`; matching the inherited page clears it (no redundant nav).
		const inherited = cursor > 0 ? pageUrl(cursor - 1) : script.startUrl;
		card.appendChild(
			labeled(
				"Page URL",
				row.navigate.trim() || inherited,
				"https://…",
				(v) => {
					row.navigate = v.trim() === inherited ? "" : v.trim();
				},
			),
		);
		card.appendChild(actionField(row));

		// No cancel button here on purpose — an accidental click shouldn't drop the
		// editor. The URL keeps the draft (durable), so a stray reload restores it.
		const bar = el("div", {
			display: "flex",
			gap: "0.5rem",
			alignItems: "center",
			justifyContent: "center",
			marginTop: "0.875rem",
		});
		const back = arrowButton("‹", cursor > 0, () => dispatch("back"));
		const trace = el("div", {
			minWidth: "3rem",
			textAlign: "center",
			fontSize: "0.8125rem",
			letterSpacing: "0.08em",
			color: "var(--muted)",
		});
		trace.textContent = `${cursor + 1} / ${total}`;
		const fwd = arrowButton("›", !last, () => dispatch("next"));
		card.addEventListener("input", persist); // persist edits into the URL
		bar.append(back, trace, fwd);
		if (last) {
			const approve = pillButton("✓ Approve", true);
			approve.style.background = "#00c853";
			approve.style.borderColor = "#00c853";
			approve.style.color = "#000";
			approve.addEventListener("click", () => dispatch("approve"));
			bar.appendChild(approve);
		}
		card.appendChild(bar);
		root.appendChild(card);
	};

	const buildDoneCard = (root: HTMLElement): void => {
		const card = panel("Review & edit");
		const h = el("div", {
			fontWeight: "700",
			textTransform: "uppercase",
			letterSpacing: "0.06em",
			marginBottom: "0.25rem",
		});
		h.textContent = "✅ All steps reviewed";
		const sub = el("div", { color: "var(--muted)", marginBottom: "0.75rem" });
		sub.textContent = `${draft.rows.length} step(s). Download the plan, or play/record now.`;
		card.append(h, sub);

		const mk = (lbl: string, primary: boolean, onClick: () => void): void => {
			const b = pillButton(lbl, primary);
			b.style.width = "100%";
			b.style.marginTop = "0.5rem";
			b.addEventListener("click", onClick);
			card.appendChild(b);
		};
		mk("⬇ Download plan (.md)", false, download);
		mk("▶ Play walkthrough", true, () => void finish("walkthrough"));
		mk("⏺ Record video", false, () => void finish("video"));
		mk("← Back to editing", false, () => dispatch("editAgain"));
		root.appendChild(card);
	};

	const render = async (): Promise<void> => {
		// If this step lives on a different page, navigate there and resume the editor
		// at it on reload. Origin+pathname only, so ?query changes don't loop.
		if (phase.kind === "step") {
			const here = new URL(location.href);
			const there = new URL(pageUrl(phase.cursor), location.href);
			if (there.origin === here.origin && there.pathname !== here.pathname) {
				await setEditCursor(phase.cursor);
				const frag = demoMarkerFragment(
					draftToScript(script.startUrl, draft),
					true,
				);
				location.href = `${there.origin}${there.pathname}${there.search}#${frag}`;
				return;
			}
		}
		removeUi();
		persist(); // keep the URL in sync as the user navigates steps
		const cleanups: Array<() => void> = [];
		teardown = () => {
			clearSpotlight();
			for (const c of cleanups) c();
		};
		if (phase.kind === "step")
			updateSpotlight(draft.rows[phase.cursor].selector);
		else clearSpotlight();

		const ui = await createShadowRootUi(ctx, {
			name: "dg-demo-edit",
			position: "overlay",
			anchor: "html",
			zIndex: 2147483647,
			onMount: (root) => {
				injectTheme(root);
				if (phase.kind === "done") buildDoneCard(root);
				else buildStepCard(root, phase.cursor);
			},
		});
		ui.mount();
		cleanups.push(() => ui.remove());
	};

	await render();
}
