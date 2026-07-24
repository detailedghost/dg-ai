import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { type ProtoVariation, type Verdict, validateVerdict } from "@dg/common";
import { Window } from "happy-dom";
import { styleGuideDownloadOptions } from "@/lib/background/proto";
import {
	collectStyleSamples,
	PROTO_SAVE_STYLE_GUIDE,
	PROTO_STYLE_SCAN_LIMITS,
	styleGuideFromSamples,
} from "@/lib/features/prototype";

const window = new Window();
const document = window.document as unknown as Document;
const globalDescriptors = {
	document: Object.getOwnPropertyDescriptor(globalThis, "document"),
	getComputedStyle: Object.getOwnPropertyDescriptor(
		globalThis,
		"getComputedStyle",
	),
	location: Object.getOwnPropertyDescriptor(globalThis, "location"),
	DOMParser: Object.getOwnPropertyDescriptor(globalThis, "DOMParser"),
	HTMLElement: Object.getOwnPropertyDescriptor(globalThis, "HTMLElement"),
	window: Object.getOwnPropertyDescriptor(globalThis, "window"),
};

Object.defineProperties(globalThis, {
	document: { configurable: true, value: document },
	getComputedStyle: {
		configurable: true,
		value: window.getComputedStyle.bind(window),
	},
	location: { configurable: true, value: window.location },
	DOMParser: { configurable: true, value: window.DOMParser },
	HTMLElement: { configurable: true, value: window.HTMLElement },
	window: { configurable: true, value: window },
});

afterAll(() => {
	for (const [key, descriptor] of Object.entries(globalDescriptors)) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
});

beforeEach(() => {
	document.body.replaceChildren();
});

function setArea(element: Element, area: number): void {
	Object.defineProperty(element, "getBoundingClientRect", {
		configurable: true,
		value: () =>
			({
				bottom: area,
				height: 1,
				left: 0,
				right: area,
				top: 0,
				width: area,
				x: 0,
				y: 0,
				toJSON: () => ({}),
			}) satisfies DOMRect,
	});
}

function byId(id: string): Element {
	const element = document.getElementById(id);
	if (!element) throw new Error(`missing fixture element: ${id}`);
	return element;
}

type PickerState = {
	keys: string[];
	currentIndex: number;
	selectedKey: string | null;
	approved: boolean;
};

type PickerAction =
	| { type: "previous" }
	| { type: "next" }
	| { type: "select" }
	| { type: "approve" };

type PrototypePickerContracts = {
	applyTrustedPrototypeHostStyles(
		host: HTMLElement,
		computed: CSSStyleDeclaration,
	): void;
	pickerMachine(state: PickerState, action: PickerAction): PickerState;
	pickerVerdictKey(
		state: PickerState,
		action: "approve" | "reject",
	): string | null;
	setPrototypeCycleFlash(host: HTMLElement, active: boolean): void;
	plantPrototype(plan: unknown): Promise<void>;
	buildVerdict(input: {
		slug: string;
		action: "approve" | "reject";
		selectedKey: string;
		feedback?: string;
		ts: number;
	}): Verdict;
	sanitizePrototypeVariation(variation: ProtoVariation): ProtoVariation;
};

async function pickerContracts(): Promise<PrototypePickerContracts> {
	return (await import(
		"@/lib/features/prototype"
	)) as unknown as PrototypePickerContracts;
}

