import {
	type ProtoVariation,
	type StyleGuide,
	type Verdict,
	validateProtoPlan,
	validateStyleGuide,
	validateVerdict,
} from "@dg/common";
import { browser } from "wxt/browser";
import { callBrowserApi } from "../browser-call";
import { injectTheme, startPicking, waitForEl } from "../picker";

/** Content-to-background message requesting a local StyleGuide download. */
export const PROTO_SAVE_STYLE_GUIDE = "dg-proto:save-style-guide";
/** Content-to-background message requesting a local verdict download. */
export const PROTO_SAVE_VERDICT = "dg-proto:save-verdict";
/** Content-to-background message requesting an optional visible-tab preview. */
export const PROTO_CAPTURE_PREVIEW = "dg-proto:capture-preview";

/** Raw, bounded DOM/CSS observations consumed by the pure StyleGuide transform. */
export type RawStyleSamples = {
	meta: StyleGuide["meta"];
	customProps: Record<string, string>;
	colors: string[];
	fontStacks: string[];
	typeScale: string[];
	spacing: string[];
	radii: string[];
	shadows: string[];
	components: StyleGuide["components"];
};

function channel(value: string): number | undefined {
	const parsed = Number.parseFloat(value);
	if (!Number.isFinite(parsed)) return undefined;
	const scaled = value.endsWith("%") ? (parsed / 100) * 255 : parsed;
	return Math.round(Math.max(0, Math.min(255, scaled)));
}

function alpha(value: string | undefined): number {
	if (value === undefined) return 1;
	const parsed = Number.parseFloat(value);
	if (!Number.isFinite(parsed)) return 1;
	const scaled = value.endsWith("%") ? parsed / 100 : parsed;
	return Math.max(0, Math.min(1, scaled));
}

/** Normalize computed/hex colors before frequency counting. */
export function normalizeColor(value: string): string | undefined {
	const color = value.trim().toLowerCase();
	if (color === "transparent") return "rgba(0, 0, 0, 0)";

	const hex = /^#([a-f0-9]{3,8})$/i.exec(color)?.[1];
	if (hex && [3, 4, 6, 8].includes(hex.length)) {
		const expanded =
			hex.length <= 4 ? [...hex].map((part) => `${part}${part}`).join("") : hex;
		const red = Number.parseInt(expanded.slice(0, 2), 16);
		const green = Number.parseInt(expanded.slice(2, 4), 16);
		const blue = Number.parseInt(expanded.slice(4, 6), 16);
		const opacity =
			expanded.length === 8
				? Number.parseInt(expanded.slice(6, 8), 16) / 255
				: 1;
		return colorString(red, green, blue, opacity);
	}

	const functional = /^rgba?\((.*)\)$/i.exec(color);
	if (!functional) return undefined;
	const parts = functional[1]
		.replaceAll(",", " ")
		.replace("/", " / ")
		.trim()
		.split(/\s+/);
	const slash = parts.indexOf("/");
	const colorParts = slash < 0 ? parts.slice(0, 3) : parts.slice(0, slash);
	const opacityPart = slash < 0 ? parts[3] : parts[slash + 1];
	if (colorParts.length !== 3) return undefined;
	const channels = colorParts.map(channel);
	if (channels.some((part) => part === undefined)) return undefined;
	return colorString(
		channels[0]!,
		channels[1]!,
		channels[2]!,
		alpha(opacityPart),
	);
}

function colorString(
	red: number,
	green: number,
	blue: number,
	opacity: number,
): string {
	if (opacity >= 1) return `rgb(${red}, ${green}, ${blue})`;
	const stableAlpha = Number(opacity.toFixed(3));
	return `rgba(${red}, ${green}, ${blue}, ${stableAlpha})`;
}

function frequencyRank(
	values: string[],
	normalize: (value: string) => string | undefined = (value) =>
		value.trim() || undefined,
): string[] {
	const frequencies = new Map<string, { count: number; first: number }>();
	for (const [index, raw] of values.entries()) {
		const value = normalize(raw);
		if (!value) continue;
		const current = frequencies.get(value);
		if (current) current.count += 1;
		else frequencies.set(value, { count: 1, first: index });
	}
	return [...frequencies.entries()]
		.sort((left, right) => {
			const count = right[1].count - left[1].count;
			return count !== 0 ? count : left[1].first - right[1].first;
		})
		.map(([value]) => value);
}

