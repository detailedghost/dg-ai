import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Window } from "happy-dom";

const TOKEN_BLOCK_SHA256 =
	"2093195ba40ed729a120cd0a135a75a44f6f30135cac2e1040c04aa218e738df";

const DOCUMENT_POSITION_FOLLOWING = 4;

const windows = new Set<Window>();

afterEach(async () => {
	await Promise.all([...windows].map((window) => window.happyDOM.close()));
	windows.clear();
});

function readEntry(name: string): string {
	return readFileSync(
		fileURLToPath(new URL(`../entrypoints/options/${name}`, import.meta.url)),
		"utf8",
	);
}

function settingsDocument(): { html: string; document: Document } {
	const html = readEntry("index.html");
	const window = new Window();
	windows.add(window);
	window.document.documentElement.innerHTML = html;
	return { html, document: window.document as unknown as Document };
}

function summaryOf(details: Element): string {
	return details.querySelector("summary")?.textContent?.trim() ?? "";
}

describe("slim settings page", () => {
	it("keeps the asset directory, narration and tab grouping color controls", () => {
		const { document } = settingsDocument();

		for (const id of [
			"assetDirectoryPanel",
			"color",
			"narration",
			"voice",
			"videoQuality",
			"testTts",
		]) {
			expect(document.getElementById(id), id).not.toBeNull();
		}
		expect(document.body.textContent).toContain("Tab grouping");
		expect(document.body.textContent).toContain("Test narration");
	});

	it("has no pairing panel, theme toggle, nav or hash routing", () => {
		const { html, document } = settingsDocument();

		expect(html).not.toContain("pairPanel");
		expect(document.getElementById("theme")).toBeNull();
		expect(document.querySelector("nav")).toBeNull();
		expect(html).not.toContain("#/privacy");
		expect(html).not.toContain("#/kudos");
		expect(html).not.toContain("page-privacy");
		expect(html).not.toContain("page-kudos");
	});

	it("ends with two closed folds, Privacy then Kudos", () => {
		const { document } = settingsDocument();
		const folds = [...document.querySelectorAll("details")];

		expect(folds.map(summaryOf)).toEqual(["Privacy", "Kudos"]);
		for (const fold of folds) {
			expect(fold.hasAttribute("open")).toBe(false);
		}
		const test = document.getElementById("testTts") as Element;
		expect(
			test.compareDocumentPosition(folds[0] as Element) &
				DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
	});

	it("lists the six privacy disclosures", () => {
		const { document } = settingsDocument();
		const privacy = [...document.querySelectorAll("details")].find(
			(fold) => summaryOf(fold) === "Privacy",
		) as Element;
		const text = privacy.textContent ?? "";

		expect(privacy.querySelectorAll("li")).toHaveLength(6);
		expect(text).toContain("URL");
		expect(text).toContain("fragment");
		expect(text).toContain("<all_urls>");
		expect(text).toContain("telemetry");
		expect(text).toContain("Hugging Face");
		expect(text).toContain("jsDelivr");
	});

	it("credits Kokoro, Transformers.js, ONNX Runtime Web and WXT in the Kudos fold", () => {
		const { document } = settingsDocument();
		const kudos = [...document.querySelectorAll("details")].find(
			(fold) => summaryOf(fold) === "Kudos",
		) as Element;
		const text = kudos.textContent ?? "";

		for (const credit of ["Kokoro", "Transformers.js", "ONNX Runtime Web", "WXT"]) {
			expect(text).toContain(credit);
		}
	});
});

describe("options/style.css token block", () => {
	it("is byte-identical above the first @layer, because the daemon pages inline it", () => {
		const css = readEntry("style.css");
		const block = css.slice(0, css.indexOf("@layer"));

		expect(new Bun.CryptoHasher("sha256").update(block).digest("hex")).toBe(
			TOKEN_BLOCK_SHA256,
		);
	});

	it("carries no popup component classes", () => {
		const css = readEntry("style.css");

		for (const selector of [".pill", ".qrbox", ".ag", ".tree", ".cnt", ".alt", ".logo"]) {
			expect(css, selector).not.toMatch(
				new RegExp(`${selector.replace(".", "\\.")}[\\s{,.:>]`),
			);
		}
	});
});