describe("collectStyleSamples", () => {
	it("includes the body as the first fixed-roster sample", () => {
		document.body.style.color = "rgb(91, 92, 93)";
		document.body.innerHTML = '<p style="color:rgb(1, 2, 3)">Descendant</p>';

		try {
			const samples = collectStyleSamples();

			expect(samples.colors).toContain("rgb(91, 92, 93)");
			expect(samples.colors.indexOf("rgb(91, 92, 93)")).toBeLessThan(
				samples.colors.indexOf("rgb(1, 2, 3)"),
			);
		} finally {
			document.body.removeAttribute("style");
		}
	});

	it("caps root custom-property scanning and output deterministically", () => {
		for (let index = 0; index < 140; index += 1) {
			document.documentElement.style.setProperty(
				`--dg-sample-${index.toString().padStart(3, "0")}`,
				String(index),
			);
		}

		try {
			const customProps = collectStyleSamples().customProps;

			expect(Object.keys(customProps)).toHaveLength(
				PROTO_STYLE_SCAN_LIMITS.customProperties,
			);
			expect(customProps["--dg-sample-000"]).toBe("0");
			expect(
				customProps[
					`--dg-sample-${(PROTO_STYLE_SCAN_LIMITS.customProperties - 1)
						.toString()
						.padStart(3, "0")}`
				],
			).toBe(String(PROTO_STYLE_SCAN_LIMITS.customProperties - 1));
			expect(
				customProps[
					`--dg-sample-${PROTO_STYLE_SCAN_LIMITS.customProperties
						.toString()
						.padStart(3, "0")}`
				],
			).toBeUndefined();
		} finally {
			document.documentElement.removeAttribute("style");
		}
	});

	it("stops inspecting computed root properties at the scan ceiling", () => {
		const originalGetComputedStyle = globalThis.getComputedStyle;
		let inspected = 0;
		Object.defineProperty(globalThis, "getComputedStyle", {
			configurable: true,
			value(element: Element) {
				if (element !== document.documentElement) {
					return originalGetComputedStyle(element);
				}
				return new Proxy(originalGetComputedStyle(element), {
					get(target, property, receiver) {
						if (property === "length") {
							return PROTO_STYLE_SCAN_LIMITS.rootStyleProperties + 100;
						}
						if (property === "item") {
							return (index: number) => {
								inspected += 1;
								return index === PROTO_STYLE_SCAN_LIMITS.rootStyleProperties
									? "--outside-scan"
									: `display-${index}`;
							};
						}
						return Reflect.get(target, property, receiver);
					},
				});
			},
		});

		try {
			const customProps = collectStyleSamples().customProps;

			expect(inspected).toBe(PROTO_STYLE_SCAN_LIMITS.rootStyleProperties);
			expect(customProps["--outside-scan"]).toBeUndefined();
		} finally {
			Object.defineProperty(globalThis, "getComputedStyle", {
				configurable: true,
				value: originalGetComputedStyle,
			});
		}
	});

	it("bounds DOM scanning and fixed-roster styles to a deterministic prefix", () => {
		document.body.innerHTML = Array.from(
			{ length: 600 },
			(_, index) =>
				`<p style="color:rgb(${index % 256}, ${Math.floor(index / 256)}, 1)">Sample ${index}</p>`,
		).join("");
		const originalGetComputedStyle = globalThis.getComputedStyle;
		let styleReads = 0;
		Object.defineProperty(globalThis, "getComputedStyle", {
			configurable: true,
			value(element: Element) {
				styleReads += 1;
				return originalGetComputedStyle(element);
			},
		});

		try {
			const samples = collectStyleSamples();

			expect(styleReads).toBeLessThanOrEqual(
				PROTO_STYLE_SCAN_LIMITS.domElements +
					PROTO_STYLE_SCAN_LIMITS.fixedRoster +
					2,
			);
			expect(samples.colors).toContain("rgb(62, 0, 1)");
			expect(samples.colors).not.toContain("rgb(63, 0, 1)");
			expect(samples.colors.indexOf("rgb(0, 0, 1)")).toBeLessThan(
				samples.colors.indexOf("rgb(62, 0, 1)"),
			);
		} finally {
			Object.defineProperty(globalThis, "getComputedStyle", {
				configurable: true,
				value: originalGetComputedStyle,
			});
		}
	});

	it("merges selected cards and roster elements in true DOM order", () => {
		document.body.innerHTML = `
			<div id="earlier-card" style="display:block;border-left:1px solid black;color:rgb(200, 0, 0)"></div>
			<button id="later-roster" style="display:block;border:none;background:transparent;color:rgb(0, 0, 200)">Later</button>
		`;
		setArea(byId("earlier-card"), 200);
		setArea(byId("later-roster"), 100);

		const colors = styleGuideFromSamples(collectStyleSamples()).tokens.colors;

		expect(colors.indexOf("rgb(200, 0, 0)")).toBeLessThan(
			colors.indexOf("rgb(0, 0, 200)"),
		);
	});

	it("recognizes a nonzero border on every side as card-like", () => {
		for (const [index, side] of ["top", "right", "bottom", "left"].entries()) {
			document.body.innerHTML = `<div id="card" style="display:block;border-${side}:1px solid black;color:rgb(${index + 1}, 20, 30)"></div>`;
			setArea(byId("card"), 100);

			expect(collectStyleSamples().colors).toContain(
				`rgb(${index + 1}, 20, 30)`,
			);
		}
	});

	it("caps cards at three and excludes nested duplicates", () => {
		document.body.innerHTML = `
			<div id="outer" style="display:block;border:1px solid;color:rgb(10, 0, 0)">
				<div id="nested" style="display:block;border:1px solid;color:rgb(20, 0, 0)"></div>
			</div>
			<div id="second" style="display:block;border:1px solid;color:rgb(30, 0, 0)"></div>
			<div id="third" style="display:block;border:1px solid;color:rgb(40, 0, 0)"></div>
			<div id="fourth" style="display:block;border:1px solid;color:rgb(50, 0, 0)"></div>
		`;
		setArea(byId("outer"), 500);
		setArea(byId("nested"), 450);
		setArea(byId("second"), 400);
		setArea(byId("third"), 300);
		setArea(byId("fourth"), 200);

		const colors = collectStyleSamples().colors;

		expect(colors).toContain("rgb(10, 0, 0)");
		expect(colors).toContain("rgb(30, 0, 0)");
		expect(colors).toContain("rgb(40, 0, 0)");
		expect(colors).not.toContain("rgb(20, 0, 0)");
		expect(colors).not.toContain("rgb(50, 0, 0)");
	});
});

