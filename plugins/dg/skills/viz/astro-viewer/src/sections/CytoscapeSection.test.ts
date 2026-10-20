import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * RED suite for the viz-cytoscape-section slice (spec: 001_erd.md, lines
 * 516-557). No Astro-component render harness exists in this bun:test suite
 * (see xss-json-island-escaping.test.ts) so these tests work against the
 * real .astro source text directly, plus — for the security-critical escape
 * function — extract and *execute* the real client-script logic via Bun's
 * TS transpiler rather than re-implementing it in the test.
 */

const FILE_PATH = join(import.meta.dir, "CytoscapeSection.astro");

function readSource(): string {
	return readFileSync(FILE_PATH, "utf-8");
}

/** Extracts the balanced-brace body of the first non-inline <script> block (the client script). */
function extractClientScript(src: string): string {
	const marker = src.search(/<script>(?!.*is:inline)/s);
	// find a <script> tag that is NOT is:inline
	const scriptTags = [...src.matchAll(/<script(\s[^>]*)?>/g)];
	for (const tag of scriptTags) {
		const attrs = tag[1] ?? "";
		if (attrs.includes("is:inline")) continue;
		const start = tag.index! + tag[0].length;
		const end = src.indexOf("</script>", start);
		if (end === -1) continue;
		return src.slice(start, end);
	}
	throw new Error("no client <script> block found in CytoscapeSection.astro");
}

/** Balanced-brace extraction of a named function's full source (handles nested braces, unlike a lazy regex). */
function extractFunctionSource(scriptSrc: string, fnName: string): string {
	const defIdx = scriptSrc.search(new RegExp(`function\\s+${fnName}\\s*\\(`));
	if (defIdx === -1) throw new Error(`function ${fnName} not found in client script`);
	const braceStart = scriptSrc.indexOf("{", defIdx);
	if (braceStart === -1) throw new Error(`no body found for function ${fnName}`);
	let depth = 0;
	for (let i = braceStart; i < scriptSrc.length; i++) {
		if (scriptSrc[i] === "{") depth++;
		else if (scriptSrc[i] === "}") {
			depth--;
			if (depth === 0) return scriptSrc.slice(defIdx, i + 1);
		}
	}
	throw new Error(`unbalanced braces extracting ${fnName}`);
}

/** Transpiles real extracted TS source to JS and evaluates it, returning the callable function. */
function loadRealFunction(scriptSrc: string, fnName: string): (...args: unknown[]) => unknown {
	const tsSrc = extractFunctionSource(scriptSrc, fnName);
	const transpiler = new Bun.Transpiler({ loader: "ts" });
	const jsSrc = transpiler.transformSync(tsSrc);
	const factory = new Function(`${jsSrc}\nreturn ${fnName};`);
	return factory();
}

describe("CytoscapeSection.astro — dependency wiring", () => {
	it("cytoscape-node-html-label is declared as a dependency (astro-viewer/package.json)", () => {
		const pkg = JSON.parse(readFileSync(join(import.meta.dir, "..", "..", "package.json"), "utf-8"));
		expect(pkg.dependencies["cytoscape-node-html-label"]).toBeDefined();
	});
});

