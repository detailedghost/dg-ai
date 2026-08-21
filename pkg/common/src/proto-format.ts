import {
	fail,
	isRecord,
	requireFiniteNumber,
	requireOneOf,
	requireRecord,
	requireString,
	requireStringArray,
	requireStringRecord,
} from "./assert";
import type {
	AnswerPageMeta,
	ProtoPlan,
	ProtoVariation,
	StyleGuide,
	Verdict,
} from "./types";

const ALLOWED_TAGS = new Set([
	"a",
	"abbr",
	"article",
	"aside",
	"b",
	"blockquote",
	"br",
	"button",
	"caption",
	"code",
	"col",
	"colgroup",
	"dd",
	"del",
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
	"mark",
	"nav",
	"ol",
	"optgroup",
	"option",
	"p",
	"pre",
	"progress",
	"q",
	"s",
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
	"time",
	"tr",
	"u",
	"ul",
]);

const VOID_TAGS = new Set(["br", "col", "hr", "img", "input"]);

// Contents of these elements have parsing rules or active behavior that make
// preserving their children unsafe after removing only the wrapper.
const DROP_WITH_CONTENT_TAGS = new Set([
	"embed",
	"iframe",
	"math",
	"noscript",
	"object",
	"script",
	"style",
	"svg",
	"template",
]);

const GLOBAL_ATTRIBUTES = new Set([
	"class",
	"dir",
	"hidden",
	"id",
	"lang",
	"role",
	"style",
	"tabindex",
	"title",
]);