it("uses the payload slug and overwrite policy for style-guide downloads", () => {
	const options = styleGuideDownloadOptions({
		type: PROTO_SAVE_STYLE_GUIDE,
		slug: "payload-slug",
		styleGuide: {
			meta: {
				url: "https://example.test",
				scrapedAt: 1,
				sameOrigin: true,
			},
			tokens: {
				customProps: {},
				colors: ["rgb(0, 0, 0)"],
				fontStack: "sans-serif",
				typeScale: [],
				spacing: [],
				radii: [],
				shadows: [],
			},
			components: { button: {}, input: {}, link: {} },
		},
	});

	expect(options.filename).toBe("dg-proto/payload-slug/style-guide.json");
	expect(options.conflictAction).toBe("overwrite");
});

describe("pickerMachine", () => {
	it("wraps both directions, selects the focused key, and gates approval", async () => {
		const { pickerMachine } = await pickerContracts();
		const initial: PickerState = {
			keys: ["compact", "detailed", "visual"],
			currentIndex: 0,
			selectedKey: null,
			approved: false,
		};

		const previous = pickerMachine(initial, { type: "previous" });
		const wrappedNext = pickerMachine(
			{ ...initial, currentIndex: initial.keys.length - 1 },
			{ type: "next" },
		);
		const blockedApproval = pickerMachine(initial, { type: "approve" });
		const focused = pickerMachine(initial, { type: "next" });
		const selected = pickerMachine(focused, { type: "select" });
		const approved = pickerMachine(selected, { type: "approve" });

		expect(previous.currentIndex).toBe(2);
		expect(wrappedNext.currentIndex).toBe(0);
		expect(blockedApproval.approved).toBe(false);
		expect(selected.selectedKey).toBe("detailed");
		expect(approved.approved).toBe(true);
		expect(initial).toEqual({
			keys: ["compact", "detailed", "visual"],
			currentIndex: 0,
			selectedKey: null,
			approved: false,
		});
	});

	it("clears a prior selection when cycling to a different variation", async () => {
		const { pickerMachine } = await pickerContracts();
		const selected = pickerMachine(
			{
				keys: ["compact", "detailed", "visual"],
				currentIndex: 0,
				selectedKey: null,
				approved: false,
			},
			{ type: "select" },
		);

		const cycled = pickerMachine(selected, { type: "next" });

		expect(cycled.currentIndex).toBe(1);
		expect(cycled.selectedKey).toBeNull();
		expect(cycled.approved).toBe(false);
	});

	it("uses explicit selection for approval and current focus for rejection", async () => {
		const { pickerVerdictKey } = await pickerContracts();
		const focusedWithoutSelection: PickerState = {
			keys: ["compact", "detailed", "visual"],
			currentIndex: 1,
			selectedKey: null,
			approved: false,
		};

		expect(pickerVerdictKey(focusedWithoutSelection, "approve")).toBeNull();
		expect(pickerVerdictKey(focusedWithoutSelection, "reject")).toBe(
			"detailed",
		);
	});
});

