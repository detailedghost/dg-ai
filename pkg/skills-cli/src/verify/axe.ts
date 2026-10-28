export interface AxeNode {
	html: string;
}

export interface AxeViolation {
	id: string;
	impact: "minor" | "moderate" | "serious" | "critical";
	help: string;
	nodes: AxeNode[];
}

export interface AxeReport {
	tool: "dg-axe-summary";
	engine: "local-static";
	violations: AxeViolation[];
	passes: string[];
}

const RULES = [
	"button-name",
	"document-title",
	"duplicate-id",
	"html-has-lang",
	"image-alt",
	"label",
	"link-name",
] as const;

const IMPACT_RANK = { critical: 0, serious: 1, moderate: 2, minor: 3 } as const;

function stripEmbedded(html: string): string {
	return html
		.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
		.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "");
}

function attr(tag: string, name: string): string | undefined {
	const match = new RegExp(
		`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`,
		"i",
	).exec(tag);
	return match?.[1] ?? match?.[2] ?? match?.[3];
}

function visibleText(inner: string): string {
	return inner
		.replace(/<[^>]+>/g, " ")
		.replace(/&nbsp;/gi, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function snippet(tag: string): string {
	const flat = tag.replace(/\s+/g, " ").trim();
	return flat.length > 180 ? `${flat.slice(0, 177)}...` : flat;
}

function violation(
	id: string,
	impact: AxeViolation["impact"],
	help: string,
	nodes: string[],
): AxeViolation {
	return {
		id,
		impact,
		help,
		nodes: nodes.slice(0, 3).map((html) => ({ html })),
	};
}

function documentTitle(html: string): AxeViolation | undefined {
	const match = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html);
	if (match && visibleText(match[1] ?? "").length > 0) return undefined;
	return violation(
		"document-title",
		"serious",
		"Documents must have a non-empty title",
		["<title>"],
	);
}

function htmlLang(html: string): AxeViolation | undefined {
	const match = /<html\b[^>]*>/i.exec(html);
	const lang = match ? attr(match[0], "lang") : undefined;
	if (lang && lang.trim().length > 0) return undefined;
	return violation(
		"html-has-lang",
		"serious",
		"The html element must have a lang attribute",
		[match?.[0] ?? "<html>"],
	);
}

function images(html: string): AxeViolation | undefined {
	const nodes: string[] = [];
	for (const match of html.matchAll(/<img\b[^>]*>/gi)) {
		const tag = match[0];
		const alt = attr(tag, "alt");
		if (alt === undefined) nodes.push(snippet(tag));
	}
	if (nodes.length === 0) return undefined;
	return violation(
		"image-alt",
		"critical",
		"Images must have alternate text",
		nodes,
	);
}

function namedControl(tag: string, inner: string): boolean {
	const label = attr(tag, "aria-label") ?? attr(tag, "aria-labelledby");
	if (label && label.trim().length > 0) return true;
	return visibleText(inner).length > 0;
}

function buttons(html: string): AxeViolation | undefined {
	const nodes: string[] = [];
	for (const match of html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/gi)) {
		const tag = `<button${match[1] ?? ""}>`;
		if (!namedControl(tag, match[2] ?? "")) nodes.push(snippet(tag));
	}
	if (nodes.length === 0) return undefined;
	return violation(
		"button-name",
		"critical",
		"Buttons must have discernible text",
		nodes,
	);
}

function links(html: string): AxeViolation | undefined {
	const nodes: string[] = [];
	for (const match of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
		const tag = `<a${match[1] ?? ""}>`;
		if (attr(tag, "href") === undefined) continue;
		if (!namedControl(tag, match[2] ?? "")) nodes.push(snippet(tag));
	}
	if (nodes.length === 0) return undefined;
	return violation("link-name", "serious", "Links must have discernible text", nodes);
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function wrapped(html: string, tag: string): boolean {
	for (const match of html.matchAll(/<label\b[^>]*>[\s\S]*?<\/label>/gi)) {
		if ((match[0] ?? "").includes(tag)) return true;
	}
	return false;
}

function labeled(html: string, tag: string): boolean {
	const aria = attr(tag, "aria-label") ?? attr(tag, "aria-labelledby");
	if (aria && aria.trim().length > 0) return true;
	if (wrapped(html, tag)) return true;
	const id = attr(tag, "id");
	if (!id) return false;
	const quoted = escapeRegExp(id);
	const forAttr = new RegExp(
		`<label\\b[^>]*\\bfor\\s*=\\s*(?:"${quoted}"|'${quoted}')`,
		"i",
	);
	return forAttr.test(html);
}

function fields(html: string): AxeViolation | undefined {
	const nodes: string[] = [];
	const pattern = /<(input|textarea|select)\b[^>]*>/gi;
	for (const match of html.matchAll(pattern)) {
		const tag = match[0];
		const type = (attr(tag, "type") ?? "").toLowerCase();
		if (["hidden", "button", "submit", "reset"].includes(type)) continue;
		if (!labeled(html, tag)) nodes.push(snippet(tag));
	}
	if (nodes.length === 0) return undefined;
	return violation("label", "critical", "Form fields must have labels", nodes);
}

function duplicateIds(html: string): AxeViolation | undefined {
	const counts = new Map<string, number>();
	for (const match of html.matchAll(/\bid\s*=\s*(?:"([^"]+)"|'([^']+)')/gi)) {
		const id = (match[1] ?? match[2] ?? "").trim();
		if (id.length === 0) continue;
		counts.set(id, (counts.get(id) ?? 0) + 1);
	}
	const nodes = [...counts.entries()]
		.filter(([, count]) => count > 1)
		.map(([id]) => `id="${id}"`);
	if (nodes.length === 0) return undefined;
	return violation("duplicate-id", "minor", "id attribute values must be unique", nodes);
}

/** Summarize one HTML document with the static axe rule ids this check implements. */
export function axeSummary(raw: string): AxeReport {
	const html = stripEmbedded(raw);
	const found = [
		documentTitle(html),
		htmlLang(html),
		images(html),
		buttons(html),
		links(html),
		fields(html),
		duplicateIds(html),
	].filter((item): item is AxeViolation => item !== undefined);
	const failed = new Set(found.map((item) => item.id));
	return {
		tool: "dg-axe-summary",
		engine: "local-static",
		violations: found,
		passes: RULES.filter((id) => !failed.has(id)),
	};
}

/** Merge per-shot reports into one item summary. A failure on any shot wins. */
export function mergeAxe(reports: AxeReport[]): AxeReport {
	const byId = new Map<string, AxeViolation>();
	for (const report of reports) {
		for (const violation of report.violations) {
			const existing = byId.get(violation.id);
			if (!existing) {
				byId.set(violation.id, {
					...violation,
					nodes: violation.nodes.slice(0, 3),
				});
				continue;
			}
			for (const node of violation.nodes) {
				if (existing.nodes.length >= 3) break;
				if (!existing.nodes.some((current) => current.html === node.html))
					existing.nodes.push(node);
			}
		}
	}
	const failed = new Set(byId.keys());
	const passes = new Set<string>();
	for (const report of reports) {
		for (const id of report.passes) {
			if (!failed.has(id)) passes.add(id);
		}
	}
	const violations = [...byId.values()].sort(
		(a, b) => IMPACT_RANK[a.impact] - IMPACT_RANK[b.impact] || a.id.localeCompare(b.id),
	);
	return {
		tool: "dg-axe-summary",
		engine: "local-static",
		violations,
		passes: [...passes].sort(),
	};
}