const TAG_ATTRIBUTES: Readonly<Record<string, ReadonlySet<string>>> = {
	a: new Set(["download", "href", "rel", "target"]),
	blockquote: new Set(["cite"]),
	button: new Set(["disabled", "name", "type", "value"]),
	col: new Set(["span"]),
	del: new Set(["cite", "datetime"]),
	details: new Set(["open"]),
	img: new Set(["alt", "decoding", "height", "loading", "src", "width"]),
	input: new Set([
		"accept",
		"autocomplete",
		"checked",
		"disabled",
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
	li: new Set(["value"]),
	ol: new Set(["reversed", "start", "type"]),
	optgroup: new Set(["disabled", "label"]),
	option: new Set(["disabled", "label", "selected", "value"]),
	progress: new Set(["max", "value"]),
	q: new Set(["cite"]),
	select: new Set(["disabled", "multiple", "name", "required", "size"]),
	td: new Set(["colspan", "headers", "rowspan"]),
	textarea: new Set([
		"autocomplete",
		"cols",
		"disabled",
		"maxlength",
		"minlength",
		"name",
		"placeholder",
		"readonly",
		"required",
		"rows",
		"wrap",
	]),
	th: new Set(["abbr", "colspan", "headers", "rowspan", "scope"]),
	time: new Set(["datetime"]),
};

const BOOLEAN_ATTRIBUTES = new Set([
	"checked",
	"disabled",
	"hidden",
	"multiple",
	"open",
	"readonly",
	"required",
	"reversed",
	"selected",
]);

const URL_ATTRIBUTES = new Set(["cite", "href", "src"]);

type SanitizationPolicy = "general" | "network-free";

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
	amp: "&",
	apos: "'",
	colon: ":",
	gt: ">",
	lt: "<",
	newline: "\n",
	quot: '"',
	tab: "\t",
};

/**
 * File-safe identifier grammar shared by plan slugs, verdict slugs, and
 * variation keys. It excludes separators, dot-prefixes, whitespace, and
 * unbounded names before these values reach filesystem-oriented callers.
 */
const PROTO_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/** Validate a file-safe prototype slug/key and return the original string. */
export function validateProtoIdentifier(
	value: unknown,
	path = "prototype identifier",
): string {
	if (typeof value !== "string" || !PROTO_IDENTIFIER.test(value)) {
		fail(
			`${path} must match ${PROTO_IDENTIFIER.source} (1-128 letters, digits, underscores, or hyphens; starts alphanumeric)`,
		);
	}
	return value;
}

/** Validate an unknown value against the complete StyleGuide contract. */
export function validateStyleGuide(value: unknown): StyleGuide {
	requireRecord(value, "style guide");
	requireRecord(value.meta, "style guide.meta");
	requireString(value.meta.url, "style guide.meta.url");
	requireFiniteNumber(value.meta.scrapedAt, "style guide.meta.scrapedAt");
	if (typeof value.meta.sameOrigin !== "boolean") {
		fail("style guide.meta.sameOrigin must be a boolean");
	}

	requireRecord(value.tokens, "style guide.tokens");
	requireStringRecord(
		value.tokens.customProps,
		"style guide.tokens.customProps",
	);
	requireStringArray(value.tokens.colors, "style guide.tokens.colors", {
		nonEmpty: true,
	});
	requireString(value.tokens.fontStack, "style guide.tokens.fontStack");
	requireStringArray(value.tokens.typeScale, "style guide.tokens.typeScale");
	requireStringArray(value.tokens.spacing, "style guide.tokens.spacing");
	requireStringArray(value.tokens.radii, "style guide.tokens.radii");
	requireStringArray(value.tokens.shadows, "style guide.tokens.shadows");

	requireRecord(value.components, "style guide.components");
	requireStringRecord(value.components.button, "style guide.components.button");
	requireStringRecord(value.components.input, "style guide.components.input");
	requireStringRecord(value.components.link, "style guide.components.link");

	return value as StyleGuide;
}

/** Validate the structural ProtoPlan contract without sanitizing its markup. */
export function validateProtoPlan(value: unknown): ProtoPlan {
	requireRecord(value, "prototype plan");
	validateProtoIdentifier(value.slug, "prototype plan.slug");

	if (value.question !== undefined) {
		requireString(value.question, "prototype plan.question");
	}
	if (value.mountSelector !== undefined) {
		requireString(value.mountSelector, "prototype plan.mountSelector", {
			nonEmpty: true,
		});
	}
	requireOneOf(value.mode, "prototype plan.mode", [
		"replace",
		"takeover",
	] as const);
	if (!Array.isArray(value.variations) || value.variations.length === 0) {
		fail("prototype plan.variations must be a non-empty array");
	}

	const keys = new Set<string>();
	for (const [index, variation] of value.variations.entries()) {
		const path = `prototype plan.variations[${index}]`;
		requireRecord(variation, path);
		const key = validateProtoIdentifier(variation.key, `${path}.key`);
		if (keys.has(key)) {
			fail(`${path}.key must be unique`);
		}
		keys.add(key);
		requireString(variation.label, `${path}.label`, { nonEmpty: true });
		requireString(variation.html, `${path}.html`);
		requireString(variation.css, `${path}.css`);
	}

	return value as ProtoPlan;
}

/** Maximum number of variations accepted by transport and renderer boundaries. */
export const PROTO_MAX_VARIATIONS = 5;
/** Maximum combined HTML/CSS character count accepted for one prototype plan. */
export const PROTO_MAX_MARKUP_CHARS = 524_288;

/**
 * Validate the bounded comparison/render contract without changing the
 * structural-only semantics of validateProtoPlan.
 */
export function validateProtoRenderLimits(plan: ProtoPlan): ProtoPlan {
	if (plan.variations.length > PROTO_MAX_VARIATIONS) {
		fail(
			`prototype plan supports at most ${PROTO_MAX_VARIATIONS} variations; remove extra variations and retry`,
		);
	}

	let markupCharacters = 0;
	for (const variation of plan.variations) {
		markupCharacters += variation.html.length + variation.css.length;
		if (markupCharacters > PROTO_MAX_MARKUP_CHARS) {
			fail(
				`prototype plan HTML+CSS exceeds the ${PROTO_MAX_MARKUP_CHARS}-character render limit; trim variation markup and retry`,
			);
		}
	}
	return plan;
}

/** Validate an approve or reject verdict, including its action-specific fields. */
export function validateVerdict(value: unknown): Verdict {
	requireRecord(value, "verdict");
	validateProtoIdentifier(value.slug, "verdict.slug");
	validateProtoIdentifier(value.selectedKey, "verdict.selectedKey");
	requireFiniteNumber(value.ts, "verdict.ts");

	const hasFeedback = Object.hasOwn(value, "feedback");
	if (value.action === "approve") {
		if (hasFeedback) fail("approve verdicts must not include feedback");
		return value as Verdict;
	}
	if (value.action === "reject") {
		if (!hasFeedback) fail("reject verdicts must include feedback");
		requireString(value.feedback, "verdict.feedback", { nonEmpty: true });
		return value as Verdict;
	}

	return fail('verdict.action must be "approve" or "reject"');
}

function sortKeys(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortKeys);
	if (!isRecord(value)) return value;

	const sorted = Object.create(null) as Record<string, unknown>;
	for (const key of Object.keys(value).sort()) {
		sorted[key] = sortKeys(value[key]);
	}
	return sorted;
}

