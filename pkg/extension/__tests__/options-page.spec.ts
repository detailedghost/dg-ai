import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Window } from "happy-dom";
import { mountTabs } from "../entrypoints/options/tabs";

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
			"webmcpScriptsPanel",
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

	it("has no pairing panel, theme toggle or nav landmark", () => {
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

function tabbedPage(hash = ""): { window: Window; document: Document } {
	const window = new Window({ url: `chrome-extension://abc/options.html${hash}` });
	windows.add(window);
	window.document.documentElement.innerHTML = readEntry("index.html");
	const document = window.document as unknown as Document;
	mountTabs(document.getElementById("tabs") as HTMLElement, { fallback: "general" });
	return { window, document };
}

function visiblePanels(document: Document): string[] {
	return [...document.querySelectorAll<HTMLElement>('[role="tabpanel"]')]
		.filter((panel) => !panel.hidden)
		.map((panel) => panel.dataset.panel as string);
}

function tab(document: Document, id: string): HTMLElement {
	return document.querySelector(`[role="tab"][data-tab="${id}"]`) as HTMLElement;
}

function press(window: Window, target: Element, key: string): void {
	target.dispatchEvent(new window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }) as unknown as Event);
}

describe("settings tabs", () => {
	it("opens the settings page in its own browser tab", () => {
		expect(readEntry("index.html")).toContain('<meta name="manifest.open_in_tab" content="true" />');
	});

	it("uses tablist, tab and tabpanel roles wired by aria", () => {
		const { document } = tabbedPage();
		const tabs = [...document.querySelectorAll('[role="tablist"] > [role="tab"]')];

		expect(tabs.map((node) => node.textContent)).toEqual(["General", "MCP", "Narration", "About"]);
		for (const node of tabs) {
			const panel = document.getElementById(node.getAttribute("aria-controls") as string) as Element;
			expect(panel.getAttribute("role")).toBe("tabpanel");
			expect(panel.getAttribute("aria-labelledby")).toBe(node.id);
		}
	});

	it("keeps the Web MCP scripts panel only in the MCP tab", () => {
		const { document } = tabbedPage();
		const mcp = document.getElementById("panel-mcp") as Element;

		expect(mcp.querySelector("#webmcpScriptsPanel")).not.toBeNull();
		for (const id of ["color", "assetDirectoryPanel", "narration", "testTts"]) {
			expect(mcp.querySelector(`#${id}`), id).toBeNull();
		}
	});

	it("shows General by default with one selected, focusable tab", () => {
		const { document } = tabbedPage();

		expect(visiblePanels(document)).toEqual(["general"]);
		expect(tab(document, "general").getAttribute("aria-selected")).toBe("true");
		expect(tab(document, "mcp").getAttribute("aria-selected")).toBe("false");
		expect(tab(document, "general").tabIndex).toBe(0);
		expect(tab(document, "mcp").tabIndex).toBe(-1);
	});

	it("opens the tab named in the URL hash", () => {
		const { document } = tabbedPage("#mcp");

		expect(visiblePanels(document)).toEqual(["mcp"]);
		expect(tab(document, "mcp").getAttribute("aria-selected")).toBe("true");
	});

	it("falls back to General for an unknown hash", () => {
		expect(visiblePanels(tabbedPage("#nope").document)).toEqual(["general"]);
	});

	it("switches on click and writes the hash", () => {
		const { window, document } = tabbedPage();
		tab(document, "narration").click();

		expect(visiblePanels(document)).toEqual(["narration"]);
		expect(window.location.hash).toBe("#narration");
	});

	it("follows hash changes made outside the page", async () => {
		const { window, document } = tabbedPage();
		window.location.hash = "about";
		await new Promise<void>((resolve) => setTimeout(resolve, 0));

		expect(visiblePanels(document)).toEqual(["about"]);
	});

	it("moves between tabs with the arrow, Home and End keys, wrapping at the ends", () => {
		const { window, document } = tabbedPage();

		press(window, tab(document, "general"), "ArrowRight");
		expect(visiblePanels(document)).toEqual(["mcp"]);
		expect(document.activeElement).toBe(tab(document, "mcp"));
		expect(window.location.hash).toBe("#mcp");

		press(window, tab(document, "mcp"), "ArrowLeft");
		press(window, tab(document, "general"), "ArrowLeft");
		expect(visiblePanels(document)).toEqual(["about"]);

		press(window, tab(document, "about"), "ArrowRight");
		expect(visiblePanels(document)).toEqual(["general"]);

		press(window, tab(document, "general"), "End");
		expect(visiblePanels(document)).toEqual(["about"]);
		press(window, tab(document, "about"), "Home");
		expect(visiblePanels(document)).toEqual(["general"]);
	});

	it("ignores other keys", () => {
		const { window, document } = tabbedPage();
		press(window, tab(document, "general"), "a");

		expect(visiblePanels(document)).toEqual(["general"]);
	});
});

describe("review page settings link", () => {
	it("targets the Narration tab", () => {
		const html = readFileSync(
			fileURLToPath(new URL("../entrypoints/review/index.html", import.meta.url)),
			"utf8",
		);

		expect(html).toContain('href="/options.html#narration"');
	});
});
