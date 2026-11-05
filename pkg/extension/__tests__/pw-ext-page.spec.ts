import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Window } from "happy-dom";
import { pwExtPageAction } from "@/lib/features/pw-ext-page";

let window: Window;
const original = Object.getOwnPropertyDescriptor(globalThis, "document");

beforeEach(() => {
	window = new Window({ url: "https://app.example.test/home" });
	Object.defineProperty(globalThis, "document", {
		configurable: true,
		value: window.document,
	});
});

afterEach(async () => {
	if (original) Object.defineProperty(globalThis, "document", original);
	else delete (globalThis as { document?: unknown }).document;
	await window.happyDOM.close();
});

function page(html: string): void {
	window.document.title = "Home";
	window.document.body.innerHTML = html;
}

function el<T>(selector: string): T {
	return window.document.querySelector(selector) as unknown as T;
}

describe("snapshot", () => {
	it("lists roles, names and refs, and redacts secret field values", () => {
		page(`
			<h1>Welcome</h1>
			<nav><a href="/a">Docs</a></nav>
			<label for="email">Email</label><input id="email" value="me@example.test">
			<label>Password <input type="password" value="hunter2-secret"></label>
			<input name="api_token" value="abc123">
			<input type="checkbox" aria-label="Remember" checked>
			<button>Sign in</button>
			<div hidden><button>Ghost</button></div>
			<p>Some visible text</p>
		`);
		const result = pwExtPageAction({ kind: "snapshot" });
		if (!("tree" in result)) throw new Error(JSON.stringify(result));
		expect(result.tree).toContain('- heading "Welcome" [level=1]');
		expect(result.tree).toContain("- navigation");
		expect(result.tree).toContain('  - link "Docs" [ref=e1]');
		expect(result.tree).toContain('- textbox "Email" [ref=e2]: me@example.test');
		expect(result.tree).toContain('- textbox "Password" [ref=e3]: [redacted]');
		expect(result.tree).toContain("[redacted]");
		expect(result.tree).not.toContain("hunter2");
		expect(result.tree).not.toContain("abc123");
		expect(result.tree).toContain('- checkbox "Remember" [checked] [ref=e5]');
		expect(result.tree).toContain('- button "Sign in" [ref=e6]');
		expect(result.tree).not.toContain("Ghost");
		expect(result.text).toContain("Some visible text");
		expect(result.text).not.toContain("hunter2");
	});

	it("caps the tree size", () => {
		page(Array.from({ length: 3000 }, (_, i) => `<button>b${i}</button>`).join(""));
		const result = pwExtPageAction({ kind: "snapshot" });
		if (!("tree" in result)) throw new Error("no tree");
		expect(result.tree).toContain("[truncated");
		expect(result.tree.length).toBeLessThan(70_000);
	});
});

describe("click", () => {
	it("clicks a snapshot ref", () => {
		page(`<button id="go">Go</button>`);
		let clicks = 0;
		el<HTMLElement>("#go").addEventListener("click", () => clicks++);
		pwExtPageAction({ kind: "snapshot" });
		expect(pwExtPageAction({ kind: "click", target: "e1" })).toEqual({
			detail: 'clicked button "Go"',
		});
		expect(clicks).toBe(1);
	});

	it("clicks one CSS match and refuses none or several", () => {
		page(`<button class="a">One</button><button class="b">Two</button><button class="b">Three</button>`);
		expect(pwExtPageAction({ kind: "click", target: ".a" })).toEqual({
			detail: 'clicked button "One"',
		});
		expect(pwExtPageAction({ kind: "click", target: ".b" })).toEqual({
			error: expect.stringContaining("matches 2 elements"),
		});
		expect(pwExtPageAction({ kind: "click", target: ".none" })).toEqual({
			error: expect.stringContaining("No element"),
		});
		expect(pwExtPageAction({ kind: "click", target: "[[" })).toEqual({
			error: expect.stringContaining("not a valid"),
		});
	});

	it("asks for a new snapshot when a ref is unknown", () => {
		page(`<button>Go</button>`);
		expect(pwExtPageAction({ kind: "click", target: "e9" })).toEqual({
			error: expect.stringContaining("snapshot"),
		});
	});
});