/** Serialize a StyleGuide with stable object-key ordering and array ordering intact. */
export function canonicalizeStyleGuide(value: unknown): string {
	const guide = validateStyleGuide(value);
	return `${JSON.stringify(sortKeys(guide), null, 2)}\n`;
}

function decodeHtmlEntities(value: string): string {
	return value
		.replace(
			/&#(?:x([0-9a-f]+)|([0-9]+));?/gi,
			(_match, hex: string | undefined, decimal: string | undefined) => {
				const codePoint = Number.parseInt(hex ?? decimal ?? "", hex ? 16 : 10);
				if (
					!Number.isFinite(codePoint) ||
					codePoint <= 0 ||
					codePoint > 0x10ffff ||
					(codePoint >= 0xd800 && codePoint <= 0xdfff)
				) {
					return "\uFFFD";
				}
				return String.fromCodePoint(codePoint);
			},
		)
		.replace(
			/&([a-z]+);?/gi,
			(match, name: string) => NAMED_ENTITIES[name.toLowerCase()] ?? match,
		);
}

function escapeAttribute(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll('"', "&quot;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;");
}

function escapeHtml(value: string): string {
	return escapeAttribute(value).replaceAll("'", "&#39;");
}

function normalizeCssForInspection(value: string): string {
	const withoutComments = value
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.replace(/\\(?:\r\n|[\n\r\f])/g, "");

	return withoutComments.replace(
		/\\([0-9a-f]{1,6})\s?|\\([^0-9a-f\r\n\f])/gi,
		(_match, hex: string | undefined, escaped: string | undefined) => {
			if (escaped !== undefined) return escaped;
			const codePoint = Number.parseInt(hex ?? "", 16);
			if (
				!Number.isFinite(codePoint) ||
				codePoint <= 0 ||
				codePoint > 0x10ffff ||
				(codePoint >= 0xd800 && codePoint <= 0xdfff)
			) {
				return "\uFFFD";
			}
			return String.fromCodePoint(codePoint);
		},
	);
}

function readCssIdentifier(
	css: string,
	start: number,
): { decoded: string; end: number } {
	let decoded = "";
	let index = start;

	while (index < css.length) {
		const character = css[index];
		if (/[-_a-z0-9]/i.test(character) || character.codePointAt(0)! > 0x7f) {
			decoded += character;
			index += 1;
			continue;
		}
		if (character !== "\\") break;

		const hex = /^[0-9a-f]{1,6}/i.exec(css.slice(index + 1));
		if (hex) {
			const codePoint = Number.parseInt(hex[0], 16);
			decoded +=
				codePoint > 0 &&
				codePoint <= 0x10ffff &&
				!(codePoint >= 0xd800 && codePoint <= 0xdfff)
					? String.fromCodePoint(codePoint)
					: "\uFFFD";
			index += 1 + hex[0].length;
			if (/\s/.test(css[index] ?? "")) index += 1;
			continue;
		}
		if (index + 1 < css.length) {
			decoded += css[index + 1];
			index += 2;
			continue;
		}
		decoded += "\uFFFD";
		index += 1;
	}

	return { decoded, end: index };
}

function maskCssStrings(value: string): string {
	const output = [...value];
	let quote: '"' | "'" | undefined;

	for (let index = 0; index < value.length; index += 1) {
		const character = value[index];
		if (quote) {
			output[index] = " ";
			if (character === "\\") {
				if (index + 1 < value.length) output[index + 1] = " ";
				index += 1;
			} else if (character === quote) {
				quote = undefined;
			}
		} else if (character === '"' || character === "'") {
			output[index] = " ";
			quote = character;
		}
	}

	return output.join("");
}

function findCssFunctionEnd(css: string, openingParenthesis: number): number {
	let depth = 0;
	let quote: '"' | "'" | undefined;

	for (let index = openingParenthesis; index < css.length; index += 1) {
		const character = css[index];
		if (quote) {
			if (character === "\\") {
				index += 1;
			} else if (character === quote) {
				quote = undefined;
			}
			continue;
		}
		if (character === '"' || character === "'") {
			quote = character;
		} else if (character === "(") {
			depth += 1;
		} else if (character === ")") {
			depth -= 1;
			if (depth === 0) return index + 1;
		}
	}

	return css.length;
}