function quantizeLengths(values: string[]): string[] {
	return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort(
		(left, right) => {
			const numeric = Number.parseFloat(left) - Number.parseFloat(right);
			return Number.isNaN(numeric) || numeric === 0
				? left.localeCompare(right)
				: numeric;
		},
	);
}

function sortedRecord(record: Record<string, string>): Record<string, string> {
	const sorted = Object.create(null) as Record<string, string>;
	for (const key of Object.keys(record).sort()) sorted[key] = record[key];
	return sorted;
}

/** Convert raw page observations into a deterministic, validated StyleGuide. */
export function styleGuideFromSamples(samples: RawStyleSamples): StyleGuide {
	const guide: StyleGuide = {
		meta: { ...samples.meta },
		tokens: {
			customProps: sortedRecord(samples.customProps),
			colors: frequencyRank(samples.colors, normalizeColor),
			fontStack: frequencyRank(samples.fontStacks)[0] ?? "",
			typeScale: quantizeLengths(samples.typeScale),
			spacing: quantizeLengths(samples.spacing),
			radii: quantizeLengths(samples.radii),
			shadows: frequencyRank(samples.shadows),
		},
		components: {
			button: sortedRecord(samples.components.button),
			input: sortedRecord(samples.components.input),
			link: sortedRecord(samples.components.link),
		},
	};
	return validateStyleGuide(guide);
}

const FIXED_ROSTER = "body,h1,h2,h3,h4,h5,h6,p,a,button,input";
/** Hard work/output bounds for live-page style sampling. */
export const PROTO_STYLE_SCAN_LIMITS = Object.freeze({
	domElements: 500,
	fixedRoster: 64,
	cards: 3,
	rootStyleProperties: 512,
	customProperties: 128,
});

function hasVisibleBorder(style: CSSStyleDeclaration): boolean {
	return [
		[style.borderTopWidth, style.borderTopStyle],
		[style.borderRightWidth, style.borderRightStyle],
		[style.borderBottomWidth, style.borderBottomStyle],
		[style.borderLeftWidth, style.borderLeftStyle],
	].some(
		([width, borderStyle]) =>
			Number.parseFloat(width) > 0 && borderStyle !== "none",
	);
}

function boundedDescendants(root: Element, limit: number): Element[] {
	const elements: Element[] = [];
	let current: Element | null = root.firstElementChild;
	while (current && elements.length < limit) {
		elements.push(current);
		if (current.firstElementChild) {
			current = current.firstElementChild;
			continue;
		}
		while (current && current !== root && current.nextElementSibling === null) {
			current = current.parentElement;
		}
		current = current && current !== root ? current.nextElementSibling : null;
	}
	return elements;
}

function largestVisibleCards(elements: Element[]): Element[] {
	const bodyStyle = getComputedStyle(document.body);
	const bodyBackground = bodyStyle.backgroundColor;
	const candidates: Array<{ element: Element; area: number }> = [];
	for (const element of elements) {
		const style = getComputedStyle(element);
		const rect = element.getBoundingClientRect();
		const area = rect.width * rect.height;
		const blockLike =
			style.display !== "none" &&
			style.display !== "inline" &&
			style.display !== "contents";
		const visible =
			blockLike &&
			style.visibility !== "hidden" &&
			Number.parseFloat(style.opacity || "1") > 0 &&
			area > 0;
		const cardLike =
			hasVisibleBorder(style) ||
			(!!style.boxShadow && style.boxShadow !== "none") ||
			(style.backgroundColor !== "rgba(0, 0, 0, 0)" &&
				style.backgroundColor !== "transparent" &&
				style.backgroundColor !== bodyBackground);
		if (visible && cardLike) candidates.push({ element, area });
	}

	const selected: Element[] = [];
	while (selected.length < PROTO_STYLE_SCAN_LIMITS.cards) {
		let largest: (typeof candidates)[number] | undefined;
		for (const candidate of candidates) {
			if (
				selected.some(
					(element) =>
						element.contains(candidate.element) ||
						candidate.element.contains(element),
				)
			) {
				continue;
			}
			if (!largest || candidate.area > largest.area) largest = candidate;
		}
		if (!largest) break;
		selected.push(largest.element);
	}
	return selected;
}

