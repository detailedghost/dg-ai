/** Spotlight + callout renderer shared by the extension and `dg-skills pw`; must stay import-free so `page.evaluateHandle` can run it in a fresh realm. */

/** Color tokens the overlay reads via `var(--…)`; dark is the default, light opts in via `data-theme="light"` on the host. */
export const TOUR_OVERLAY_TOKENS_CSS = `
:host {
  --panel: #111111; --ink: #e8e8e8; --muted: #8a8a8a;
  --line: #e8e8e8; --accent: #00f0ff; --accent2: #ff2bd6; --accent-setup: #ff8c1a; --code-bg: #000000;
}
:host([data-theme="light"]) {
  --panel: #ffffff; --ink: #0a0a0a; --muted: #52525b;
  --line: #0a0a0a; --accent: #0891b2; --accent2: #c026d3; --accent-setup: #c2410c; --code-bg: #f4f4f5;
}`;

const SANS_STACK =
	'-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';

export type TourOverlayPhase = "setup" | "tutorial";

/** Everything the card's content depends on — plain data, never a live script/state object. */
export type TourOverlayStep = {
	scriptTitle?: string;
	index: number;
	total: number;
	heading?: string;
	body: string;
	phase: TourOverlayPhase;
	video: boolean;
	/** Voice-only video recording speaks the body, so the text box is omitted (heading stays). */
	hideBody?: boolean;
	/** The step has an action but its target never resolved. */
	actionMissing?: boolean;
	/** `advance: "click"` is waiting for the user to click the spotlighted target. */
	waitingForClick?: boolean;
};

export type TourOverlayOptions = {
	/** `TOUR_OVERLAY_TOKENS_CSS`, passed as data so this function stays import-free. */
	css: string;
	step: TourOverlayStep;
	/** A live element (same-realm callers), a selector to resolve in-page, or null for a centered card. */
	target: HTMLElement | string | null;
};

export type TourOverlayHandles = {
	layer: HTMLElement;
	highlight: HTMLElement;
	card: HTMLElement;
	/** Re-measure and re-place the card against the target's current position. Call again after adding content (the extension appends controls after this returns) or on scroll/resize. */
	reposition: () => void;
	/** Detach everything this call added. Never removes a caller-supplied root. */
	cleanup: () => void;
};

/** Builds the spotlight highlight + callout card for one tour step. See the module doc for the no-outer-scope rule this function must keep. */
export function renderTourOverlayStep(
	opts: TourOverlayOptions,
	root?: ParentNode,
): TourOverlayHandles {
	const el = <K extends keyof HTMLElementTagNameMap>(
		tag: K,
		style: Partial<CSSStyleDeclaration> = {},
	): HTMLElementTagNameMap[K] => {
		const node = document.createElement(tag);
		Object.assign(node.style, style);
		return node;
	};

	const resolvedTarget =
		typeof opts.target === "string"
			? document.querySelector<HTMLElement>(opts.target)
			: opts.target;

	let host: HTMLElement | undefined;
	let mountRoot: ParentNode;
	if (root) {
		mountRoot = root;
	} else {
		host = document.createElement("div");
		Object.assign(host.style, { all: "initial" } as Partial<CSSStyleDeclaration>);
		document.body.appendChild(host);
		mountRoot = host.attachShadow({ mode: "open" });
	}

	const style = document.createElement("style");
	style.textContent = opts.css;
	mountRoot.appendChild(style);

	const layer = el("div", {
		position: "fixed",
		inset: "0",
		pointerEvents: "none",
		zIndex: "2147483647",
	});

	if (opts.step.video) {
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
		layer.appendChild(wrap);
	}

	const phaseAccent =
		opts.step.phase === "setup" ? "var(--accent-setup)" : "var(--accent)";

	const highlight = el("div", { position: "fixed", pointerEvents: "none" });
	if (resolvedTarget) {
		Object.assign(highlight.style, {
			border: `0.125rem solid ${phaseAccent}`,
			borderRadius: "0",
		});
	} else {
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
		font: `0.8125rem/1.5 ${SANS_STACK}`,
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
	progress.textContent = `${opts.step.scriptTitle ? `${opts.step.scriptTitle} · ` : ""}Step ${opts.step.index + 1} of ${opts.step.total}`;
	card.appendChild(progress);

	if (opts.step.heading) {
		const h = el("div", {
			fontWeight: "700",
			textTransform: "uppercase",
			letterSpacing: "0.04em",
			marginBottom: "0.25rem",
		});
		h.textContent = opts.step.heading;
		card.appendChild(h);
	}

	if (!(opts.step.video && opts.step.hideBody)) {
		const body = el("div", { marginBottom: "0.75rem" });
		body.textContent = opts.step.body;
		card.appendChild(body);
	}

	if (opts.step.actionMissing) {
		const warn = el("div", {
			fontSize: "0.75rem",
			fontWeight: "600",
			color: "var(--accent2)",
			marginBottom: "0.625rem",
		});
		warn.textContent = "⚠ Target not found — this step's action did not run";
		card.appendChild(warn);
	}

	if (opts.step.waitingForClick) {
		const hint = el("div", {
			fontSize: "0.75rem",
			color: "var(--accent)",
			marginBottom: "0.625rem",
		});
		hint.textContent = "↳ Click the highlighted element to continue";
		card.appendChild(hint);
	}

	layer.appendChild(card);
	mountRoot.appendChild(layer);

	const reposition = (): void => {
		if (resolvedTarget) {
			const r = resolvedTarget.getBoundingClientRect();
			Object.assign(highlight.style, {
				left: `${r.left - 6}px`,
				top: `${r.top - 6}px`,
				width: `${r.width + 12}px`,
				height: `${r.height + 12}px`,
			});
		}
		const vw = window.innerWidth;
		const vh = window.innerHeight;
		const cw = card.offsetWidth;
		const ch = card.offsetHeight;
		if (!resolvedTarget) {
			card.style.left = `${(vw - cw) / 2}px`;
			card.style.top = `${(vh - ch) / 2}px`;
			return;
		}
		const r = resolvedTarget.getBoundingClientRect();
		const below = r.bottom + 12;
		const top = below + ch <= vh ? below : Math.max(12, r.top - ch - 12);
		const left = Math.min(Math.max(12, r.left), vw - cw - 12);
		card.style.left = `${left}px`;
		card.style.top = `${top}px`;
	};
	reposition();

	const cleanup = (): void => {
		host?.remove();
	};

	return { layer, highlight, card, reposition, cleanup };
}
