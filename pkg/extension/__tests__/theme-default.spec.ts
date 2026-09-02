import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DEFAULTS, getTheme, patchConfig } from "@/lib/config";
import { DEMO_THEME_CSS } from "@/lib/picker";

function optionsCss(): string {
	return readFileSync(
		fileURLToPath(new URL("../entrypoints/options/style.css", import.meta.url)),
		"utf8",
	);
}

function blockFor(css: string, selector: string): string {
	const at = css.indexOf(selector);
	if (at < 0) return "";
	return css.slice(at, css.indexOf("}", at));
}

describe("dark is the default theme, light is a choice", () => {
	it("ships dark as the stored default", () => {
		expect(DEFAULTS.theme).toBe("dark");
	});

	it("accepts light and falls back to dark for anything unrecognized", () => {
		expect(getTheme("light")).toBe("light");
		expect(getTheme("dark")).toBe("dark");
		expect(getTheme("")).toBe("dark");
		expect(getTheme("solarized")).toBe("dark");
	});
});

describe("options/style.css serves an explicit theme unconditionally", () => {
	it("defines both explicit themes, on different grounds", () => {
		const css = optionsCss();
		const dark = blockFor(css, ':root[data-theme="dark"]');
		const light = blockFor(css, ':root[data-theme="light"]');

		expect(dark).toContain("--bg:");
		expect(light).toContain("--bg:");
		expect(/--bg:\s*([^;]+)/.exec(dark)?.[1]).not.toBe(
			/--bg:\s*([^;]+)/.exec(light)?.[1],
		);
	});

	it("puts both after the OS gate, so a chosen theme beats the OS", () => {
		const css = optionsCss();
		const gate = css.indexOf("prefers-color-scheme");

		expect(gate).toBeGreaterThan(0);
		expect(css.indexOf(':root[data-theme="dark"]')).toBeGreaterThan(gate);
		expect(css.indexOf(':root[data-theme="light"]')).toBeGreaterThan(gate);
	});
});

describe("the demo overlays default to dark too", () => {
	it("carries the dark ground in the base :host, not behind a query", () => {
		const start = DEMO_THEME_CSS.indexOf(":host {");
		const base = DEMO_THEME_CSS.slice(
			start,
			DEMO_THEME_CSS.indexOf("}", start),
		);

		expect(base).toContain("--ink: #e8e8e8");
		expect(base).toContain("--panel: #111111");
	});

	it("keeps light reachable, gated on the host's own theme", () => {
		expect(DEMO_THEME_CSS).toContain(':host([data-theme="light"])');
		expect(DEMO_THEME_CSS).not.toContain("prefers-color-scheme");
	});
});