function componentSample(
	element: Element | null,
	properties: string[],
): Record<string, string> {
	if (!element) return {};
	const style = getComputedStyle(element);
	const sample: Record<string, string> = {};
	for (const property of properties) {
		const value = style.getPropertyValue(property).trim();
		if (value) sample[property] = value;
	}
	return sample;
}

/** Thin DOM collector; real-page coverage remains a manual/E2E contract. */
export function collectStyleSamples(): RawStyleSamples {
	const rootStyle = getComputedStyle(document.documentElement);
	const customProps: Record<string, string> = {};
	let customPropertyCount = 0;
	for (
		let index = 0;
		index <
			Math.min(rootStyle.length, PROTO_STYLE_SCAN_LIMITS.rootStyleProperties) &&
		customPropertyCount < PROTO_STYLE_SCAN_LIMITS.customProperties;
		index += 1
	) {
		const property = rootStyle.item(index);
		if (!property.startsWith("--")) continue;
		customProps[property] = rootStyle.getPropertyValue(property).trim();
		customPropertyCount += 1;
	}

	/**
	 * Bound large-page work to one deterministic DOM-order prefix. Worst case:
	 * inspect 512 root properties and read 500 scan styles + 64 roster + 3 cards
	 * + root/body + 3 component styles. At most 128 custom properties are emitted.
	 */
	const scanned = boundedDescendants(
		document.body,
		PROTO_STYLE_SCAN_LIMITS.domElements,
	);
	const fixedRoster = [
		document.body,
		...scanned
			.filter((element) => element.matches(FIXED_ROSTER))
			.slice(0, PROTO_STYLE_SCAN_LIMITS.fixedRoster - 1),
	];
	const elements = [
		...new Set<Element>([...fixedRoster, ...largestVisibleCards(scanned)]),
	].sort((left, right) => {
		if (left === right) return 0;
		return left.compareDocumentPosition(right) & 4 ? -1 : 1;
	});
	const colors: string[] = [];
	const fontStacks: string[] = [];
	const typeScale: string[] = [];
	const spacing: string[] = [];
	const radii: string[] = [];
	const shadows: string[] = [];

	for (const element of elements) {
		const style = getComputedStyle(element);
		colors.push(style.color, style.backgroundColor, style.borderTopColor);
		fontStacks.push(style.fontFamily);
		typeScale.push(style.fontSize);
		spacing.push(
			style.marginTop,
			style.marginRight,
			style.marginBottom,
			style.marginLeft,
			style.paddingTop,
			style.paddingRight,
			style.paddingBottom,
			style.paddingLeft,
			style.gap,
		);
		radii.push(style.borderRadius);
		if (style.boxShadow !== "none") shadows.push(style.boxShadow);
	}

	const sharedProperties = [
		"color",
		"background-color",
		"border",
		"border-radius",
		"box-shadow",
		"font-family",
		"font-size",
		"font-weight",
		"padding",
	];

	return {
		meta: {
			url: location.href,
			scrapedAt: Date.now(),
			sameOrigin: true,
		},
		customProps,
		colors,
		fontStacks,
		typeScale,
		spacing,
		radii,
		shadows,
		components: {
			button: componentSample(
				document.querySelector("button"),
				sharedProperties,
			),
			input: componentSample(document.querySelector("input"), sharedProperties),
			link: componentSample(document.querySelector("a"), sharedProperties),
		},
	};
}

/** Collect and transform the current page's bounded visual-style sample. */
export function scrapeStyleGuide(): StyleGuide {
	return styleGuideFromSamples(collectStyleSamples());
}

