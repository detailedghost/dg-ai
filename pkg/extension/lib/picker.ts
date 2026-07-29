import { ACCENT, createEl } from "./ui-helpers";

const MONO = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

/**
 * Brutalist-neon theme mirroring the settings page (options/style.css): monospace,
 * hard 2px borders, square corners, a hard offset accent shadow. Injected into each
 * overlay's shadow root so inline `var(--…)` styles resolve and stay theme-aware.
 */
export const DEMO_THEME_CSS = `
:host {
  --panel: #ffffff; --ink: #0a0a0a; --muted: #52525b;
  --line: #0a0a0a; --accent: #0891b2; --accent2: #c026d3; --accent-setup: #c2410c; --code-bg: #f4f4f5;
}
@media (prefers-color-scheme: dark) {
  :host {
    --panel: #111111; --ink: #e8e8e8; --muted: #8a8a8a;
    --line: #e8e8e8; --accent: #00f0ff; --accent2: #ff2bd6; --accent-setup: #ff8c1a; --code-bg: #000000;
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
export function injectTheme(root: ParentNode): void {
	const style = document.createElement("style");
	style.textContent = DEMO_THEME_CSS;
	root.appendChild(style);
}

/** Minimal selector-query surface accepted by selector safety helpers. */
export type SelectorQueryRoot = {
	querySelector(selectors: string): unknown;
};

/** Query an authored selector without allowing invalid CSS to escape. */
export function safeQuerySelector<T extends Element>(
	root: SelectorQueryRoot,
	selector: string,
): T | null {
	try {
		return root.querySelector(selector) as T | null;
	} catch {
		return null;
	}
}

/** Whether an authored selector is syntactically valid for this document. */
export function isValidSelector(
	root: SelectorQueryRoot,
	selector: string,
): boolean {
	try {
		root.querySelector(selector);
		return true;
	} catch {
		return false;
	}
}

/** Poll for a selector for up to timeoutMs (elements may render after load). */
export function waitForEl(
	selector: string,
	timeoutMs = 1500,
): Promise<HTMLElement | null> {
	let now: HTMLElement | null;
	try {
		now = document.querySelector<HTMLElement>(selector);
	} catch {
		return Promise.resolve(null);
	}
	if (now) return Promise.resolve(now);
	return new Promise((resolve) => {
		const start = Date.now();
		const iv = setInterval(() => {
			const found = safeQuerySelector<HTMLElement>(document, selector);
			if (found || Date.now() - start > timeoutMs) {
				clearInterval(iv);
				resolve(found ?? null);
			}
		}, 100);
	});
}

/**
 * Whether an element belongs to DeeGee UI.
 *
 * The `dg-` tag-name or id prefix is a public convention: picker consumers must
 * use it for planted shadow hosts and other extension-owned chrome so picking
 * skips those elements and mount fallbacks cannot target DeeGee itself.
 */
export function isOurEl(element: Element | null): boolean {
	const tag = element?.tagName?.toLowerCase() ?? "";
	return tag.startsWith("dg-") || (element?.id ?? "").startsWith("dg-");
}

/** A reasonably stable, unique CSS selector for a picked element. */
export function cssSelectorFor(element: Element): string {
	const uniquelySelectsElement = (selector: string): boolean => {
		try {
			const matches = document.querySelectorAll(selector);
			return matches.length === 1 && matches.item(0) === element;
		} catch {
			return false;
		}
	};
	const attrEsc = (value: string): string => value.replace(/(["\\])/g, "\\$1");
	if (element.id && uniquelySelectsElement(`#${CSS.escape(element.id)}`))
		return `#${CSS.escape(element.id)}`;
	const tag = element.tagName.toLowerCase();
	for (const attr of [
		"data-testid",
		"data-test",
		"aria-label",
		"name",
		"role",
	]) {
		const value = element.getAttribute(attr);
		if (value && uniquelySelectsElement(`${tag}[${attr}="${attrEsc(value)}"]`))
			return `${tag}[${attr}="${attrEsc(value)}"]`;
	}
	const parts: string[] = [];
	const prependPart = (current: Element): void => {
		if (current.id) {
			parts.unshift(`#${CSS.escape(current.id)}`);
			return;
		}
		let part = current.tagName.toLowerCase();
		const parent = current.parentElement;
		if (parent) {
			const siblings = [...parent.children].filter(
				(candidate) => candidate.tagName === current.tagName,
			);
			if (siblings.length > 1)
				part += `:nth-of-type(${siblings.indexOf(current) + 1})`;
		}
		parts.unshift(part);
	};

	let node: Element | null = element;
	while (node && node.nodeType === 1) {
		const current: Element = node;
		const parent = current.parentElement;
		prependPart(current);
		if (
			current.id ||
			parts.length >= 6 ||
			!parent ||
			parent === document.documentElement
		) {
			const legacySelector = parts.join(" > ");
			if (uniquelySelectsElement(legacySelector)) return legacySelector;
			node = parent;
			break;
		}
		node = parent;
	}
	while (node && node.nodeType === 1) {
		const current: Element = node;
		prependPart(current);
		const selector = parts.join(" > ");
		if (uniquelySelectsElement(selector)) return selector;
		node = current.parentElement;
	}
	return parts.join(" > ");
}

let pickCleanup: (() => void) | null = null;

/**
 * Enter click-to-target mode; `onPick` gets a selector for the clicked element.
 * `onCancel` lets asynchronous consumers finish cleanly when Escape is pressed.
 */
export function startPicking(
	onPick: (selector: string) => void,
	onCancel: () => void = () => {},
): void {
	pickCleanup?.();
	const hover = createEl("div", {
		position: "fixed",
		pointerEvents: "none",
		zIndex: "2147483641",
		border: `0.125rem dashed ${ACCENT}`,
		borderRadius: "0.25rem",
		background: "rgba(110,168,254,0.15)",
	});
	hover.id = "dg-pick-hover";
	const banner = createEl("div", {
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

	const move = (event: MouseEvent): void => {
		const target = document.elementFromPoint(event.clientX, event.clientY);
		if (!target || isOurEl(target)) {
			hover.style.display = "none";
			return;
		}
		const rect = target.getBoundingClientRect();
		Object.assign(hover.style, {
			display: "block",
			left: `${rect.left}px`,
			top: `${rect.top}px`,
			width: `${rect.width}px`,
			height: `${rect.height}px`,
		});
	};
	const click = (event: MouseEvent): void => {
		const target = document.elementFromPoint(event.clientX, event.clientY);
		if (isOurEl(target)) {
			cancel();
			return;
		}
		event.preventDefault();
		event.stopPropagation();
		const selector = target ? cssSelectorFor(target) : "";
		cleanup();
		if (selector) onPick(selector);
	};
	const key = (event: KeyboardEvent): void => {
		if (event.key === "Escape") cancel();
	};
	const cleanup = (): void => {
		document.removeEventListener("mousemove", move, true);
		document.removeEventListener("click", click, true);
		document.removeEventListener("keydown", key, true);
		hover.remove();
		banner.remove();
		pickCleanup = null;
	};
	const cancel = (): void => {
		cleanup();
		onCancel();
	};
	document.addEventListener("mousemove", move, true);
	document.addEventListener("click", click, true);
	document.addEventListener("keydown", key, true);
	pickCleanup = cancel;
}