describe("CytoscapeSection.astro — props contract", () => {
	it("declares a Props interface accepting a payload: ErdPayload", () => {
		const src = readSource();
		expect(/interface\s+Props\s*\{[^}]*payload\s*:\s*ErdPayload/s.test(src)).toBe(true);
	});

	it("does not import or call anything from erd-render.ts (Mermaid string is not the input)", () => {
		const src = readSource();
		expect(src).not.toMatch(/erd-render/);
		expect(src).not.toMatch(/from\s+["']mermaid["']/);
	});
});

describe("CytoscapeSection.astro — flowchart + ER panels present", () => {
	it("initializes cytoscape with the cytoscape-dagre layout for the flowchart panel", () => {
		const src = readSource();
		expect(src).toMatch(/import\s+cytoscape\s+from\s+["']cytoscape["']/);
		expect(src).toMatch(/import\s+cytoscapeDagre\s+from\s+["']cytoscape-dagre["']/);
		expect(src).toMatch(/cytoscape\.use\(cytoscapeDagre/);
	});

	it("registers cytoscape-node-html-label and casts the nodeHtmlLabel call site to any", () => {
		const src = readSource();
		expect(src).toMatch(/from\s+["']cytoscape-node-html-label["']/);
		expect(src).toMatch(/\(cy as any\)\.nodeHtmlLabel\(/);
	});

	it("builds ER cards from DbNode/DbColumn fields (name, dataType, isPrimaryKey, isForeignKey)", () => {
		const src = readSource();
		expect(src).toMatch(/\.dataType/);
		expect(src).toMatch(/isPrimaryKey/);
		expect(src).toMatch(/isForeignKey/);
	});
});

describe("CytoscapeSection.astro — caption line", () => {
	it("renders '<scope> · generated <timestamp>' style caption when both scope and generatedAt are present", () => {
		const src = readSource();
		// contract: a caption combining scope and generatedAt with a middle-dot separator and the word "generated"
		expect(/scope/.test(src) && /generatedAt/.test(src)).toBe(true);
		expect(src).toMatch(/generated/);
	});

	it("does not unconditionally render 'undefined' text for the caption (graceful single-field degrade)", () => {
		const src = readSource();
		// A naive `${scope} · generated ${generatedAt}` template with no guards would print
		// the literal string "undefined" whenever one field is missing — the fix is a
		// conditional (&&/ternary) around each half of the caption, not raw interpolation.
		expect(src).toMatch(/scope\s*&&|scope\s*\?/);
		expect(src).toMatch(/generatedAt\s*&&|generatedAt\s*\?/);
	});
});

describe("CytoscapeSection.astro — panel visibility on empty graphs", () => {
	it("gates the flowchart panel on a non-empty codeNodes array", () => {
		const src = readSource();
		expect(src).toMatch(/codeNodes(\?\.length|\.length)\s*(>|>=|!==\s*0)/);
	});

	it("gates the ER panel on a non-empty dbNodes array", () => {
		const src = readSource();
		expect(src).toMatch(/dbNodes(\?\.length|\.length)\s*(>|>=|!==\s*0)/);
	});
});

describe("CytoscapeSection.astro — theming", () => {
	it("implements an isDark()-style theme check reacting to <html class>", () => {
		const src = readSource();
		expect(src).toMatch(/isDark/);
		expect(src).toMatch(/documentElement\.classList\.contains\(['"]dark['"]\)/);
	});

	it("observes <html> class mutations via MutationObserver", () => {
		const src = readSource();
		expect(src).toMatch(/new MutationObserver/);
		expect(src).toMatch(/attributeFilter:\s*\[['"]class['"]\]/);
	});
});

describe("CytoscapeSection.astro — layout", () => {
	it("both panel containers use overflow: auto (do not clip a diagram wider than the viewport)", () => {
		const src = readSource();
		const overflowAutoCount = [...src.matchAll(/overflow:\s*auto/g)].length;
		expect(overflowAutoCount).toBeGreaterThanOrEqual(2);
	});
});

describe("CytoscapeSection.astro — payload.graph absence", () => {
	it("frontmatter defaults graph fields instead of dereferencing an absent payload.graph", () => {
		const src = readSource();
		// contract: component must not throw if invoked with {} — expects a nullish-coalescing
		// or optional-chaining guard around payload.graph before reading its sub-fields.
		expect(src).toMatch(/payload\.graph\s*\?\.|payload\.graph\s*\?\?/);
	});
});

describe("CytoscapeSection.astro — error banner", () => {
	it("uses the exact copy 'Diagram failed to render — raw source below' for a panel render failure", () => {
		const src = readSource();
		expect(src).toContain("Diagram failed to render — raw source below");
	});

	it("wraps each panel's cytoscape init independently (a try/catch per panel) so one failure can't block the other", () => {
		const src = readSource();
		const tryCount = [...src.matchAll(/\btry\s*\{/g)].length;
		expect(tryCount).toBeGreaterThanOrEqual(2);
	});
});

describe("CytoscapeSection.astro — JSON-island escaping (XSS guard, matches LineageSection.astro pattern)", () => {
	it("escapes '<' before embedding graph data via set:html", () => {
		const src = readSource();
		const varMatch = src.match(/set:html=\{(\w+)\}/);
		expect(varMatch).not.toBeNull();
		const varName = varMatch![1];
		const assignMatch = src.match(new RegExp(`const ${varName} = ([^\\n]+)`));
		expect(assignMatch).not.toBeNull();
		expect(/\.replace\(\/</.test(assignMatch![1])).toBe(true);
	});
});

describe("CytoscapeSection.astro — ER card HTML escaping (security regression guard)", () => {
	// Canonical hostile input per spec Security section — must remain in the suite.
	const HOSTILE_NAME = 'Robert"><img src=x onerror=alert(1)>';

	it("escapes a hostile table/column name so it cannot break out of the card markup or execute", () => {
		const scriptSrc = extractClientScript(readSource());
		const escHtml = loadRealFunction(scriptSrc, "escHtml") as (s: string) => string;
		const escaped = escHtml(HOSTILE_NAME);

		expect(escaped).not.toContain("<img");
		expect(escaped).not.toContain('">');
		expect(escaped).toContain("&lt;img");
		expect(escaped).toContain("&quot;");
	});

	it("round-trips a benign name unchanged in meaning (identity check, not just absence of angle brackets)", () => {
		const scriptSrc = extractClientScript(readSource());
		const escHtml = loadRealFunction(scriptSrc, "escHtml") as (s: string) => string;
		expect(escHtml("positions")).toBe("positions");
	});
});