const PROTOTYPE_TAGS = new Set([
	"a",
	"article",
	"aside",
	"b",
	"blockquote",
	"br",
	"button",
	"code",
	"dd",
	"details",
	"div",
	"dl",
	"dt",
	"em",
	"fieldset",
	"figcaption",
	"figure",
	"footer",
	"h1",
	"h2",
	"h3",
	"h4",
	"h5",
	"h6",
	"header",
	"hr",
	"i",
	"img",
	"input",
	"label",
	"legend",
	"li",
	"main",
	"nav",
	"ol",
	"option",
	"p",
	"pre",
	"section",
	"select",
	"small",
	"span",
	"strong",
	"sub",
	"summary",
	"sup",
	"table",
	"tbody",
	"td",
	"textarea",
	"tfoot",
	"th",
	"thead",
	"tr",
	"u",
	"ul",
]);
const PROTOTYPE_DROP_TAGS = new Set([
	"base",
	"embed",
	"iframe",
	"link",
	"math",
	"meta",
	"object",
	"script",
	"style",
	"svg",
	"template",
]);
const PROTOTYPE_GLOBAL_ATTRIBUTES = new Set([
	"aria-atomic",
	"aria-busy",
	"aria-checked",
	"aria-controls",
	"aria-current",
	"aria-describedby",
	"aria-disabled",
	"aria-expanded",
	"aria-haspopup",
	"aria-hidden",
	"aria-label",
	"aria-labelledby",
	"aria-live",
	"aria-modal",
	"aria-pressed",
	"aria-selected",
	"class",
	"data-kind",
	"dir",
	"hidden",
	"id",
	"lang",
	"role",
	"style",
	"tabindex",
	"title",
]);
const PROTOTYPE_TAG_ATTRIBUTES: Record<string, Set<string>> = {
	a: new Set(["href"]),
	button: new Set(["disabled", "name", "type", "value"]),
	img: new Set(["alt", "height", "src", "width"]),
	input: new Set([
		"checked",
		"disabled",
		"max",
		"maxlength",
		"min",
		"minlength",
		"name",
		"placeholder",
		"readonly",
		"step",
		"type",
		"value",
	]),
	label: new Set(["for"]),
	option: new Set(["disabled", "label", "selected", "value"]),
	select: new Set(["disabled", "multiple", "name"]),
	td: new Set(["colspan", "rowspan"]),
	textarea: new Set([
		"cols",
		"disabled",
		"maxlength",
		"name",
		"placeholder",
		"readonly",
		"rows",
	]),
	th: new Set(["colspan", "rowspan", "scope"]),
};

function safePrototypeUrl(
	tagName: string,
	name: string,
	value: string,
): boolean {
	const compact = [...value]
		.filter((character) => {
			const code = character.charCodeAt(0);
			return code > 0x20 && code !== 0x7f;
		})
		.join("");
	if (tagName === "img" && name === "src") {
		return /^data:image\/(?:avif|gif|jpeg|png|webp);base64,/i.test(compact);
	}
	return tagName === "a" && name === "href" && compact.startsWith("#");
}

function decodePrototypeCssEscapes(css: string): string {
	return css
		.replace(/\\([0-9a-f]{1,6})[ \t\n\r\f]?/gi, (_match, hex: string) => {
			const codePoint = Number.parseInt(hex, 16);
			return codePoint > 0 && codePoint <= 0x10ffff
				? String.fromCodePoint(codePoint)
				: "\ufffd";
		})
		.replace(/\\([^0-9a-f\n\r\f])/gi, "$1");
}

const SHADOW_ESCAPE_SELECTOR = /:host(?:-context)?\b|::slotted\b/i;

function stripShadowEscapeRules(css: string): string {
	let current = css;
	let previous: string;
	do {
		previous = current;
		current = current.replace(
			/(^|[{}])([^{}]*(?::host(?:-context)?\b|::slotted\b)[^{}]*)\{[^{}]*\}/gi,
			"$1",
		);
	} while (current !== previous);

	// Nested/novel rule syntax that still carries a shadow escape selector is
	// rejected as a whole rather than risking a partial parser disagreement.
	return SHADOW_ESCAPE_SELECTOR.test(current) ? "" : current;
}

function sanitizePrototypeCss(css: string, scoped = true): string {
	const sanitized = stripShadowEscapeRules(
		decodePrototypeCssEscapes(css)
			.replace(/\/\*[\s\S]*?\*\//g, "")
			.replace(/@import\b[^;]*(?:;|$)/gi, "")
			.replace(/@font-face\s*\{[^}]*\}/gi, "")
			.replace(/(?:url|image-set|-webkit-image-set)\s*\([^)]*\)/gi, "none")
			.replace(/(?:behavior|-moz-binding)\s*:[^;}]+;?/gi, "")
			.replace(
				/(position\s*:\s*)(?:fixed|absolute|var\s*\([^)]*\))(\s*!important)?/gi,
				"$1static$2",
			)
			.replace(
				/(z-index\s*:\s*)([^;}]+)/gi,
				(match, prefix: string, raw: string) => {
					const numeric = Number(raw.replace(/!important/gi, "").trim());
					return Number.isFinite(numeric) && Math.abs(numeric) <= 1000
						? match
						: `${prefix}0`;
				},
			)
			.replaceAll("<", "\\3C ")
			.replaceAll("-->", "--\\3E "),
	);
	if (!scoped) return sanitized;
	return sanitized.trim()
		? `@scope ([data-dg-prototype]) {\n${sanitized}\n}`
		: "";
}