function stripNetworkCssFunctions(css: string): string {
	const output: string[] = [];
	let cursor = 0;
	let quote: '"' | "'" | undefined;

	while (cursor < css.length) {
		const character = css[cursor];
		if (quote) {
			output.push(character);
			if (character === "\\") {
				if (cursor + 1 < css.length) output.push(css[cursor + 1]);
				cursor += 2;
				continue;
			}
			if (character === quote) quote = undefined;
			cursor += 1;
			continue;
		}
		if (character === '"' || character === "'") {
			quote = character;
			output.push(character);
			cursor += 1;
			continue;
		}
		if (/[-_a-z\\]/i.test(character)) {
			const identifier = readCssIdentifier(css, cursor);
			if (identifier.end <= cursor) {
				output.push(character);
				cursor += 1;
				continue;
			}
			let openingParenthesis = identifier.end;
			while (/\s/.test(css[openingParenthesis] ?? "")) {
				openingParenthesis += 1;
			}
			if (
				css[openingParenthesis] === "(" &&
				["url", "image-set", "-webkit-image-set", "expression"].includes(
					identifier.decoded.toLowerCase(),
				)
			) {
				output.push("none");
				cursor = findCssFunctionEnd(css, openingParenthesis);
				continue;
			}
			const rawIdentifier = css.slice(cursor, identifier.end);
			output.push(
				rawIdentifier.endsWith("\\")
					? `${rawIdentifier.slice(0, -1)}\uFFFD`
					: rawIdentifier,
			);
			cursor = identifier.end;
			continue;
		}
		output.push(character);
		cursor += 1;
	}

	return output.join("");
}

function findNextCssImport(css: string, from: number): number {
	let quote: '"' | "'" | undefined;

	for (let index = from; index < css.length; index += 1) {
		const character = css[index];
		if (quote) {
			if (character === "\\") {
				index += 1;
			} else if (character === quote) {
				quote = undefined;
			}
			continue;
		}
		if (character === '"' || character === "'") {
			quote = character;
			continue;
		}
		if (character === "@") {
			const identifier = readCssIdentifier(css, index + 1);
			if (identifier.decoded.toLowerCase() === "import") return index;
		}
	}

	return -1;
}

function stripCssImports(css: string): string {
	const output: string[] = [];
	let cursor = 0;

	while (cursor < css.length) {
		const importStart = findNextCssImport(css, cursor);
		if (importStart < 0) {
			output.push(css.slice(cursor));
			break;
		}
		output.push(css.slice(cursor, importStart));

		let quote: '"' | "'" | undefined;
		let depth = 0;
		let importEnd = css.length;
		const importIdentifier = readCssIdentifier(css, importStart + 1);
		for (let index = importIdentifier.end; index < css.length; index += 1) {
			const character = css[index];
			if (quote) {
				if (character === "\\") {
					index += 1;
				} else if (character === quote) {
					quote = undefined;
				}
				continue;
			}
			if (character === '"' || character === "'") {
				quote = character;
			} else if (character === "(") {
				depth += 1;
			} else if (character === ")") {
				depth = Math.max(0, depth - 1);
			} else if (character === ";" && depth === 0) {
				importEnd = index + 1;
				break;
			}
		}
		cursor = importEnd;
	}

	return output.join("");
}

function sanitizeStyleSheet(value: string): string {
	const prepared = value
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.replace(/\\(?:\r\n|[\n\r\f])/g, "");
	const inspection = normalizeCssForInspection(maskCssStrings(prepared));
	if (/(?:behavior\s*:|-moz-binding\s*:)/i.test(inspection)) {
		return "";
	}
	return stripNetworkCssFunctions(stripCssImports(prepared));
}

function sanitizeInlineStyle(value: string): string | undefined {
	const sanitized = sanitizeStyleSheet(value);
	return sanitized.trim().length > 0 ? sanitized : undefined;
}

