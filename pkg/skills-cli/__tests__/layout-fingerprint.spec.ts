import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import {
	collectLayout,
	type ControlRow,
	identityKeys,
	type LayoutFound,
	type LayoutResult,
	PROTOTYPE_CHROME_SELECTOR,
} from "../src/layout/fingerprint";

let win: Window;

beforeEach(() => {
	win = new Window({ url: "http://localhost/" });
	Object.defineProperty(globalThis, "window", { configurable: true, value: win });
	Object.defineProperty(globalThis, "document", { configurable: true, value: win.document });
});

afterEach(() => {
	Reflect.deleteProperty(globalThis, "window");
	Reflect.deleteProperty(globalThis, "document");
});

function read(body: string, root = '[data-verify-root="demo"]'): LayoutResult {
	win.document.body.innerHTML = body;
	return collectLayout({ root, chrome: PROTOTYPE_CHROME_SELECTOR });
}

function found(body: string): LayoutFound {
	const result = read(body);
	if ("error" in result) throw new Error(result.error);
	return result;
}

function root(inner: string): string {
	return `<main data-verify-root="demo">${inner}</main>`;
}

describe("collectLayout", () => {
	test("assigns implicit roles by tag and input type in DOM order", () => {
		const { controls } = found(
			root(
				[
					'<a href="/x">Link</a>',
					"<button>Btn</button>",
					"<details><summary>More</summary></details>",
					'<input type="submit" value="Send">',
					'<input type="checkbox" aria-label="c">',
					'<input type="radio" aria-label="r">',
					'<input type="range" aria-label="s">',
					'<input type="search" aria-label="q">',
					'<input type="text" aria-label="t">',
					'<input type="hidden" name="h">',
					'<textarea aria-label="area"></textarea>',
					'<select aria-label="pick"></select>',
					'<div contenteditable="true">edit</div>',
					'<div tabindex="0">focusable</div>',
					'<div tabindex="-1">skipped</div>',
					'<div role="tab">Tab</div>',
				].join(""),
			),
		);
		expect(controls.map((control) => control.role)).toEqual([
			"link",
			"button",
			"button",
			"button",
			"checkbox",
			"radio",
			"slider",
			"searchbox",
			"textbox",
			"textbox",
			"combobox",
			"textbox",
			"generic",
			"tab",
		]);
		expect(controls.map((control) => control.i)).toEqual(
			controls.map((_, index) => index),
		);
	});

	test("takes the name from the highest-precedence source", () => {
		const { controls } = found(
			root(
				[
					'<span id="lab">Labelled by</span>',
					'<button aria-label="Aria" aria-labelledby="lab" title="Title">Text</button>',
					'<button aria-labelledby="lab" title="Title">Text</button>',
					'<label for="field">Associated</label><input id="field" placeholder="Hint">',
					'<input placeholder="Hint" title="Title">',
					'<button title="Title"><span>Text</span></button>',
					'<button title="Title"></button>',
					'<button><img src="x.png" alt="Alt"></button>',
					'<input type="submit" value="Submit it">',
				].join(""),
			),
		);
		expect(controls.map((control) => control.name)).toEqual([
			"Aria",
			"Labelled by",
			"Associated",
			"Hint",
			"Text",
			"Title",
			"Alt",
			"Submit it",
		]);
	});

	test("collapses whitespace and cuts names to 80 characters", () => {
		const { controls } = found(
			root(`<button>  one\n   two  </button><button>${"x".repeat(200)}</button>`),
		);
		expect(controls[0]?.name).toBe("one two");
		expect(controls[1]?.name).toHaveLength(80);
	});

	test("reads data-testid and leaves it null otherwise", () => {
		const { controls } = found(
			root('<button data-testid="add-note">Add</button><button>Plain</button>'),
		);
		expect(controls.map((control) => control.testid)).toEqual(["add-note", null]);
	});

	test("shortens paths to tag#id, tag.firstClass, or an nth-child chain cut to 120 characters", () => {
		const nested = `${"<div>".repeat(40)}<button>deep</button>${"</div>".repeat(40)}`;
		const { controls } = found(
			root(
				`<button id="save" class="a b">Save</button><button class="primary big">Go</button><div><button>Plain</button></div>${nested}`,
			),
		);
		expect(controls[0]?.path).toBe("button#save");
		expect(controls[1]?.path).toBe("button.primary");
		expect(controls[2]?.path).toBe("div:nth-child(3) > button:nth-child(1)");
		expect(controls[3]?.path.length).toBeLessThanOrEqual(120);
		expect(controls[3]?.path.startsWith("div:nth-child(4)")).toBe(true);
	});

	test("lists a display:none or hidden control as not visible instead of dropping it", () => {
		const { controls } = found(
			root(
				'<button>Shown</button><button style="display:none">Gone</button><span hidden><button>Hidden</button></span>',
			),
		);
		expect(controls.map((control) => [control.name, control.visible])).toEqual([
			["Shown", true],
			["Gone", false],
			["Hidden", false],
		]);
	});

	test("hides the prototype chrome and leaves its controls out", () => {
		win.document.body.innerHTML = [
			root("<button>Keep</button>"),
			'<div id="protobar" role="toolbar" aria-label="Prototype decision"><button>Approve</button></div>',
			'<div id="prototype-switcher"><button>Switch</button></div>',
		].join("");
		const result = collectLayout({
			root: '[data-verify-root="demo"]',
			chrome: PROTOTYPE_CHROME_SELECTOR,
		});
		if ("error" in result) throw new Error(result.error);
		expect(result.controls.map((control) => control.name)).toEqual(["Keep"]);
		const bar = win.document.getElementById("protobar") as unknown as HTMLElement;
		expect(bar.style.display).toBe("none");
	});

	test("also leaves out chrome that sits inside the root", () => {
		const { controls } = found(
			root(
				'<button>Keep</button><div id="proto-decision-bar"><button>Approve</button></div>',
			),
		);
		expect(controls.map((control) => control.name)).toEqual(["Keep"]);
	});

	test("returns an error object when no visible root exists", () => {
		expect(read("<button>x</button>")).toEqual({
			error: 'root: found 0 visible [data-verify-root="demo"]',
		});
	});

	test("returns an error object when two visible roots exist and ignores a hidden one", () => {
		expect(read(`${root("")}${root("")}`)).toEqual({
			error: 'root: found 2 visible [data-verify-root="demo"]',
		});
		const result = read(
			`${root("<button>a</button>")}<section style="display:none" data-verify-root="demo"></section>`,
		);
		expect("error" in result).toBe(false);
	});

	test("reports the theme from data-theme, then the dark class, then the color scheme", () => {
		const html = win.document.documentElement;
		html.setAttribute("data-theme", "dark");
		expect(found(root("")).themeApplied).toBe("dark");
		html.removeAttribute("data-theme");
		html.classList.add("dark");
		expect(found(root("")).themeApplied).toBe("dark");
		html.classList.remove("dark");
		expect(["light", "unknown"]).toContain(found(root("")).themeApplied);
	});

	test("records integer boxes, bands, and the root box", () => {
		const result = found(root("<button>One</button>"));
		expect(result.root).toEqual({ x: 0, y: 0, w: 0, h: 0 });
		const control = result.controls[0] as ControlRow;
		expect(Number.isInteger(control.box.x)).toBe(true);
		expect(["top", "middle", "bottom"]).toContain(control.band);
		expect(["left", "center", "right"]).toContain(control.hband);
		expect(control.occluded).toBe(false);
		expect(control.occluder).toBeNull();
	});
});

describe("identityKeys", () => {
	const control = (role: string, name: string, testid: string | null = null) => ({
		role,
		name,
		testid,
	});

	test("prefers the test id and otherwise joins role and normalized name", () => {
		expect(
			identityKeys([
				control("button", "Add   Note...", "add"),
				control("button", "Add   Note..."),
				control("link", "Docs…"),
			]),
		).toEqual(["add", "button|add note", "link|docs"]);
	});

	test("numbers repeated keys in DOM order", () => {
		expect(
			identityKeys([
				control("button", "Edit"),
				control("button", "Edit"),
				control("button", "edit"),
				control("button", "Other"),
			]),
		).toEqual(["button|edit", "button|edit#2", "button|edit#3", "button|other"]);
	});
});