/**
 * Authoritative browser-side sanitizer for attacker-reachable marker content.
 * The CLI pre-filter is only a size/risk reduction pass; this allowlist is the
 * security boundary immediately before rendering.
 */
export function sanitizePrototypeVariation(
	variation: ProtoVariation,
): ProtoVariation {
	const parsed = new DOMParser().parseFromString(variation.html, "text/html");
	for (const element of [...parsed.body.querySelectorAll("*")]) {
		const tagName = element.tagName.toLowerCase();
		if (PROTOTYPE_DROP_TAGS.has(tagName)) {
			element.remove();
			continue;
		}
		if (!PROTOTYPE_TAGS.has(tagName)) {
			element.replaceWith(...element.childNodes);
			continue;
		}

		for (const attribute of [...element.attributes]) {
			const name = attribute.name.toLowerCase();
			const allowed =
				prototypeAttributeAllowed(name, tagName) &&
				!name.startsWith("on") &&
				!["formaction", "srcdoc", "srcset", "xlink:href"].includes(name);
			if (!allowed) {
				element.removeAttribute(attribute.name);
				continue;
			}
			if (
				(name === "href" || name === "src") &&
				!safePrototypeUrl(tagName, name, attribute.value)
			) {
				element.removeAttribute(attribute.name);
				continue;
			}
			if (name === "style") {
				const sanitized = sanitizePrototypeCss(attribute.value, false);
				if (sanitized.trim()) element.setAttribute("style", sanitized);
				else element.removeAttribute("style");
			}
		}
	}

	return {
		...variation,
		html: parsed.body.innerHTML,
		css: sanitizePrototypeCss(variation.css),
	};
}

function prototypeAttributeAllowed(name: string, tagName: string): boolean {
	return (
		PROTOTYPE_GLOBAL_ATTRIBUTES.has(name) ||
		name.startsWith("data-") ||
		name.startsWith("aria-") ||
		(PROTOTYPE_TAG_ATTRIBUTES[tagName]?.has(name) ?? false)
	);
}

/** Immutable selection state for the planted comparison picker. */
export type PrototypePickerState = {
	keys: string[];
	currentIndex: number;
	selectedKey: string | null;
	approved: boolean;
};

/** User navigation and approval actions accepted by the picker state machine. */
export type PrototypePickerAction =
	| { type: "previous" }
	| { type: "next" }
	| { type: "select" }
	| { type: "approve" };

/** Pure immutable state transition used by the planted picker UI. */
export function pickerMachine(
	state: PrototypePickerState,
	action: PrototypePickerAction,
): PrototypePickerState {
	const count = state.keys.length;
	if (action.type === "previous") {
		return {
			...state,
			currentIndex: count === 0 ? 0 : (state.currentIndex - 1 + count) % count,
			selectedKey: null,
			approved: false,
		};
	}
	if (action.type === "next") {
		return {
			...state,
			currentIndex: count === 0 ? 0 : (state.currentIndex + 1) % count,
			selectedKey: null,
			approved: false,
		};
	}
	if (action.type === "select") {
		return {
			...state,
			selectedKey: state.keys[state.currentIndex] ?? null,
			approved: false,
		};
	}
	return state.selectedKey ? { ...state, approved: true } : { ...state };
}

/** Resolve the variation a verdict applies to without weakening approval gates. */
export function pickerVerdictKey(
	state: PrototypePickerState,
	action: "approve" | "reject",
): string | null {
	return action === "approve"
		? state.selectedKey
		: (state.keys[state.currentIndex] ?? null);
}

type VerdictInput = {
	slug: string;
	action: "approve" | "reject";
	selectedKey: string;
	feedback?: string;
	ts: number;
};

/** Construct exactly one shared-schema verdict arm and validate it. */
export function buildVerdict(input: VerdictInput): Verdict {
	if (input.action === "approve") {
		return validateVerdict({
			slug: input.slug,
			action: "approve",
			selectedKey: input.selectedKey,
			ts: input.ts,
		});
	}
	return validateVerdict({
		slug: input.slug,
		action: "reject",
		selectedKey: input.selectedKey,
		feedback: input.feedback,
		ts: input.ts,
	});
}