function sanitizeUrl(
	value: string,
	tagName: string,
	attributeName: string,
	policy: SanitizationPolicy,
): string | undefined {
	const trimmed = value.trim();
	const schemeProbe = [...trimmed]
		.filter((character) => {
			const codePoint = character.codePointAt(0) ?? 0;
			return codePoint > 0x20 && (codePoint < 0x7f || codePoint > 0x9f);
		})
		.join("");

	if (/^data:/i.test(schemeProbe)) {
		if (
			tagName === "img" &&
			attributeName === "src" &&
			/^data:image\/(?:png|jpe?g|gif|webp)(?:;base64)?,/i.test(schemeProbe)
		) {
			return trimmed;
		}
		return undefined;
	}

	if (policy === "network-free") {
		if (attributeName === "href" && schemeProbe.startsWith("#")) {
			return trimmed;
		}
		return undefined;
	}

	const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(schemeProbe);
	if (
		scheme &&
		scheme[1].toLowerCase() !== "http" &&
		scheme[1].toLowerCase() !== "https"
	) {
		return undefined;
	}

	return trimmed;
}

function isAllowedAttribute(tagName: string, attributeName: string): boolean {
	return (
		GLOBAL_ATTRIBUTES.has(attributeName) ||
		TAG_ATTRIBUTES[tagName]?.has(attributeName) === true ||
		/^(?:aria|data)-[a-z0-9_.:-]+$/.test(attributeName)
	);
}

function findTagEnd(html: string, start: number): number {
	let quote: '"' | "'" | undefined;
	for (let index = start + 1; index < html.length; index += 1) {
		const character = html[index];
		if (quote) {
			if (character === quote) quote = undefined;
		} else if (character === '"' || character === "'") {
			quote = character;
		} else if (character === ">") {
			return index;
		}
	}
	return -1;
}

type ParsedAttribute = {
	name: string;
	value: string;
	hasValue: boolean;
};

function parseAttributes(source: string): ParsedAttribute[] {
	const attributes: ParsedAttribute[] = [];
	let index = 0;

	while (index < source.length) {
		while (index < source.length && /[\s/]/.test(source[index])) index += 1;
		if (index >= source.length) break;

		const nameStart = index;
		while (index < source.length && !/[\s=/>]/.test(source[index])) {
			index += 1;
		}
		if (index === nameStart) {
			index += 1;
			continue;
		}

		const name = source.slice(nameStart, index).toLowerCase();
		while (index < source.length && /\s/.test(source[index])) index += 1;

		let value = "";
		let hasValue = false;
		if (source[index] === "=") {
			hasValue = true;
			index += 1;
			while (index < source.length && /\s/.test(source[index])) index += 1;

			const quote = source[index];
			if (quote === '"' || quote === "'") {
				index += 1;
				const valueStart = index;
				while (index < source.length && source[index] !== quote) index += 1;
				value = source.slice(valueStart, index);
				if (source[index] === quote) index += 1;
			} else {
				const valueStart = index;
				while (index < source.length && !/[\s>]/.test(source[index])) {
					index += 1;
				}
				value = source.slice(valueStart, index);
			}
		}

		attributes.push({ name, value, hasValue });
	}

	return attributes;
}

function sanitizeAttributes(
	tagName: string,
	source: string,
	policy: SanitizationPolicy,
): string {
	const output: string[] = [];
	const seen = new Set<string>();

	for (const attribute of parseAttributes(source)) {
		const { name } = attribute;
		if (
			seen.has(name) ||
			name.startsWith("on") ||
			name === "formaction" ||
			name === "srcdoc" ||
			name === "xlink:href" ||
			!isAllowedAttribute(tagName, name)
		) {
			continue;
		}
		seen.add(name);

		if (BOOLEAN_ATTRIBUTES.has(name)) {
			output.push(name);
			continue;
		}

		let value = decodeHtmlEntities(attribute.value);
		if (name === "style") {
			const sanitized = sanitizeInlineStyle(value);
			if (sanitized === undefined) continue;
			value = sanitized;
		}
		if (URL_ATTRIBUTES.has(name)) {
			const sanitized = sanitizeUrl(value, tagName, name, policy);
			if (sanitized === undefined) continue;
			value = sanitized;
		}
		if (
			tagName === "input" &&
			name === "type" &&
			value.toLowerCase() === "image"
		) {
			continue;
		}

		output.push(
			`${name}="${escapeAttribute(attribute.hasValue ? value : "")}"`,
		);
	}

	return output.length > 0 ? ` ${output.join(" ")}` : "";
}

