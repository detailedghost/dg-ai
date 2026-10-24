import {
	STYLE_GUIDE_MAX_CONTROLS,
	type ProtoNotReadyError,
	type ProtoVariation,
	type StyleGuide,
	type StyleGuideControl,
	type Verdict,
	validateProtoPlan,
	validateStyleGuide,
	validateVerdict,
} from "@dg/common";
import { browser } from "wxt/browser";
import { callBrowserApi } from "../browser-call";
import { injectTheme, startPicking, waitForEl } from "../picker";
import { SANS } from "../ui-helpers";

/** Content-to-background message handing back a collected StyleGuide. */
export const PROTO_SAVE_STYLE_GUIDE = "dg-proto:save-style-guide";
/** Content-to-background message handing back a human verdict. */
export const PROTO_SAVE_VERDICT = "dg-proto:save-verdict";
/** Content-to-background message requesting an optional visible-tab preview. */
export const PROTO_CAPTURE_PREVIEW = "dg-proto:capture-preview";
/** Content-to-background message reporting the landed page is not ready for scrape/plant. */
export const PROTO_NOT_READY = "dg-proto:not-ready";
/** Content-to-background message reporting the page is ready and work has begun. */
export const PROTO_PROGRESS = "dg-proto:progress";
/** Content-to-background query: does this tab have a pending relay request? */
export const PROTO_HAS_PENDING = "dg-proto:has-pending";

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
	controls: StyleGuideControl[];
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
			...(samples.components.select
				? { select: sortedRecord(samples.components.select) }
				: {}),
			...(samples.components.textarea
				? { textarea: sortedRecord(samples.components.textarea) }
				: {}),
		},
		...(samples.controls.length > 0 ? { controls: samples.controls } : {}),
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

/** First visible match for a component sample; skips a hidden CSRF-token-shaped first input. */
function firstVisibleMatch(selector: string): Element | null {
	for (const element of document.querySelectorAll(selector)) {
		if (element instanceof HTMLInputElement && element.type === "hidden") {
			continue;
		}
		const style = getComputedStyle(element);
		if (style.display === "none" || style.visibility === "hidden") continue;
		return element;
	}
	return null;
}

/** Bootstrap's `data-bs-theme`, a generic `data-theme`, or the page's declared `color-scheme`. */
function detectColorScheme(): "light" | "dark" | undefined {
	const themed =
		document.documentElement.getAttribute("data-bs-theme") ??
		document.documentElement.getAttribute("data-theme");
	if (themed === "light" || themed === "dark") return themed;
	const declared = getComputedStyle(document.documentElement).colorScheme;
	if (declared === "dark" || declared === "light") return declared;
	return undefined;
}

const CONTROL_TAGS = new Set(["input", "select", "textarea", "button"]);

function controlType(element: Element, tag: string): string | undefined {
	if (tag === "input") return (element as HTMLInputElement).type;
	if (tag === "button") return (element as HTMLButtonElement).type;
	return undefined;
}