const PICKER_CSS = `
.dg-proto-panel {
  position: fixed; right: 1rem; bottom: 1rem; z-index: 2147483646;
  width: min(30rem, calc(100vw - 2rem)); padding: .875rem;
  color: var(--ink); background: var(--panel); border: .125rem solid var(--line);
  box-shadow: .375rem .375rem 0 var(--accent); font: .75rem/1.45 ui-monospace, monospace;
}
.dg-proto-title { margin: 0 0 .625rem; font-size: .8125rem; text-transform: uppercase; }
.dg-proto-meta { color: var(--muted); margin-bottom: .5rem; }
.dg-proto-row { display: flex; flex-wrap: wrap; gap: .375rem; margin-top: .5rem; }
.dg-proto-btn, .dg-proto-feedback {
  color: var(--ink); background: var(--panel); border: .125rem solid var(--line);
  border-radius: 0; font: inherit; padding: .375rem .5rem;
}
.dg-proto-btn { cursor: pointer; text-transform: uppercase; }
.dg-proto-btn:hover:not(:disabled) { color: #000; background: var(--accent); border-color: var(--accent); }
.dg-proto-btn:disabled { cursor: not-allowed; opacity: .4; }
.dg-proto-feedback { box-sizing: border-box; width: 100%; resize: vertical; }
.dg-proto-error { min-height: 1.25rem; color: var(--accent2); }
`;

function pickPrototypeTarget(): Promise<HTMLElement | null> {
	return new Promise((resolve) => {
		startPicking(
			(selector) => resolve(document.querySelector<HTMLElement>(selector)),
			() => resolve(null),
		);
	});
}

function button(label: string): HTMLButtonElement {
	const element = document.createElement("button");
	element.type = "button";
	element.className = "dg-proto-btn";
	element.textContent = label;
	return element;
}

function requiredElement<T extends Element>(
	root: ParentNode,
	selector: string,
): T {
	const element = root.querySelector<T>(selector);
	if (!element)
		throw new Error(`missing prototype picker element: ${selector}`);
	return element;
}

