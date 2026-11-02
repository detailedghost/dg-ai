import type { TourStep } from "@dg/common";
import {
	automaticPlayback,
	isSetup,
	missingActionTargetWarning,
	type PlayState,
	stateSteps,
} from "./engine";
import type { TourHost } from "./host";
import { injectTheme, waitForEl } from "./picker";
import { createEl as el, SANS } from "./ui-helpers";
import { arrowButton, pillButton } from "./widgets";

/** What the callout's buttons ask the playback flow to do. */
export type StepControls = {
	end(): void;
	restart(): void;
	back(): void;
	next(target: HTMLElement | null): void;
	last(): void;
};

export const INERT_CONTROLS: StepControls = {
	end() {},
	restart() {},
	back() {},
	next() {},
	last() {},
};

export type StepView = {
	target: HTMLElement | null;
	video: boolean;
	remove(): void;
};

/** Mounts one step's spotlight and callout through the host. */
export async function renderStep(
	host: TourHost,
	state: PlayState,
	step: TourStep,
	actions: StepControls = INERT_CONTROLS,
): Promise<StepView> {
	const video = automaticPlayback(state);
	const target = step.selector ? await waitForEl(step.selector) : null;
	target?.scrollIntoView({ block: "center", inline: "center" });

	if (step.action && !target) console.warn(missingActionTargetWarning(step));

	const cleanups: Array<() => void> = [];
	const ui = await host.mountUi("dg-demo-tour", (container) => {
		injectTheme(container);
		buildOverlay(container, actions, state, step, target, cleanups, video);
	});
	cleanups.push(() => ui.remove());
	return {
		target,
		video,
		remove: () => {
			for (const c of cleanups) c();
		},
	};
}

/** Builds the spotlight + callout card into `root`. Exported for direct DOM tests. */
export function buildOverlay(
	root: HTMLElement,
	actions: StepControls,
	state: PlayState,
	step: TourStep,
	target: HTMLElement | null,
	cleanups: Array<() => void>,
	video: boolean,
): void {
	const total = stateSteps(state).length;
	const last = state.index === total - 1;

	// Full-viewport layer; transparent to clicks so the page stays interactive.
	const layer = el("div", {
		position: "fixed",
		inset: "0",
		pointerEvents: "none",
		zIndex: "2147483647",
	});

	if (video) layer.appendChild(recIndicator());

	// Setup and tutorial share this overlay but must read as different moments —
	// orange marks "preparation, not the demo yet", blue is the tour proper.
	const phaseAccent = isSetup(state) ? "var(--accent-setup)" : "var(--accent)";

	const highlight = el("div", { position: "fixed", pointerEvents: "none" });
	if (target) {
		const r = target.getBoundingClientRect();
		Object.assign(highlight.style, {
			left: `${r.left - 6}px`,
			top: `${r.top - 6}px`,
			width: `${r.width + 12}px`,
			height: `${r.height + 12}px`,
			border: `0.125rem solid ${phaseAccent}`,
			borderRadius: "0",
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
		boxShadow: `0.375rem 0.375rem 0 ${phaseAccent}`,
		font: `0.8125rem/1.5 ${SANS}`,
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
	if (!(video && state.videoHideBody && !state.videoUnvoiced?.includes(state.index))) {
		const body = el("div", { marginBottom: "0.75rem" });
		body.textContent = step.body;
		card.appendChild(body);
	}

	if (step.action && !target) {
		const warn = el("div", {
			fontSize: "0.75rem",
			fontWeight: "600",
			color: "var(--accent2)",
			marginBottom: "0.625rem",
		});
		warn.textContent = "⚠ Target not found — this step's action did not run";
		card.appendChild(warn);
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
		close.addEventListener("click", () => actions.end());
		controls.appendChild(close);

		// Only the single-step pair is tinted — ‹ --accent2, › --accent. The jump
		// controls stay untinted so color marks stepping, not direction alone.
		controls.appendChild(
			arrowButton(
				"«",
				state.index > 0,
				() => actions.restart(),
				"Restart at the first step",
			),
		);
		controls.appendChild(
			arrowButton(
				"‹",
				state.index > 0,
				() => actions.back(),
				"Previous step",
				"var(--accent2)",
			),
		);
		// Forward runs the step's action (or the click it waits for), so arrow-stepping can't skip it.
		controls.appendChild(
			arrowButton(
				"›",
				!last,
				() => actions.next(target),
				"Next step",
				"var(--accent)",
			),
		);
		controls.appendChild(
			arrowButton(
				"»",
				!last,
				() => actions.last(),
				"Run to the last step",
			),
		);
		// Only affordance that ends the tour, so it stays a labelled button.
		if (last) {
			const done = btn("Done", true);
			done.addEventListener(
				"click",
				() => actions.next(target),
			);
			controls.appendChild(done);
		}
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
export function positionCard(card: HTMLElement, target: HTMLElement | null): void {
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

export function recIndicator(): HTMLElement {
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