/** First form controls in document order, with their host classes, so an agent can reuse them verbatim. */
function collectControls(limit: number): StyleGuideControl[] {
	const controls: StyleGuideControl[] = [];
	for (const element of document.querySelectorAll(
		"input, select, textarea, button",
	)) {
		if (controls.length >= limit) break;
		const tag = element.tagName.toLowerCase();
		if (!CONTROL_TAGS.has(tag)) continue;
		const type = controlType(element, tag);
		const wrapperClasses = element.parentElement?.className;
		controls.push({
			tag: tag as StyleGuideControl["tag"],
			...(type ? { type } : {}),
			classes: element.className,
			...(wrapperClasses ? { wrapperClasses } : {}),
		});
	}
	return controls;
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
	 * + root/body + 1 color-scheme read + 5 component styles. At most 128
	 * custom properties are emitted.
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

	const colorScheme = detectColorScheme();
	return {
		meta: {
			url: location.href,
			scrapedAt: Date.now(),
			sameOrigin: true,
			...(colorScheme ? { colorScheme } : {}),
		},
		customProps,
		colors,
		fontStacks,
		typeScale,
		spacing,
		radii,
		shadows,
		components: {
			button: componentSample(firstVisibleMatch("button"), sharedProperties),
			input: componentSample(firstVisibleMatch("input"), sharedProperties),
			link: componentSample(firstVisibleMatch("a"), sharedProperties),
			select: componentSample(firstVisibleMatch("select"), sharedProperties),
			textarea: componentSample(
				firstVisibleMatch("textarea"),
				sharedProperties,
			),
		},
		controls: collectControls(STYLE_GUIDE_MAX_CONTROLS),
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
	"datalist",
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
	"form",
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
	"optgroup",
	"option",
	"p",
	"pre",
	"progress",
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
	button: new Set(["disabled", "form", "name", "type", "value"]),
	fieldset: new Set(["form"]),
	img: new Set(["alt", "height", "src", "width"]),
	input: new Set([
		"accept",
		"autocomplete",
		"checked",
		"disabled",
		"form",
		"list",
		"max",
		"maxlength",
		"min",
		"minlength",
		"multiple",
		"name",
		"pattern",
		"placeholder",
		"readonly",
		"required",
		"step",
		"type",
		"value",
	]),
	label: new Set(["for"]),
	optgroup: new Set(["disabled", "label"]),
	option: new Set(["disabled", "label", "selected", "value"]),
	progress: new Set(["max", "value"]),
	select: new Set(["disabled", "form", "multiple", "name", "required", "size"]),
	td: new Set(["colspan", "headers", "rowspan"]),
	textarea: new Set([
		"autocomplete",
		"cols",
		"disabled",
		"form",
		"maxlength",
		"minlength",
		"name",
		"placeholder",
		"readonly",
		"required",
		"rows",
		"wrap",
	]),
	th: new Set(["colspan", "headers", "rowspan", "scope"]),
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

function dropCssPrelude(prelude: string): boolean {
	const decoded = decodePrototypeCssEscapes(prelude);
	return (
		SHADOW_ESCAPE_SELECTOR.test(decoded) ||
		/@import\b/i.test(decoded) ||
		/@font-face\b/i.test(decoded) ||
		/@charset\b/i.test(decoded)
	);
}

/** Decode escapes in declaration text so `p\6f sition` is still neutralized. */
function sanitizeCssDeclarations(css: string): string {
	return decodePrototypeCssEscapes(css)
		.replace(/@import\b[^;]*(?:;|$)/gi, "")
		.replace(/@charset\b[^;]*(?:;|$)/gi, "")
		.replace(/@namespace\b[^;]*(?:;|$)/gi, "")
		.replace(/(?:url|image-set|-webkit-image-set)\s*\([^)]*\)/gi, (match) =>
			/^url\s*\(\s*(?:#|(["'])#)/i.test(match) ? match : "none",
		)
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
		.replaceAll("-->", "--\\3E ");
}

function lastTopLevelSemicolon(value: string): number {
	let quote: string | undefined;
	let last = -1;
	for (let index = 0; index < value.length; index += 1) {
		const character = value[index];
		if (quote) {
			if (character === "\\") {
				index += 1;
				continue;
			}
			if (character === quote) quote = undefined;
			continue;
		}
		if (character === '"' || character === "'") {
			quote = character;
			continue;
		}
		if (character === ";") last = index;
	}
	return last;
}

/**
 * Sanitize declarations, but keep selector escapes so `#a\:b` still parses as
 * an id. Nested rules stay in the text for the serializer to walk.
 */
function sanitizeCssStructure(css: string): string {
	let result = "";
	let index = 0;
	while (index < css.length) {
		const open = indexOfBrace(css, index);
		if (open < 0) {
			result += sanitizeCssDeclarations(css.slice(index));
			break;
		}
		const segment = css.slice(index, open);
		const split = lastTopLevelSemicolon(segment);
		const loose = split >= 0 ? segment.slice(0, split + 1) : "";
		const prelude = split >= 0 ? segment.slice(split + 1) : segment;
		const end = endOfBlock(css, open, "{", "}");
		const inner = css.slice(open + 1, Math.max(open + 1, end - 1));
		result += sanitizeCssDeclarations(loose);
		if (!dropCssPrelude(prelude)) {
			const safePrelude = prelude
				.replaceAll("<", "\\3C ")
				.replaceAll("-->", "--\\3E ");
			result += `${safePrelude}{${sanitizeCssStructure(inner)}}`;
		}
		index = end;
	}
	return result;
}

function preparePrototypeCss(css: string): string {
	const structured = sanitizeCssStructure(css.replace(/\/\*[\s\S]*?\*\//g, ""));
	// A shadow-escape selector that survived the walk blanks the sheet.
	// The check decodes escapes; the returned sheet keeps ident escapes.
	if (SHADOW_ESCAPE_SELECTOR.test(decodePrototypeCssEscapes(structured))) return "";
	return structured;
}

function prototypeStyleSheet(): { new (): CSSStyleSheet } | undefined {
	const view = document.defaultView as
		| (Window & { CSSStyleSheet?: { new (): CSSStyleSheet } })
		| null;
	const ctor = globalThis.CSSStyleSheet ?? view?.CSSStyleSheet;
	return typeof ctor === "function" ? ctor : undefined;
}

const ANIMATION_KEYWORDS = new Set([
	"alternate",
	"alternate-reverse",
	"backwards",
	"both",
	"ease",
	"ease-in",
	"ease-in-out",
	"ease-out",
	"forwards",
	"infinite",
	"linear",
	"none",
	"normal",
	"paused",
	"reverse",
	"running",
	"step-end",
	"step-start",
]);

function cssEscapeIdent(value: string): string {
	const view = document.defaultView as
		| (Window & { CSS?: { escape?: (text: string) => string } })
		| null;
	const escape =
		(globalThis as { CSS?: { escape?: (text: string) => string } }).CSS?.escape ??
		view?.CSS?.escape;
	if (escape) return escape(value);
	return value.replace(/[^a-zA-Z0-9_-]/g, (character) => `\\${character}`);
}

function cssString(value: string): string {
	return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function endOfQuoted(value: string, start: number): number {
	const quote = value[start];
	for (let index = start + 1; index < value.length; index += 1) {
		if (value[index] === "\\") {
			index += 1;
			continue;
		}
		if (value[index] === quote) return index + 1;
	}
	return value.length;
}

function endOfBlock(
	value: string,
	start: number,
	open: string,
	close: string,
): number {
	let depth = 0;
	let quote: string | undefined;
	for (let index = start; index < value.length; index += 1) {
		const character = value[index];
		if (quote) {
			if (character === "\\") {
				index += 1;
				continue;
			}
			if (character === quote) quote = undefined;
			continue;
		}
		if (character === '"' || character === "'") {
			quote = character;
			continue;
		}
		if (character === open) depth += 1;
		else if (character === close) {
			depth -= 1;
			if (depth === 0) return index + 1;
		}
	}
	return value.length;
}

function indexOfBrace(value: string, start: number): number {
	let quote: string | undefined;
	for (let index = start; index < value.length; index += 1) {
		const character = value[index];
		if (quote) {
			if (character === "\\") {
				index += 1;
				continue;
			}
			if (character === quote) quote = undefined;
			continue;
		}
		if (character === '"' || character === "'") {
			quote = character;
			continue;
		}
		if (character === "{") return index;
	}
	return -1;
}

function readCssIdent(
	value: string,
	start: number,
): { raw: string; next: number } | undefined {
	if (start >= value.length) return undefined;
	const first = value[start] ?? "";
	if (first !== "-" && first !== "\\" && !/[A-Za-z_\u0080-\uFFFF]/.test(first)) {
		return undefined;
	}
	let index = start;
	if (value[index] === "-") index += 1;
	while (index < value.length) {
		const character = value[index] ?? "";
		if (character === "\\") {
			const hex = /^[0-9a-fA-F]{1,6}/.exec(value.slice(index + 1));
			if (hex) {
				index += 1 + hex[0].length;
				if (value[index] === " ") index += 1;
				continue;
			}
			index += 2;
			continue;
		}
		if (!/[A-Za-z0-9_\u0080-\uFFFF-]/.test(character)) break;
		index += 1;
	}
	if (index === start) return undefined;
	return { raw: value.slice(start, index), next: index };
}

/** Rewrite `#id` selectors to the prefixed id. Declaration colors are not selectors. */
function rewriteHashIds(value: string, ids: ReadonlyMap<string, string>): string {
	if (ids.size === 0 || !value.includes("#")) return value;
	let result = "";
	for (let index = 0; index < value.length; index += 1) {
		const character = value[index];
		if (character === '"' || character === "'") {
			const end = endOfQuoted(value, index);
			result += value.slice(index, end);
			index = end - 1;
			continue;
		}
		if (character === "#") {
			const ident = readCssIdent(value, index + 1);
			if (ident) {
				const mapped = ids.get(decodePrototypeCssEscapes(ident.raw));
				if (mapped) {
					result += `#${cssEscapeIdent(mapped)}`;
					index = ident.next - 1;
					continue;
				}
				result += value.slice(index, ident.next);
				index = ident.next - 1;
				continue;
			}
		}
		result += character;
	}
	return result;
}

const ID_ATTRIBUTE_SELECTOR =
	/^\[\s*id\s*([~|^$*]?)\s*(=)\s*(?:"((?:\\.|[^"])*)"|'((?:\\.|[^'])*)'|([^\s\]"'=]+))\s*([iIsS])?\s*\]$/i;

function rewriteAttributeSelector(
	block: string,
	ids: ReadonlyMap<string, string>,
	idPrefix: string,
): string {
	const match = ID_ATTRIBUTE_SELECTOR.exec(block);
	if (!match) return rewriteHashIds(block, ids);
	const operatorFlag = match[1] ?? "";
	const operator = `${operatorFlag}=`;
	const raw = decodePrototypeCssEscapes(
		(match[3] ?? match[4] ?? match[5] ?? "").replace(/\\(.)/g, "$1"),
	);
	const flag = match[6] ? ` ${match[6]}` : "";
	// Prefixing ids makes `^=` / `|=` miss. `$=` and `*=` still match the prefixed id.
	if (operatorFlag === "^" || operatorFlag === "|") {
		if (!idPrefix || raw.startsWith(idPrefix)) return block;
		return `[id${operator}"${cssString(`${idPrefix}${raw}`)}"${flag}]`;
	}
	if (operatorFlag === "$" || operatorFlag === "*") return block;
	const mapped = ids.get(raw);
	if (!mapped) return block;
	return `[id${operator}"${cssString(mapped)}"${flag}]`;
}

function rewriteSelectorIds(
	selector: string,
	ids: ReadonlyMap<string, string>,
	idPrefix = "",
): string {
	if (
		(ids.size === 0 && !idPrefix) ||
		(!selector.includes("#") && !selector.includes("["))
	) {
		return selector;
	}
	let result = "";
	for (let index = 0; index < selector.length; index += 1) {
		const character = selector[index];
		if (character === '"' || character === "'") {
			const end = endOfQuoted(selector, index);
			result += selector.slice(index, end);
			index = end - 1;
			continue;
		}
		if (character === "[") {
			const end = endOfBlock(selector, index, "[", "]");
			result += rewriteAttributeSelector(
				selector.slice(index, end),
				ids,
				idPrefix,
			);
			index = end - 1;
			continue;
		}
		if (character === "#") {
			const ident = readCssIdent(selector, index + 1);
			if (ident) {
				const mapped = ids.get(decodePrototypeCssEscapes(ident.raw));
				if (mapped) {
					result += `#${cssEscapeIdent(mapped)}`;
					index = ident.next - 1;
					continue;
				}
				result += selector.slice(index, ident.next);
				index = ident.next - 1;
				continue;
			}
		}
		result += character;
	}
	return result;
}

/** Point `url(#id)` at the prefixed id. An unmapped fragment becomes `none`. */
function rewriteFragmentUrls(
	css: string,
	ids: ReadonlyMap<string, string>,
): string {
	if (!css.includes("#")) return css;
	return css.replace(
		/url\(\s*(['"]?)#([^)'"\s]+)\1\s*\)/gi,
		(_full, _quote: string, id: string) => {
			const mapped = ids.get(decodePrototypeCssEscapes(id));
			if (!mapped) return "none";
			return `url("#${cssString(mapped)}")`;
		},
	);
}

function rewriteAnimationValue(
	value: string,
	keyframes: ReadonlyMap<string, string>,
): string {
	if (keyframes.size === 0) return value;
	return value.replace(
		/(^|[\s,])(-?[A-Za-z_][A-Za-z0-9_-]*)/g,
		(match, lead: string, token: string) => {
			if (ANIMATION_KEYWORDS.has(token.toLowerCase())) return match;
			const mapped = keyframes.get(token);
			return mapped ? `${lead}${cssEscapeIdent(mapped)}` : match;
		},
	);
}

function rewriteDeclarations(
	cssText: string,
	ids: ReadonlyMap<string, string>,
	keyframes: ReadonlyMap<string, string>,
): string {
	const withUrls = rewriteFragmentUrls(cssText, ids);
	if (keyframes.size === 0) return withUrls;
	return withUrls.replace(
		/(^|;)(\s*)(animation-name|animation)(\s*:)([^;]*)/gi,
		(
			_match,
			semi: string,
			space: string,
			property: string,
			colon: string,
			value: string,
		) =>
			`${semi}${space}${property}${colon}${rewriteAnimationValue(value, keyframes)}`,
	);
}

function isKeyframesRule(rule: CSSRule): boolean {
	return rule.type === 7 || rule.constructor?.name === "CSSKeyframesRule";
}

function isGroupingRule(rule: CSSRule): rule is CSSGroupingRule {
	const name = rule.constructor?.name;
	return (
		name === "CSSMediaRule" ||
		name === "CSSSupportsRule" ||
		name === "CSSContainerRule" ||
		name === "CSSLayerBlockRule" ||
		rule.type === 4 ||
		rule.type === 12
	);
}

function childCssRules(rule: CSSRule): CSSRuleList | undefined {
	if (!("cssRules" in rule)) return undefined;
	const children = (rule as CSSGroupingRule).cssRules;
	if (!children || children.length === 0) return undefined;
	return children;
}

function groupingPrelude(rule: CSSRule): string {
	const open = rule.cssText.indexOf("{");
	return open > 0 ? rule.cssText.slice(0, open).trim() : "";
}

function keyframeRuleName(rule: CSSRule): string {
	if ("name" in rule && typeof (rule as CSSKeyframesRule).name === "string") {
		return (rule as CSSKeyframesRule).name;
	}
	const match = /@keyframes\s+([^\s{]+)/i.exec(rule.cssText);
	return match?.[1]?.replace(/^["']|["']$/g, "") ?? "";
}

function collectKeyframeNames(
	rules: CSSRuleList,
	prefix: string,
	into: Map<string, string>,
): void {
	for (let index = 0; index < rules.length; index += 1) {
		const rule = rules[index];
		if (!rule) continue;
		if (isKeyframesRule(rule)) {
			const name = keyframeRuleName(rule);
			if (name && !name.startsWith(prefix) && !into.has(name)) {
				into.set(name, `${prefix}${name}`);
			}
			continue;
		}
		const children = childCssRules(rule);
		if (children && (isGroupingRule(rule) || rule.constructor?.name === "CSSStyleRule")) {
			collectKeyframeNames(children, prefix, into);
		}
	}
}

function formatKeyframeRule(
	rule: CSSRule,
	names: ReadonlyMap<string, string>,
	ids: ReadonlyMap<string, string>,
): string | undefined {
	if (SHADOW_ESCAPE_SELECTOR.test(rule.cssText)) return undefined;
	const name = keyframeRuleName(rule);
	if (!name) return undefined;
	const mapped = names.get(name) ?? name;
	const open = rule.cssText.indexOf("{");
	const body = open >= 0 ? rule.cssText.slice(open).trim() : "{}";
	return `@keyframes ${cssEscapeIdent(mapped)} ${rewriteFragmentUrls(body, ids)}`;
}

/**
 * `@keyframes` is not valid inside `@scope`, so namespaced copies are emitted
 * beside the scope block. Prefixed names keep them off the host page.
 */
function serializeKeyframeRules(
	rules: CSSRuleList,
	names: ReadonlyMap<string, string>,
	ids: ReadonlyMap<string, string>,
): string {
	const parts: string[] = [];
	for (let index = 0; index < rules.length; index += 1) {
		const rule = rules[index];
		if (!rule) continue;
		if (isKeyframesRule(rule)) {
			const formatted = formatKeyframeRule(rule, names, ids);
			if (formatted) parts.push(formatted);
			continue;
		}
		if (isGroupingRule(rule)) {
			const inner = serializeKeyframeRules(rule.cssRules, names, ids);
			if (!inner.trim()) continue;
			const prelude = groupingPrelude(rule);
			// Keep @media / @supports around the keyframes. Hoisting them
			// makes both branches apply, and the later one wins unconditionally.
			if (!prelude || /@scope\b/i.test(prelude)) continue;
			parts.push(`${prelude} {\n${inner}\n}`);
			continue;
		}
		if (rule.constructor?.name === "CSSStyleRule") {
			const children = childCssRules(rule);
			if (!children) continue;
			const inner = serializeKeyframeRules(children, names, ids);
			if (inner.trim()) parts.push(inner);
		}
	}
	return parts.join("\n");
}

type SourceRule = { prelude: string; body: string };
type SourceCursor = { rules: SourceRule[]; index: number };

function splitCssRules(css: string): SourceRule[] {
	const rules: SourceRule[] = [];
	let index = 0;
	while (index < css.length) {
		const open = indexOfBrace(css, index);
		if (open < 0) break;
		const prelude = css.slice(index, open).trim();
		const end = endOfBlock(css, open, "{", "}");
		const body = css.slice(open + 1, Math.max(open + 1, end - 1));
		if (prelude) rules.push({ prelude, body });
		index = end;
	}
	return rules;
}

function normalizeCssPrelude(value: string): string {
	return decodePrototypeCssEscapes(value).replace(/\s+/g, " ").trim();
}

function takeSource(
	cursor: SourceCursor | undefined,
	prelude: string,
): SourceRule | undefined {
	if (!cursor || !prelude.trim()) return undefined;
	const want = normalizeCssPrelude(prelude);
	for (let index = cursor.index; index < cursor.rules.length; index += 1) {
		const rule = cursor.rules[index];
		if (!rule || normalizeCssPrelude(rule.prelude) !== want) continue;
		cursor.index = index + 1;
		return rule;
	}
	return undefined;
}

/** Declarations plus nested rules, with id and keyframe rewrites. `@keyframes` are emitted outside `@scope`. */
function rewriteRuleBody(
	body: string,
	ids: ReadonlyMap<string, string>,
	keyframes: ReadonlyMap<string, string>,
	idPrefix: string,
): string {
	if (!body.includes("{")) return rewriteDeclarations(body, ids, keyframes);
	let result = "";
	let index = 0;
	while (index < body.length) {
		const open = indexOfBrace(body, index);
		if (open < 0) {
			result += rewriteDeclarations(body.slice(index), ids, keyframes);
			break;
		}
		const segment = body.slice(index, open);
		const split = lastTopLevelSemicolon(segment);
		const declarations = split >= 0 ? segment.slice(0, split + 1) : "";
		const prelude = split >= 0 ? segment.slice(split + 1) : segment;
		const end = endOfBlock(body, open, "{", "}");
		const inner = body.slice(open + 1, Math.max(open + 1, end - 1));
		result += rewriteDeclarations(declarations, ids, keyframes);
		const decodedPrelude = decodePrototypeCssEscapes(prelude);
		if (
			prelude.trim() &&
			!dropCssPrelude(prelude) &&
			!/@keyframes\b/i.test(decodedPrelude) &&
			!/@scope\b/i.test(decodedPrelude)
		) {
			result += `${rewriteSelectorIds(prelude, ids, idPrefix)}{${rewriteRuleBody(inner, ids, keyframes, idPrefix)}}`;
		}
		index = end;
	}
	return result;
}

function nestedSourceOnly(body: string): string {
	const open = indexOfBrace(body, 0);
	if (open < 0) return "";
	const split = lastTopLevelSemicolon(body.slice(0, open));
	return body.slice(split >= 0 ? split + 1 : 0);
}

function serializeStyleRule(
	rule: CSSStyleRule,
	ids: ReadonlyMap<string, string>,
	keyframes: ReadonlyMap<string, string>,
	idPrefix: string,
	cursor: SourceCursor | undefined,
): string | undefined {
	if (
		SHADOW_ESCAPE_SELECTOR.test(rule.selectorText) ||
		SHADOW_ESCAPE_SELECTOR.test(rule.cssText)
	) {
		return undefined;
	}
	const selector = rewriteSelectorIds(rule.selectorText, ids, idPrefix).trim();
	if (!selector) return undefined;
	const source = takeSource(cursor, rule.selectorText);
	const children = childCssRules(rule);
	const declarations = rewriteDeclarations(
		rule.style?.cssText ?? "",
		ids,
		keyframes,
	).trim();
	const nested = children
		? serializeScopedRules(
				children,
				ids,
				keyframes,
				idPrefix,
				source ? { rules: splitCssRules(source.body), index: 0 } : undefined,
			).trim()
		: "";
	let body = [declarations, nested].filter((part) => part.trim()).join("\n");
	// Some CSSOM implementations drop nested rules (and the declarations beside
	// them) instead of exposing them on cssRules. Rebuild that body from the
	// already-sanitized source so preview CSS matches the exported sheet.
	if (!body.trim() && source?.body.trim()) {
		body = rewriteRuleBody(source.body, ids, keyframes, idPrefix).trim();
	} else if (!nested && source?.body.includes("{")) {
		const rewritten = rewriteRuleBody(
			nestedSourceOnly(source.body),
			ids,
			keyframes,
			idPrefix,
		).trim();
		body = [declarations, rewritten].filter((part) => part.trim()).join("\n");
	}
	if (!body.trim()) return undefined;
	return `${selector} { ${body} }`;
}

function serializeScopedRules(
	rules: CSSRuleList,
	ids: ReadonlyMap<string, string>,
	keyframes: ReadonlyMap<string, string>,
	idPrefix: string,
	cursor: SourceCursor | undefined,
): string {
	const parts: string[] = [];
	for (let index = 0; index < rules.length; index += 1) {
		const rule = rules[index];
		if (!rule || isKeyframesRule(rule)) continue;
		if (rule.constructor.name === "CSSStyleRule") {
			const serialized = serializeStyleRule(
				rule as CSSStyleRule,
				ids,
				keyframes,
				idPrefix,
				cursor,
			);
			if (serialized) parts.push(serialized);
			continue;
		}
		if (rule.constructor?.name === "CSSNestedDeclarations" && "style" in rule) {
			const text = rewriteDeclarations(
				(rule as CSSStyleRule).style?.cssText ?? "",
				ids,
				keyframes,
			).trim();
			if (text) parts.push(text);
			continue;
		}
		if (!isGroupingRule(rule)) continue;
		const prelude = groupingPrelude(rule);
		if (!prelude || /@scope\b/i.test(prelude)) {
			takeSource(cursor, prelude);
			continue;
		}
		const source = takeSource(cursor, prelude);
		const inner = serializeScopedRules(
			rule.cssRules,
			ids,
			keyframes,
			idPrefix,
			source ? { rules: splitCssRules(source.body), index: 0 } : undefined,
		);
		if (!inner.trim()) continue;
		parts.push(`${prelude} {\n${inner}\n}`);
	}
	return parts.join("\n");
}

/** Rewrite selectors when CSSOM is unavailable, without touching declaration colors. */
function rewriteUnparsedCss(
	css: string,
	ids: ReadonlyMap<string, string>,
	idPrefix = "",
): string {
	if (!css.includes("{")) return rewriteFragmentUrls(css, ids);
	let result = "";
	let index = 0;
	while (index < css.length) {
		const open = indexOfBrace(css, index);
		if (open < 0) {
			result += rewriteFragmentUrls(css.slice(index), ids);
			break;
		}
		result += rewriteSelectorIds(css.slice(index, open), ids, idPrefix);
		const end = endOfBlock(css, open, "{", "}");
		const inner = css.slice(open + 1, Math.max(open + 1, end - 1));
		result += `{${rewriteUnparsedCss(inner, ids, idPrefix)}}`;
		index = end;
	}
	return result;
}

function cssBracesBalance(css: string): boolean {
	let depth = 0;
	let quote: '"' | "'" | undefined;
	for (let index = 0; index < css.length; index += 1) {
		const character = css[index];
		if (quote) {
			if (character === "\\") {
				index += 1;
				continue;
			}
			if (character === quote) quote = undefined;
			continue;
		}
		if (character === '"' || character === "'") {
			quote = character;
			continue;
		}
		if (character === "{") depth += 1;
		else if (character === "}") {
			depth -= 1;
			if (depth < 0) return false;
		}
	}
	return depth === 0;
}

function wrapPrototypeScope(css: string): string {
	const trimmed = css.trim();
	return trimmed ? `@scope ([data-dg-prototype]) {\n${trimmed}\n}` : "";
}

function sanitizePrototypeCss(
	css: string,
	scoped = true,
	ids: ReadonlyMap<string, string> = new Map(),
	keyframePrefix = "",
): string {
	const sanitized = preparePrototypeCss(css);
	if (!scoped) return sanitized;
	const trimmed = sanitized.trim();
	if (!trimmed) return "";
	const StyleSheet = prototypeStyleSheet();
	if (StyleSheet) {
		try {
			const sheet = new StyleSheet();
			sheet.replaceSync(trimmed);
			const keyframes = new Map<string, string>();
			if (keyframePrefix) {
				collectKeyframeNames(sheet.cssRules, keyframePrefix, keyframes);
			}
			const frames = serializeKeyframeRules(sheet.cssRules, keyframes, ids);
			const scope = wrapPrototypeScope(
				serializeScopedRules(sheet.cssRules, ids, keyframes, keyframePrefix, {
					rules: splitCssRules(trimmed),
					index: 0,
				}),
			);
			return [frames, scope].filter((part) => part.trim()).join("\n");
		} catch {
			return "";
		}
	}
	if (/@scope\b/i.test(trimmed) || !cssBracesBalance(trimmed)) return "";
	return wrapPrototypeScope(rewriteUnparsedCss(trimmed, ids, keyframePrefix));
}

const ARIA_ID_REFERENCE_ATTRIBUTES = [
	"aria-activedescendant",
	"aria-controls",
	"aria-describedby",
	"aria-details",
	"aria-errormessage",
	"aria-flowto",
	"aria-labelledby",
	"aria-owns",
];

const SINGLE_ID_REFERENCE_ATTRIBUTES = ["for", "form", "list"];
const TOKEN_ID_REFERENCE_ATTRIBUTES = [...ARIA_ID_REFERENCE_ATTRIBUTES, "headers"];
const FORM_OWNER_TAGS = new Set([
	"BUTTON",
	"FIELDSET",
	"INPUT",
	"SELECT",
	"TEXTAREA",
]);

/** Prefix ids and radio names, and retarget references that pointed at the old ids. */
function namespaceVariationDom(
	root: ParentNode,
	variationKey: string,
): Map<string, string> {
	const prefix = `dg-proto-${variationKey}-`;
	const idMap = new Map<string, string>();
	for (const element of root.querySelectorAll("[id]")) {
		const current = element.getAttribute("id");
		if (!current || current.startsWith(prefix)) continue;
		const next = `${prefix}${current}`;
		idMap.set(current, next);
		element.setAttribute("id", next);
	}
	for (const element of root.querySelectorAll("*")) {
		for (const name of SINGLE_ID_REFERENCE_ATTRIBUTES) {
			const value = element.getAttribute(name);
			if (!value) continue;
			const mapped = idMap.get(value);
			if (mapped) {
				element.setAttribute(name, mapped);
				continue;
			}
			// An unmapped form/list id points at the host page. Drop it.
			if (name === "form" || name === "list") element.removeAttribute(name);
		}
		for (const name of TOKEN_ID_REFERENCE_ATTRIBUTES) {
			const value = element.getAttribute(name);
			if (!value) continue;
			const rewritten = value
				.split(/\s+/)
				.map((token) => idMap.get(token) ?? token)
				.join(" ");
			if (rewritten !== value) element.setAttribute(name, rewritten);
		}
		if (element.tagName === "A") {
			const href = element.getAttribute("href");
			if (href?.startsWith("#")) {
				const mapped = idMap.get(href.slice(1));
				if (mapped) element.setAttribute("href", `#${mapped}`);
			}
		}
		if (
			element.tagName === "INPUT" &&
			(element.getAttribute("type") ?? "").toLowerCase() === "radio"
		) {
			const name = element.getAttribute("name");
			if (name && !name.startsWith(prefix)) {
				element.setAttribute("name", `${prefix}${name}`);
			}
		}
		// `form=""` associates the control with no form, so Enter inside a
		// planted field cannot submit an ancestor host-page form. A variation
		// form id rewritten above is left in place.
		if (FORM_OWNER_TAGS.has(element.tagName) && !element.getAttribute("form")) {
			element.setAttribute("form", "");
		}
	}
	return idMap;
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
	const idMap = namespaceVariationDom(parsed.body, variation.key);
	for (const element of parsed.body.querySelectorAll("[style]")) {
		const style = element.getAttribute("style");
		if (!style) continue;
		const rewritten = rewriteFragmentUrls(style, idMap);
		if (rewritten !== style) element.setAttribute("style", rewritten);
	}

	return {
		...variation,
		html: parsed.body.innerHTML,
		css: sanitizePrototypeCss(
			variation.css,
			true,
			idMap,
			`dg-proto-${variation.key}-`,
		),
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

const LOGIN_TEXT = /sign in|log in|login/i;

function hasPasswordField(): boolean {
	return document.querySelector('input[type="password"]') !== null;
}

function hasLoginFormAction(): boolean {
	return document.querySelector('form[action*="login" i]') !== null;
}

function matchesLoginText(): boolean {
	const heading = document.querySelector("h1")?.textContent ?? "";
	return LOGIN_TEXT.test(document.title) || LOGIN_TEXT.test(heading);
}

function navigationHttpStatus(): number | undefined {
	try {
		const entries = performance.getEntriesByType?.("navigation") as
			| Array<{ responseStatus?: number }>
			| undefined;
		return entries?.[0]?.responseStatus;
	} catch {
		return undefined;
	}
}

/**
 * Page-level not-ready signals shared by scrape and plant: an HTTP error
 * response, a sign-in wall, or a landing page that is not the one requested.
 * Called before any scrape or plant work begins; a mount-selector-specific
 * check happens separately inside `plantPrototype`.
 */
function withoutTrailingSlash(pathname: string): string {
	return pathname.length > 1 && pathname.endsWith("/")
		? pathname.slice(0, -1)
		: pathname;
}

function landedOffExpected(expectedUrl: string): boolean {
	let expected: URL;
	try {
		expected = new URL(expectedUrl);
	} catch {
		return false;
	}
	return (
		location.origin !== expected.origin ||
		withoutTrailingSlash(location.pathname) !==
			withoutTrailingSlash(expected.pathname)
	);
}

function expectedPageLabel(expectedUrl: string): string {
	try {
		const expected = new URL(expectedUrl);
		return `${expected.origin}${expected.pathname}`;
	} catch {
		return expectedUrl;
	}
}

/**
 * Login heuristics apply only after the navigation is already suspicious:
 * the browser left `expectedUrl`, or the response was 401/403. A password
 * field on the page the user asked for is an account form, not a wall.
 */
export function detectPageNotReady(
	expectedUrl: string,
): ProtoNotReadyError | undefined {
	const landedUrl = location.href;
	const status = navigationHttpStatus();
	const offTarget = landedOffExpected(expectedUrl);
	const authStatus = status === 401 || status === 403;
	if (typeof status === "number" && status >= 400 && !authStatus) {
		return {
			code: "http-error",
			message: `The page responded with HTTP ${status}.`,
			landedUrl,
		};
	}
	if (
		(offTarget || authStatus) &&
		(hasPasswordField() || hasLoginFormAction() || matchesLoginText())
	) {
		return {
			code: "login-page",
			message:
				"The page looks like a sign-in page. Authenticate in this browser profile and retry.",
			landedUrl,
		};
	}
	if (offTarget) {
		return {
			code: "redirected",
			message: `The browser landed on a different page than requested (expected ${expectedPageLabel(expectedUrl)}).`,
			landedUrl,
		};
	}
	if (authStatus && typeof status === "number") {
		return {
			code: "http-error",
			message: `The page responded with HTTP ${status}.`,
			landedUrl,
		};
	}
	return undefined;
}

/** Immutable selection state for the planted comparison picker. */
export type PrototypePickerState = {
	keys: string[];
	currentIndex: number;
	selectedKey: string | null;
	approved: boolean;
	showingOriginal: boolean;
};

/** User navigation, approval, and compare actions accepted by the picker state machine. */
export type PrototypePickerAction =
	| { type: "previous" }
	| { type: "next" }
	| { type: "select" }
	| { type: "approve" }
	| { type: "toggle-original" };

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
			showingOriginal: false,
		};
	}
	if (action.type === "next") {
		return {
			...state,
			currentIndex: count === 0 ? 0 : (state.currentIndex + 1) % count,
			selectedKey: null,
			approved: false,
			showingOriginal: false,
		};
	}
	if (action.type === "select") {
		return {
			...state,
			selectedKey: state.keys[state.currentIndex] ?? null,
			approved: false,
			showingOriginal: false,
		};
	}
	if (action.type === "toggle-original") {
		return { ...state, showingOriginal: !state.showingOriginal };
	}
	return state.selectedKey ? { ...state, approved: true } : { ...state };
}

/** Resolve the variation a verdict applies to without weakening approval gates. */
export function pickerVerdictKey(
	state: PrototypePickerState,
	action: "approve" | "reject" | "tweak",
): string | null {
	return action === "approve"
		? state.selectedKey
		: (state.keys[state.currentIndex] ?? null);
}

type VerdictInput = {
	slug: string;
	action: "approve" | "reject" | "tweak";
	selectedKey: string;
	notes?: string;
	ts: number;
};

/** Construct exactly one shared-schema verdict arm and validate it. */
export function buildVerdict(input: VerdictInput): Verdict {
	if (input.action === "approve") {
		return validateVerdict({
			slug: input.slug,
			action: "approve",
			selectedKey: input.selectedKey,
			...(input.notes ? { notes: input.notes } : {}),
			ts: input.ts,
		});
	}
	if (input.action === "tweak") {
		return validateVerdict({
			slug: input.slug,
			action: "tweak",
			selectedKey: input.selectedKey,
			notes: input.notes,
			ts: input.ts,
		});
	}
	return validateVerdict({
		slug: input.slug,
		action: "reject",
		selectedKey: input.selectedKey,
		feedback: input.notes,
		ts: input.ts,
	});
}

const PICKER_CSS = `
.dg-proto-panel {
  position: fixed; right: 1rem; bottom: 1rem; z-index: 2147483646;
  width: min(30rem, calc(100vw - 2rem)); padding: .875rem;
  color: var(--ink); background: var(--panel); border: .125rem solid var(--line);
  box-shadow: .375rem .375rem 0 var(--accent); font: .8125rem/1.5 ${SANS};
}
.dg-proto-title { margin: 0 0 .625rem; font-size: .8125rem; text-transform: uppercase; }
.dg-proto-meta { color: var(--muted); margin-bottom: .5rem; }
.dg-proto-row { display: flex; flex-wrap: wrap; gap: .375rem; margin-top: .5rem; }
.dg-proto-btn, .dg-proto-notes {
  color: var(--ink); background: var(--panel); border: .125rem solid var(--line);
  border-radius: 0; font: inherit; padding: .375rem .5rem;
}
.dg-proto-btn { cursor: pointer; text-transform: uppercase; }
.dg-proto-btn:hover:not(:disabled) { color: #000; background: var(--accent); border-color: var(--accent); }
.dg-proto-btn:disabled { cursor: not-allowed; opacity: .4; }
.dg-proto-notes { box-sizing: border-box; width: 100%; resize: vertical; }
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

function isElementNode(node: unknown): node is Element {
	return (
		typeof node === "object" &&
		node !== null &&
		"nodeType" in node &&
		(node as Node).nodeType === 1 &&
		"tagName" in node
	);
}

async function reportPrototypeNotReady(error: ProtoNotReadyError): Promise<void> {
	await sendPrototypeMessage({ type: PROTO_NOT_READY, error });
}

/**
 * Plant a prototype into one live-page target. Dynamic SPAs are intentionally
 * bounded to a longer one-shot selector wait. A given mount selector that
 * never resolves is a typed not-ready failure, not a silent interactive
 * fallback; the picker only takes over when no selector was supplied.
 */
export async function plantPrototype(rawPlan: unknown): Promise<void> {
	const plan = validateProtoPlan(rawPlan);
	const variations = plan.variations.map(sanitizePrototypeVariation);
	const takeover = plan.mode === "takeover";
	let target: HTMLElement | null = takeover ? document.body : null;
	if (!takeover) {
		if (plan.mountSelector) {
			target = await waitForEl(plan.mountSelector, 10_000);
			if (!target) {
				await reportPrototypeNotReady({
					code: "mount-missing",
					message: `The mount selector "${plan.mountSelector}" was not found on the page.`,
					landedUrl: location.href,
				});
				return;
			}
		} else {
			target = await pickPrototypeTarget();
		}
	}
	if (!target?.parentNode) return;

	const parent = target.parentNode;
	const nextSibling = target.nextSibling;
	const previousBodyChildren = takeover ? [...target.childNodes] : [];
	const prevInlineCssText = target.style.cssText;
	const savedDisplay = target.style.getPropertyValue("display");
	const savedDisplayPriority = target.style.getPropertyPriority("display");
	const computed = getComputedStyle(target);
	const variationDisplay = computed.display || "block";
	const instance = ++prototypeHostSequence;
	const host = document.createElement("div");
	host.id = `dg-proto-host-${instance}`;
	const preventPlantedSubmit = (event: Event): void => {
		const form = event.target;
		if (!isElementNode(form) || form.tagName !== "FORM") return;
		const submitter = (event as Event & { submitter?: EventTarget | null })
			.submitter;
		const active = document.activeElement;
		const planted =
			host.contains(form) ||
			(isElementNode(submitter) && host.contains(submitter)) ||
			(isElementNode(active) && host.contains(active));
		if (!planted) return;
		event.preventDefault();
		event.stopPropagation();
	};
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
		document.removeEventListener("submit", preventPlantedSubmit, true);
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
		document.addEventListener("submit", preventPlantedSubmit, true);
		applyTrustedPrototypeHostStyles(host, computed);
		if (takeover) {
			host.style.setProperty("display", "block", "important");
			host.style.setProperty("min-height", "100vh", "important");
			host.style.setProperty("width", "100%", "important");
			target.replaceChildren(host);
		} else {
			parent.insertBefore(host, target);
			target.style.setProperty("display", "none", "important");
		}
		document.documentElement.appendChild(controlsHost);
		controlsHost.addEventListener("focusin", (event) =>
			event.stopPropagation(),
		);
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
		<textarea class="dg-proto-notes" rows="2" placeholder="Notes: required to reject or tweak, optional on approve"></textarea>
		<div class="dg-proto-error" role="status"></div>
		<div class="dg-proto-row dg-proto-actions"></div>
	`;
		controlsRoot.appendChild(panel);

		const question = requiredElement<HTMLElement>(panel, ".dg-proto-question");
		const meta = requiredElement<HTMLElement>(panel, ".dg-proto-meta");
		const nav = requiredElement<HTMLElement>(panel, ".dg-proto-nav");
		const actions = requiredElement<HTMLElement>(panel, ".dg-proto-actions");
		const notes = requiredElement<HTMLTextAreaElement>(
			panel,
			".dg-proto-notes",
		);
		const error = requiredElement<HTMLElement>(panel, ".dg-proto-error");
		question.textContent = plan.question ?? "Choose a variation";

		const previous = button("Previous");
		const next = button("Next");
		const select = button("Select");
		const toggleOriginal = takeover ? undefined : button("Show original");
		const approve = button("Approve");
		const reject = button("Reject");
		const tweak = button("Tweak");
		const close = button("Close");
		nav.append(previous, next, select);
		if (toggleOriginal) nav.append(toggleOriginal);
		actions.append(approve, reject, tweak, close);

		let state: PrototypePickerState = {
			keys: variations.map((variation) => variation.key),
			currentIndex: 0,
			selectedKey: null,
			approved: false,
			showingOriginal: false,
		};
		let settling = false;

		const render = (): void => {
			try {
				const variation = variations[state.currentIndex];
				if (!variation)
					throw new Error("prototype picker has no focused variation");
				const showingOriginal = !takeover && state.showingOriginal;
				if (!takeover) {
					if (showingOriginal) {
						if (savedDisplay) {
							target.style.setProperty(
								"display",
								savedDisplay,
								savedDisplayPriority,
							);
						} else {
							target.style.removeProperty("display");
						}
					} else {
						target.style.setProperty("display", "none", "important");
					}
					host.style.setProperty(
						"display",
						showingOriginal ? "none" : variationDisplay,
						"important",
					);
				}
				if (!showingOriginal) {
					host.replaceChildren();
					const style = document.createElement("style");
					style.textContent = variation.css;
					const canvas = document.createElement("div");
					canvas.setAttribute("data-dg-prototype", variation.key);
					canvas.innerHTML = variation.html;
					host.append(style, canvas);
				}
				meta.textContent = `${state.currentIndex + 1}/${variations.length} · ${variation.label}${
					state.selectedKey === variation.key ? " · selected" : ""
				}${showingOriginal ? " · showing original" : ""}`;
				approve.disabled = state.selectedKey === null || showingOriginal;
				reject.disabled = showingOriginal;
				tweak.disabled = showingOriginal;
				if (toggleOriginal) {
					toggleOriginal.textContent = showingOriginal
						? "Show variation"
						: "Show original";
				}
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
		const sendVerdict = async (action: "approve" | "reject" | "tweak"): Promise<void> => {
			if (settling || state.showingOriginal) return;
			const selectedKey = pickerVerdictKey(state, action);
			if (!selectedKey) return;
			const selectedIndex = variations.findIndex(
				(variation) => variation.key === selectedKey,
			);
			if (selectedIndex >= 0 && selectedIndex !== state.currentIndex) {
				state = { ...state, currentIndex: selectedIndex };
				render();
			}
			if (action !== "approve" && !notes.value.trim()) {
				error.textContent = `Notes are required to ${action}.`;
				return;
			}
			settling = true;
			try {
				approve.disabled = true;
				reject.disabled = true;
				tweak.disabled = true;
				if (toggleOriginal) toggleOriginal.disabled = true;
				if (action === "approve") {
					state = pickerMachine(state, { type: "approve" });
					if (!state.approved) return;
					controlsHost.style.visibility = "hidden";
					await animationFrame();
					let result: { saved?: boolean; reason?: string } | undefined;
					try {
						result = (await sendPrototypeMessage({
							type: PROTO_CAPTURE_PREVIEW,
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
					notes: notes.value.trim() || undefined,
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
		host.addEventListener("click", preventInteraction, true);
		host.addEventListener("submit", preventInteraction, true);
		previous.addEventListener("click", () => cycle("previous"));
		next.addEventListener("click", () => cycle("next"));
		select.addEventListener("click", choose);
		if (toggleOriginal) {
			toggleOriginal.addEventListener("click", () => {
				state = pickerMachine(state, { type: "toggle-original" });
				render();
			});
		}
		approve.addEventListener("click", () => void sendVerdict("approve"));
		reject.addEventListener("click", () => void sendVerdict("reject"));
		tweak.addEventListener("click", () => void sendVerdict("tweak"));
		close.addEventListener("click", cleanup);
		document.addEventListener("keydown", onKey, true);
		window.addEventListener("pagehide", cleanup);
		render();
	} catch (error) {
		cleanup();
		throw error;
	}
}