function animationFrame(): Promise<void> {
	return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function sendPrototypeMessage(message: unknown): Promise<unknown> {
	const runtime = browser?.runtime as
		| {
				lastError?: { message?: string };
				sendMessage(
					message: unknown,
					callback?: (response: unknown) => void,
				): PromiseLike<unknown> | void;
		  }
		| undefined;
	if (!runtime) {
		throw new Error("prototype picker requires an extension runtime");
	}
	return callBrowserApi(
		(callback) => runtime.sendMessage(message, callback),
		() => runtime.sendMessage(message) as PromiseLike<unknown>,
		() => runtime.lastError?.message,
	);
}

/** Lock the planted shadow host to the target's layout slot and safety bounds. */
export function applyTrustedPrototypeHostStyles(
	host: HTMLElement,
	computed: CSSStyleDeclaration,
): void {
	const trustedHostStyles: Record<string, string> = {
		"align-self": computed.alignSelf,
		contain: "layout paint style",
		display: computed.display || "block",
		"flex-basis": computed.flexBasis,
		"flex-grow": computed.flexGrow,
		"flex-shrink": computed.flexShrink,
		"grid-area": computed.gridArea,
		"justify-self": computed.justifySelf,
		"max-width": "100%",
		order: computed.order,
		overflow: "hidden",
		width: computed.width,
	};
	for (const [property, value] of Object.entries(trustedHostStyles)) {
		if (value) host.style.setProperty(property, value, "important");
	}
}

/** Apply or clear the short neon feedback used by picker navigation. */
export function setPrototypeCycleFlash(
	host: HTMLElement,
	active: boolean,
): void {
	if (active) {
		host.style.setProperty("outline", ".1875rem solid #00f0ff", "important");
		host.style.setProperty("box-shadow", "0 0 1.25rem #00f0ff", "important");
		return;
	}
	host.style.removeProperty("outline");
	host.style.removeProperty("box-shadow");
}

let prototypeHostSequence = 0;

/**
 * Plant a prototype into one live-page target. Dynamic SPAs are intentionally
 * bounded to a longer one-shot selector wait; no long-lived MutationObserver is
 * installed, and selector timeout falls back to the interactive picker.
 */
export async function plantPrototype(rawPlan: unknown): Promise<void> {
	const plan = validateProtoPlan(rawPlan);
	const variations = plan.variations.map(sanitizePrototypeVariation);
	const takeover = plan.mode === "takeover";
	let target: HTMLElement | null = takeover ? document.body : null;
	if (!takeover) {
		if (plan.mountSelector) {
			try {
				target = await waitForEl(plan.mountSelector, 10_000);
			} catch {
				// Invalid or stale SPA selectors use the same interactive fallback.
			}
		}
		if (!target) target = await pickPrototypeTarget();
	}
	if (!target?.parentNode) return;

	const parent = target.parentNode;
	const nextSibling = target.nextSibling;
	const previousBodyChildren = takeover ? [...target.childNodes] : [];
	const prevInlineCssText = target.style.cssText;
	const computed = getComputedStyle(target);
	const instance = ++prototypeHostSequence;
	const host = document.createElement("div");
	host.id = `dg-proto-host-${instance}`;
	const controlsHost = document.createElement("div");
	controlsHost.id = `dg-proto-controls-${instance}`;
	let cleaned = false;
	let flashTimer: number | undefined;
	let onKey: ((event: KeyboardEvent) => void) | undefined;
	const cleanup = (): void => {
		if (cleaned) return;
		cleaned = true;
		if (flashTimer !== undefined) window.clearTimeout(flashTimer);
		if (onKey) document.removeEventListener("keydown", onKey, true);
		window.removeEventListener("pagehide", cleanup);
		host.remove();
		controlsHost.remove();
		if (takeover) {
			target.replaceChildren(...previousBodyChildren);
			return;
		}
		target.style.cssText = prevInlineCssText;
		const anchor =
			nextSibling && nextSibling.parentNode === parent ? nextSibling : null;
		if (target.parentNode !== parent || target.nextSibling !== anchor) {
			parent.insertBefore(target, anchor);
		}
	};

	try {
		applyTrustedPrototypeHostStyles(host, computed);
		if (takeover) {
			host.style.setProperty("display", "block", "important");
			host.style.setProperty("min-height", "100vh", "important");
			host.style.setProperty("width", "100%", "important");
			target.replaceChildren(host);
		} else {
			parent.insertBefore(host, target);
			target.style.display = "none";
		}
		document.documentElement.appendChild(controlsHost);
		const root = host.attachShadow({ mode: "closed" });
		const controlsRoot = controlsHost.attachShadow({ mode: "closed" });
		injectTheme(controlsRoot);
		const chromeStyle = document.createElement("style");
		chromeStyle.textContent = PICKER_CSS;
		controlsRoot.appendChild(chromeStyle);
		const panel = document.createElement("section");
		panel.className = "dg-proto-panel";
		panel.setAttribute("aria-label", "DG prototype picker");
		panel.innerHTML = `
		<h2 class="dg-proto-title">DG prototype picker</h2>
		<div class="dg-proto-question"></div>
		<div class="dg-proto-meta"></div>
		<div class="dg-proto-row dg-proto-nav"></div>
		<textarea class="dg-proto-feedback" rows="2" placeholder="Feedback for rejection"></textarea>
		<div class="dg-proto-error" role="status"></div>
		<div class="dg-proto-row dg-proto-actions"></div>
	`;
		controlsRoot.appendChild(panel);

		const question = requiredElement<HTMLElement>(panel, ".dg-proto-question");
		const meta = requiredElement<HTMLElement>(panel, ".dg-proto-meta");
		const nav = requiredElement<HTMLElement>(panel, ".dg-proto-nav");
		const actions = requiredElement<HTMLElement>(panel, ".dg-proto-actions");
		const feedback = requiredElement<HTMLTextAreaElement>(
			panel,
			".dg-proto-feedback",
		);
		const error = requiredElement<HTMLElement>(panel, ".dg-proto-error");
		question.textContent = plan.question ?? "Choose a variation";

		const previous = button("Previous");
		const next = button("Next");
		const select = button("Select");
		const approve = button("Approve");
		const reject = button("Reject");
		const close = button("Close");
		nav.append(previous, next, select);
		actions.append(approve, reject, close);

		let state: PrototypePickerState = {
			keys: variations.map((variation) => variation.key),
			currentIndex: 0,
			selectedKey: null,
			approved: false,
		};
		let settling = false;

		const render = (): void => {
			try {
				const variation = variations[state.currentIndex];
				if (!variation)
					throw new Error("prototype picker has no focused variation");
				root.replaceChildren();
				const style = document.createElement("style");
				style.textContent = variation.css;
				const canvas = document.createElement("div");
				canvas.setAttribute("data-dg-prototype", variation.key);
				canvas.innerHTML = variation.html;
				root.append(style, canvas);
				meta.textContent = `${state.currentIndex + 1}/${variations.length} · ${variation.label}${
					state.selectedKey === variation.key ? " · selected" : ""
				}`;
				approve.disabled = state.selectedKey === null;
				reject.disabled = false;
			} catch (error) {
				cleanup();
				throw error;
			}
		};

		const flash = (): void => {
			if (flashTimer !== undefined) window.clearTimeout(flashTimer);
			setPrototypeCycleFlash(host, true);
			flashTimer = window.setTimeout(() => {
				setPrototypeCycleFlash(host, false);
				flashTimer = undefined;
			}, 420);
		};
		const cycle = (action: "previous" | "next"): void => {
			try {
				state = pickerMachine(state, { type: action });
				error.textContent = "";
				render();
				flash();
			} catch (cycleError) {
				cleanup();
				throw cycleError;
			}
		};
		const choose = (): void => {
			try {
				state = pickerMachine(state, { type: "select" });
				render();
			} catch (selectionError) {
				cleanup();
				throw selectionError;
			}
		};
		const sendVerdict = async (action: "approve" | "reject"): Promise<void> => {
			if (settling) return;
			const selectedKey = pickerVerdictKey(state, action);
			if (!selectedKey) return;
			const selectedIndex = variations.findIndex(
				(variation) => variation.key === selectedKey,
			);
			if (selectedIndex >= 0 && selectedIndex !== state.currentIndex) {
				state = { ...state, currentIndex: selectedIndex };
				render();
			}
			if (action === "reject" && !feedback.value.trim()) {
				error.textContent = "Feedback is required to reject.";
				return;
			}
			settling = true;
			try {
				approve.disabled = true;
				reject.disabled = true;
				if (action === "approve") {
					state = pickerMachine(state, { type: "approve" });
					if (!state.approved) return;
					controlsHost.style.visibility = "hidden";
					await animationFrame();
					let result: { saved?: boolean; reason?: string } | undefined;
					try {
						result = (await sendPrototypeMessage({
							type: PROTO_CAPTURE_PREVIEW,
							slug: plan.slug,
						})) as typeof result;
					} catch (captureError) {
						result = {
							saved: false,
							reason:
								captureError instanceof Error
									? captureError.message
									: String(captureError),
						};
					}
					if (!result?.saved && result?.reason) {
						console.info(
							`[dg-ai-extension] prototype preview unavailable: ${result.reason}`,
						);
					}
					if (!result?.saved) controlsHost.style.visibility = "";
				}
				const verdict = buildVerdict({
					slug: plan.slug,
					action,
					selectedKey,
					feedback: action === "reject" ? feedback.value.trim() : undefined,
					ts: Date.now(),
				});
				await sendPrototypeMessage({
					type: PROTO_SAVE_VERDICT,
					verdict,
				});
			} finally {
				cleanup();
			}
		};
		onKey = (event: KeyboardEvent): void => {
			if (event.key === "Escape") cleanup();
		};
		const preventInteraction = (event: Event): void => {
			const path = event.composedPath();
			if (
				event.type === "submit" ||
				path.some(
					(node) =>
						node instanceof Element &&
						(node.tagName === "A" ||
							node.tagName === "BUTTON" ||
							node.tagName === "INPUT" ||
							node.tagName === "SELECT" ||
							node.tagName === "TEXTAREA"),
				)
			) {
				event.preventDefault();
				event.stopPropagation();
			}
		};
		root.addEventListener("click", preventInteraction, true);
		root.addEventListener("submit", preventInteraction, true);
		previous.addEventListener("click", () => cycle("previous"));
		next.addEventListener("click", () => cycle("next"));
		select.addEventListener("click", choose);
		approve.addEventListener("click", () => void sendVerdict("approve"));
		reject.addEventListener("click", () => void sendVerdict("reject"));
		close.addEventListener("click", cleanup);
		document.addEventListener("keydown", onKey, true);
		window.addEventListener("pagehide", cleanup);
		render();
	} catch (error) {
		cleanup();
		throw error;
	}
}