describe("fill", () => {
	it("sets the value, fires input and change, and never echoes the value", () => {
		page(`<input id="q" aria-label="Search">`);
		const events: string[] = [];
		const input = el<HTMLInputElement>("#q");
		input.addEventListener("input", () => events.push("input"));
		input.addEventListener("change", () => events.push("change"));
		const result = pwExtPageAction({ kind: "fill", target: "#q", value: "kittens" });
		expect(result).toEqual({ detail: 'filled textbox "Search"' });
		expect(input.value).toBe("kittens");
		expect(events).toEqual(["input", "change"]);
	});

	it.each([
		`<input id="t" type="password">`,
		`<input id="t" autocomplete="one-time-code">`,
		`<input id="t" name="client_secret">`,
	])("refuses a secret field: %s", (html) => {
		page(html);
		expect(pwExtPageAction({ kind: "fill", target: "#t", value: "x" })).toEqual({
			error: expect.stringContaining("password or secret"),
		});
		expect(el<HTMLInputElement>("#t").value).toBe("");
	});

	it("refuses a non-editable target", () => {
		page(`<button id="b">B</button><input id="r" readonly>`);
		for (const target of ["#b", "#r"])
			expect(pwExtPageAction({ kind: "fill", target, value: "x" })).toEqual({
				error: expect.stringContaining("cannot be filled"),
			});
	});
});

describe("selection", () => {
	it("returns selected page text", () => {
		page(`<p id="p">Hello world</p>`);
		const range = window.document.createRange();
		range.selectNodeContents(el<Node>("#p") as never);
		window.getSelection()?.addRange(range);
		expect(pwExtPageAction({ kind: "selection" })).toEqual({ text: "Hello world" });
	});

	it("returns nothing from a focused password field", () => {
		page(`<input id="pw" type="password" value="secret-value">`);
		const input = el<HTMLInputElement>("#pw");
		input.focus();
		input.setSelectionRange(0, 12);
		expect(pwExtPageAction({ kind: "selection" })).toEqual({ text: "" });
	});
});

describe("console", () => {
	it("starts capture on the first call and reports later errors", () => {
		page("");
		expect(pwExtPageAction({ kind: "console" })).toEqual({
			started: true,
			entries: [],
		});
		const ErrorEventCtor = window.ErrorEvent;
		window.dispatchEvent(
			new ErrorEventCtor("error", {
				message: "Boom",
				filename: "https://app.example.test/a.js",
				lineno: 4,
			}),
		);
		const second = pwExtPageAction({ kind: "console" });
		expect(second).toEqual({
			started: false,
			entries: ["[error] Boom (https://app.example.test/a.js:4)"],
		});
	});
});

describe("review round 1 hardening", () => {
	it("refuses to act when the document URL differs from the approved URL", () => {
		page(`<button id="go">Go</button>`);
		let clicks = 0;
		el<HTMLElement>("#go").addEventListener("click", () => clicks++);
		expect(
			pwExtPageAction({ kind: "click", target: "#go" }, "https://other.example.test/"),
		).toEqual({ error: expect.stringContaining("changed") });
		expect(clicks).toBe(0);
		expect(
			pwExtPageAction({ kind: "click", target: "#go" }, "https://app.example.test/home"),
		).toEqual({ detail: 'clicked button "Go"' });
	});

	it("keeps secret textarea and contenteditable text out of the visible text", () => {
		page(`
			<textarea name="client_secret">unpatterned-credential-123</textarea>
			<div contenteditable="true" id="api_token" role="textbox">second-credential-456</div>
			<p>public words</p>
		`);
		const result = pwExtPageAction({ kind: "snapshot" });
		const text = JSON.stringify(result);
		expect(text).not.toContain("unpatterned-credential-123");
		expect(text).not.toContain("second-credential-456");
		expect(text).toContain("public words");
	});

	it("returns nothing for a selection inside a secret field", () => {
		page(`<div contenteditable="true" id="api_token"><span id="s">second-credential-456</span></div>`);
		const range = window.document.createRange();
		range.selectNodeContents(el<Node>("#s") as never);
		window.getSelection()?.addRange(range);
		expect(pwExtPageAction({ kind: "selection" })).toEqual({ text: "" });
	});

	it("bounds page-controlled strings in its result", () => {
		page(`<button id="b" role="${"x".repeat(5000)}">Go</button>`);
		window.document.title = "t".repeat(1_000_000);
		const snap = pwExtPageAction({ kind: "snapshot" });
		expect(JSON.stringify(snap).length).toBeLessThan(100_000);
		const click = pwExtPageAction({ kind: "click", target: "#b" });
		expect(JSON.stringify(click).length).toBeLessThan(500);
	});
});