function skipBlockedElement(
	html: string,
	tagName: string,
	tagEnd: number,
): number {
	const lowerHtml = html.toLowerCase();
	const closingStart = lowerHtml.indexOf(`</${tagName}`, tagEnd + 1);
	if (closingStart < 0) return html.length;
	const closingEnd = findTagEnd(html, closingStart);
	return closingEnd < 0 ? html.length : closingEnd + 1;
}

function sanitizeVariationHtmlWithPolicy(
	html: string,
	policy: SanitizationPolicy,
): string {
	const output: string[] = [];
	let index = 0;

	while (index < html.length) {
		const tagStart = html.indexOf("<", index);
		if (tagStart < 0) {
			output.push(html.slice(index));
			break;
		}
		output.push(html.slice(index, tagStart));

		if (html.startsWith("<!--", tagStart)) {
			const commentEnd = html.indexOf("-->", tagStart + 4);
			index = commentEnd < 0 ? html.length : commentEnd + 3;
			continue;
		}

		const tagEnd = findTagEnd(html, tagStart);
		if (tagEnd < 0) {
			output.push("&lt;");
			index = tagStart + 1;
			continue;
		}

		const token = html.slice(tagStart, tagEnd + 1);
		const closing = /^<\/([a-z][a-z0-9:-]*)\s*>$/i.exec(token);
		if (closing) {
			const tagName = closing[1].toLowerCase();
			if (ALLOWED_TAGS.has(tagName) && !VOID_TAGS.has(tagName)) {
				output.push(`</${tagName}>`);
			}
			index = tagEnd + 1;
			continue;
		}

		const opening = /^<([a-z][a-z0-9:-]*)(?=[\s/>])/i.exec(token);
		if (!opening) {
			output.push("&lt;");
			index = tagStart + 1;
			continue;
		}

		const tagName = opening[1].toLowerCase();
		if (DROP_WITH_CONTENT_TAGS.has(tagName)) {
			index = skipBlockedElement(html, tagName, tagEnd);
			continue;
		}
		if (!ALLOWED_TAGS.has(tagName)) {
			index = tagEnd + 1;
			continue;
		}

		const attributeStart = opening[0].length;
		const selfClosing = /\/\s*>$/.test(token);
		const attributeEnd = token.length - (selfClosing ? 2 : 1);
		const attributes = sanitizeAttributes(
			tagName,
			token.slice(attributeStart, attributeEnd),
			policy,
		);
		output.push(`<${tagName}${attributes}>`);
		index = tagEnd + 1;
	}

	return output.join("");
}

/**
 * Coarse, dependency-free CLI-side pre-filter for prototype markup.
 *
 * This is deliberately non-authoritative. The extension must re-sanitize with
 * its DOM-based allowlist at render time; that second pass is the security
 * boundary.
 */
export function sanitizeVariationHtml(html: string): string {
	return sanitizeVariationHtmlWithPolicy(html, "general");
}

function neutralizeStyleText(css: string): string {
	return css.replaceAll("<", "\\3C ").replaceAll("-->", "--\\3E ");
}

/** Build a network-free standalone HTML answer from one sanitized variation. */
export function assembleAnswerPage(
	variation: ProtoVariation,
	meta: AnswerPageMeta,
): string {
	const body = sanitizeVariationHtmlWithPolicy(variation.html, "network-free");
	const css = neutralizeStyleText(sanitizeStyleSheet(variation.css));
	const sourceUrl = meta.url
		? `<dt>Source</dt><dd>${escapeHtml(meta.url)}</dd>`
		: "";
	const question = meta.question
		? `<dt>Question</dt><dd>${escapeHtml(meta.question)}</dd>`
		: "";

	return [
		"<!doctype html>",
		'<html lang="en">',
		"<head>",
		'<meta charset="utf-8">',
		`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'">`,
		'<meta name="viewport" content="width=device-width, initial-scale=1">',
		`<title>${escapeHtml(variation.label)}</title>`,
		`<style>${css}</style>`,
		"</head>",
		"<body>",
		`<aside data-prototype-meta><dl><dt>Variation</dt><dd>${escapeHtml(variation.label)}</dd>${sourceUrl}<dt>Scraped at</dt><dd>${escapeHtml(String(meta.scrapedAt))}</dd>${question}</dl></aside>`,
		body,
		"</body>",
		"</html>",
	].join("\n");
}