describe("buildVerdict", () => {
	it("builds validator-approved approve and reject arms", async () => {
		const { buildVerdict } = await pickerContracts();
		const approve = buildVerdict({
			slug: "account-summary",
			action: "approve",
			selectedKey: "compact",
			feedback: "Approve verdicts must discard this.",
			ts: 1_721_234_567_890,
		});
		const reject = buildVerdict({
			slug: "account-summary",
			action: "reject",
			selectedKey: "detailed",
			feedback: "Reduce the density.",
			ts: 1_721_234_567_891,
		});
		expect(() =>
			buildVerdict({
				slug: "account-summary",
				action: "reject",
				selectedKey: "detailed",
				ts: 1_721_234_567_892,
			}),
		).toThrow(/feedback/i);

		expect(validateVerdict(approve)).toEqual({
			slug: "account-summary",
			action: "approve",
			selectedKey: "compact",
			ts: 1_721_234_567_890,
		});
		expect(validateVerdict(reject)).toEqual({
			slug: "account-summary",
			action: "reject",
			selectedKey: "detailed",
			feedback: "Reduce the density.",
			ts: 1_721_234_567_891,
		});
	});
});

describe("sanitizePrototypeVariation", () => {
	it("uses the browser allowlist and neutralizes overlay-capable CSS", async () => {
		const { sanitizePrototypeVariation } = await pickerContracts();
		const source: ProtoVariation = {
			key: "safe-preview",
			label: "Safe preview",
			html: [
				"<section>",
				'<img src="data:image/png;base64,iVBORw0KGgo=" onerror="alert(1)">',
				'<a href="javascript:alert(2)">Unsafe link</a>',
				'<p data-kind="benign">Hello <strong>world</strong></p>',
				"<script>window.top.location='https://attacker.test'</script>",
				"</section>",
			].join(""),
			css: [
				".fixed { position: fixed; z-index: 2147483647; }",
				".absolute { position: absolute; z-index: 999999; }",
				".benign { position: relative; z-index: 2; color: blue; }",
			].join("\n"),
		};

		const sanitized = sanitizePrototypeVariation(source);
		const parsed = new window.DOMParser().parseFromString(
			sanitized.html,
			"text/html",
		);

		expect(sanitized.key).toBe(source.key);
		expect(sanitized.label).toBe(source.label);
		expect(parsed.querySelector("script")).toBeNull();
		expect(parsed.querySelector("img")?.hasAttribute("onerror")).toBe(false);
		expect(parsed.querySelector("a")?.hasAttribute("href")).toBe(false);
		expect(parsed.querySelector("p")?.getAttribute("data-kind")).toBe("benign");
		expect(parsed.querySelector("strong")?.textContent).toBe("world");
		expect(sanitized.css).not.toMatch(/position\s*:\s*(?:fixed|absolute)/i);
		expect(sanitized.css).not.toMatch(/z-index\s*:\s*(?:999999|2147483647)/i);
		expect(sanitized.css).toMatch(/position\s*:\s*relative/i);
		expect(sanitized.css).toMatch(/color\s*:\s*blue/i);
	});

	it("blocks encoded URLs and escaped, commented, or indirect overlay CSS", async () => {
		const { sanitizePrototypeVariation } = await pickerContracts();
		const sanitized = sanitizePrototypeVariation({
			key: "adversarial-preview",
			label: "Adversarial preview",
			html: [
				"<section>",
				'<a id="encoded" href="jav&#x61;script:alert(1)">Encoded link</a>',
				'<a id="benign-link" href="#details">Details</a>',
				'<div id="inline" style="PoSi/**/TiOn: v\\61 r(--overlay); z-\\69 ndex: -999999; color: green">Benign text</div>',
				"</section>",
			].join(""),
			css: [
				".escaped { p\\6f sition: f\\69 xed !important; z-\\69 ndex: calc(999999); }",
				".commented { POSITION/**/: ABSOLUTE; Z-INDEX: 1001; }",
				".benign { position: relative; z-index: 1000; color: rebeccapurple; }",
			].join("\n"),
		});
		const parsed = new window.DOMParser().parseFromString(
			sanitized.html,
			"text/html",
		);
		const inlineStyle = parsed.querySelector("#inline")?.getAttribute("style");

		expect(parsed.querySelector("#encoded")?.hasAttribute("href")).toBe(false);
		expect(parsed.querySelector("#benign-link")?.getAttribute("href")).toBe(
			"#details",
		);
		expect(inlineStyle).toMatch(/position\s*:\s*static/i);
		expect(inlineStyle).toMatch(/z-index\s*:\s*0/i);
		expect(inlineStyle).toMatch(/color\s*:\s*green/i);
		expect(sanitized.css).not.toMatch(/position\s*:\s*(?:fixed|absolute|var)/i);
		expect(sanitized.css).not.toMatch(/z-index\s*:\s*(?:1001|999999)/i);
		expect(sanitized.css).toMatch(/position\s*:\s*relative/i);
		expect(sanitized.css).toMatch(/z-index\s*:\s*1000/i);
		expect(sanitized.css).toMatch(/color\s*:\s*rebeccapurple/i);
	});

	it("rejects host-targeting rules and scopes benign variation CSS", async () => {
		const { applyTrustedPrototypeHostStyles, sanitizePrototypeVariation } =
			await pickerContracts();
		const sanitized = sanitizePrototypeVariation({
			key: "hostile-host",
			label: "Hostile host",
			html: '<section class="safe">Safe</section>',
			css: [
				":host { all: initial !important; position: fixed !important; }",
				":h\\6f st-context(body) { overflow: visible !important; }",
				"::sl\\6f tted(*) { display: none !important; }",
				".safe { color: teal; }",
			].join("\n"),
		});

		expect(sanitized.css).not.toMatch(/:host|:host-context|::slotted/i);
		expect(sanitized.css).not.toMatch(/all\s*:\s*initial/i);
		expect(sanitized.css).toContain("@scope ([data-dg-prototype])");
		expect(sanitized.css).toMatch(/\.safe\s*\{\s*color\s*:\s*teal/i);

		const target = document.createElement("section");
		target.style.display = "grid";
		target.style.width = "24rem";
		document.body.appendChild(target);
		const host = document.createElement("dg-proto-host");
		applyTrustedPrototypeHostStyles(host, getComputedStyle(target));
		for (const property of [
			"contain",
			"display",
			"max-width",
			"overflow",
			"width",
		]) {
			expect(host.style.getPropertyPriority(property)).toBe("important");
		}
	});
});

it("applies and clears the trusted neon cycle flash", async () => {
	const { setPrototypeCycleFlash } = await pickerContracts();
	const host = document.createElement("dg-proto-host");

	setPrototypeCycleFlash(host, true);
	expect(host.style.getPropertyValue("outline")).toContain("#00f0ff");
	expect(host.style.getPropertyPriority("outline")).toBe("important");
	expect(host.style.getPropertyValue("box-shadow")).toContain("#00f0ff");

	setPrototypeCycleFlash(host, false);
	expect(host.style.getPropertyValue("outline")).toBe("");
	expect(host.style.getPropertyValue("box-shadow")).toBe("");
});

it("restores the target and removes hosts when setup fails after hiding", async () => {
	const { plantPrototype } = await pickerContracts();
	document.body.innerHTML = `
		<p id="before">Before</p>
		<section id="mount" style="display:grid;color:red">Original</section>
		<p id="after">After</p>
	`;
	const target = document.getElementById("mount") as HTMLElement;
	const originalCss = target.style.cssText;
	const attachShadowDescriptor = Object.getOwnPropertyDescriptor(
		window.HTMLElement.prototype,
		"attachShadow",
	);
	let attemptedHostTag = "";
	Object.defineProperty(window.HTMLElement.prototype, "attachShadow", {
		configurable: true,
		value(this: HTMLElement) {
			attemptedHostTag = this.tagName;
			throw new Error("forced shadow setup failure");
		},
	});

	try {
		await expect(
			plantPrototype({
				slug: "rollback-safe",
				mountSelector: "#mount",
				mode: "replace",
				variations: [
					{
						key: "first",
						label: "First",
						html: "<p>Preview</p>",
						css: "p { color: blue; }",
					},
				],
			}),
		).rejects.toThrow("forced shadow setup failure");
	} finally {
		if (attachShadowDescriptor) {
			Object.defineProperty(
				window.HTMLElement.prototype,
				"attachShadow",
				attachShadowDescriptor,
			);
		} else {
			Reflect.deleteProperty(window.HTMLElement.prototype, "attachShadow");
		}
	}

	expect(attemptedHostTag).toBe("DIV");
	expect(target.style.cssText).toBe(originalCss);
	expect([...document.body.children].map((element) => element.id)).toEqual([
		"before",
		"mount",
		"after",
	]);
	expect(document.querySelector('[id^="dg-proto-host-"]')).toBeNull();
	expect(document.querySelector('[id^="dg-proto-controls-"]')).toBeNull();
});

it("replaces only the selected mount in replace mode and restores it on cleanup", async () => {
	const { plantPrototype } = await pickerContracts();
	document.body.innerHTML = `
		<p id="before">Before</p>
		<section id="mount">Original</section>
		<p id="after">After</p>
	`;
	const original = [...document.body.childNodes];

	await plantPrototype({
		slug: "replace-mode",
		mountSelector: "#mount",
		mode: "replace",
		variations: [
			{
				key: "first",
				label: "First",
				html: "<p>Preview</p>",
				css: "p { color: blue; }",
			},
		],
	});

	expect([...document.body.children].map((element) => element.id)).toEqual([
		"before",
		expect.stringMatching(/^dg-proto-host-/),
		"mount",
		"after",
	]);
	expect((document.getElementById("mount") as HTMLElement).style.display).toBe(
		"none",
	);

	window.dispatchEvent(new window.Event("pagehide"));

	expect([...document.body.childNodes]).toEqual(original);
});

it("replaces the full body in takeover mode and restores every original node", async () => {
	const { plantPrototype } = await pickerContracts();
	document.body.innerHTML = `
		<header id="header">Header</header>
		<main id="mount">Original mount</main>
		<footer id="footer">Footer</footer>
	`;
	const original = [...document.body.childNodes];

	await plantPrototype({
		slug: "takeover-mode",
		mountSelector: "#mount",
		mode: "takeover",
		variations: [
			{
				key: "first",
				label: "First",
				html: "<main>Full-page preview</main>",
				css: "main { color: blue; }",
			},
		],
	});

	expect([...document.body.children].map((element) => element.id)).toEqual([
		expect.stringMatching(/^dg-proto-host-/),
	]);
	expect(document.getElementById("mount")).toBeNull();

	window.dispatchEvent(new window.Event("pagehide"));

	expect([...document.body.childNodes]).toEqual(original);
});
