import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import {
	STYLE_GUIDE_MAX_CONTROLS,
	type ProtoVariation,
	type Verdict,
	validateVerdict,
} from "@dg/common";
import {
	type HTMLElement as HappyHTMLElement,
	type ShadowRoot as HappyShadowRoot,
	Window,
} from "happy-dom";
import {
	collectStyleSamples,
	detectPageNotReady,
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
	HTMLInputElement: Object.getOwnPropertyDescriptor(
		globalThis,
		"HTMLInputElement",
	),
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
	HTMLInputElement: { configurable: true, value: window.HTMLInputElement },
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

async function captureShadowRoots(
	run: () => Promise<void>,
): Promise<HappyShadowRoot[]> {
	const shadowRoots: HappyShadowRoot[] = [];
	const attachShadowDescriptor = Object.getOwnPropertyDescriptor(
		window.HTMLElement.prototype,
		"attachShadow",
	);
	const originalAttachShadow = window.HTMLElement.prototype.attachShadow;
	Object.defineProperty(window.HTMLElement.prototype, "attachShadow", {
		configurable: true,
		value(this: HappyHTMLElement, init: ShadowRootInit) {
			const root = originalAttachShadow.call(this, init);
			shadowRoots.push(root);
			return root;
		},
	});

	try {
		await run();
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
	return shadowRoots;
}

type PickerState = {
	keys: string[];
	currentIndex: number;
	selectedKey: string | null;
	approved: boolean;
	showingOriginal: boolean;
};

type PickerAction =
	| { type: "previous" }
	| { type: "next" }
	| { type: "select" }
	| { type: "approve" }
	| { type: "toggle-original" };

type PrototypePickerContracts = {
	applyTrustedPrototypeHostStyles(
		host: HTMLElement,
		computed: CSSStyleDeclaration,
	): void;
	pickerMachine(state: PickerState, action: PickerAction): PickerState;
	pickerVerdictKey(
		state: PickerState,
		action: "approve" | "reject" | "tweak",
	): string | null;
	setPrototypeCycleFlash(host: HTMLElement, active: boolean): void;
	plantPrototype(plan: unknown): Promise<void>;
	buildVerdict(input: {
		slug: string;
		action: "approve" | "reject" | "tweak";
		selectedKey: string;
		notes?: string;
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
					3,
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

	it("captures Bootstrap form controls with their host classes so an agent can reuse them", () => {
		document.body.style.color = "rgb(33, 37, 41)";
		document.body.innerHTML = `
			<form>
				<div class="form-check">
					<input type="radio" class="form-check-input" name="choice">
				</div>
				<input type="text" class="form-control">
				<select class="form-select"><option>One</option></select>
				<textarea class="form-control"></textarea>
				<button type="submit" class="btn btn-primary">Save</button>
			</form>
		`;

		try {
			const samples = collectStyleSamples();
			const guide = styleGuideFromSamples(samples);

			expect(samples.controls[0]).toEqual({
				tag: "input",
				type: "radio",
				classes: "form-check-input",
				wrapperClasses: "form-check",
			});
			expect(samples.controls.map((control) => control.tag)).toEqual([
				"input",
				"input",
				"select",
				"textarea",
				"button",
			]);
			expect(guide.controls).toEqual(samples.controls);
			expect(guide.components.select).toBeDefined();
			expect(guide.components.textarea).toBeDefined();
		} finally {
			document.body.removeAttribute("style");
		}
	});

	it("bounds collected controls to the shared StyleGuide control limit", () => {
		document.body.innerHTML = Array.from(
			{ length: 40 },
			(_, index) => `<input class="field-${index}">`,
		).join("");

		const samples = collectStyleSamples();

		expect(samples.controls.length).toBeLessThanOrEqual(
			STYLE_GUIDE_MAX_CONTROLS,
		);
	});

	it("skips a hidden first input when sampling the input component", () => {
		document.body.innerHTML = `
			<input type="hidden" name="csrf" value="token">
			<input type="text" style="color:rgb(9, 9, 9)">
		`;

		const samples = collectStyleSamples();

		expect(samples.components.input.color).toBe("rgb(9, 9, 9)");
	});

	it("reads data-bs-theme over a generic data-theme and over computed color-scheme", () => {
		document.documentElement.setAttribute("data-bs-theme", "dark");
		document.documentElement.setAttribute("data-theme", "light");

		try {
			expect(collectStyleSamples().meta.colorScheme).toBe("dark");
		} finally {
			document.documentElement.removeAttribute("data-bs-theme");
			document.documentElement.removeAttribute("data-theme");
		}
	});

	it("falls back to a generic data-theme attribute when data-bs-theme is absent", () => {
		document.documentElement.setAttribute("data-theme", "dark");

		try {
			expect(collectStyleSamples().meta.colorScheme).toBe("dark");
		} finally {
			document.documentElement.removeAttribute("data-theme");
		}
	});

	it("omits colorScheme when neither theme attribute nor computed color-scheme is set", () => {
		expect(collectStyleSamples().meta.colorScheme).toBeUndefined();
	});
});

describe("detectPageNotReady", () => {
	function withLocation<T>(href: string, run: () => T): T {
		const descriptor = Object.getOwnPropertyDescriptor(globalThis, "location");
		const url = new URL(href);
		Object.defineProperty(globalThis, "location", {
			configurable: true,
			value: { href, origin: url.origin, pathname: url.pathname },
		});
		try {
			return run();
		} finally {
			if (descriptor) Object.defineProperty(globalThis, "location", descriptor);
		}
	}

	function withNavigationStatus<T>(status: number | undefined, run: () => T): T {
		const original = (
			performance as unknown as Record<string, unknown>
		).getEntriesByType;
		performance.getEntriesByType = (() =>
			status === undefined
				? []
				: [{ responseStatus: status }]) as unknown as typeof performance.getEntriesByType;
		try {
			return run();
		} finally {
			if (original === undefined) {
				Reflect.deleteProperty(performance, "getEntriesByType");
			} else {
				(performance as unknown as Record<string, unknown>).getEntriesByType =
					original;
			}
		}
	}

	it("reports ready when the page matches the expected URL with no sign-in signals", () => {
		document.body.innerHTML = "<h1>Account summary</h1>";
		withLocation("https://example.test/account", () => {
			expect(detectPageNotReady("https://example.test/account")).toBeUndefined();
		});
	});

	it("tolerates a trailing-slash-only mismatch against the expected URL", () => {
		document.body.innerHTML = "<h1>Account summary</h1>";
		withLocation("https://example.test/account/", () => {
			expect(detectPageNotReady("https://example.test/account")).toBeUndefined();
		});
		withLocation("https://example.test/account", () => {
			expect(
				detectPageNotReady("https://example.test/account/"),
			).toBeUndefined();
		});
	});

	it("reports http-error with the response status from the navigation entry", () => {
		document.body.innerHTML = "<h1>Not found</h1>";
		withLocation("https://example.test/account", () => {
			withNavigationStatus(404, () => {
				expect(detectPageNotReady("https://example.test/account")).toEqual({
					code: "http-error",
					message: "The page responded with HTTP 404.",
					landedUrl: "https://example.test/account",
				});
			});
		});
	});

	it("reports login-page when a password field is present", () => {
		document.body.innerHTML = '<input type="password">';
		withLocation("https://example.test/login", () => {
			const notReady = detectPageNotReady("https://example.test/account");
			expect(notReady?.code).toBe("login-page");
			expect(notReady?.landedUrl).toBe("https://example.test/login");
		});
	});

	it("reports login-page when the form action targets a login endpoint", () => {
		document.body.innerHTML = '<form action="/auth/login"></form>';
		withLocation("https://example.test/auth/login", () => {
			expect(
				detectPageNotReady("https://example.test/account")?.code,
			).toBe("login-page");
		});
	});

	it("reports login-page from the document title or heading sign-in text", () => {
		document.title = "Sign in";
		try {
			withLocation("https://example.test/signin", () => {
				expect(
					detectPageNotReady("https://example.test/account")?.code,
				).toBe("login-page");
			});
		} finally {
			document.title = "";
		}
	});

	it("reports ready for the expected URL even when it contains a password field", () => {
		document.body.innerHTML =
			'<h1>Account settings</h1><input type="password" name="current-password">';
		withLocation("https://example.test/account", () => {
			expect(detectPageNotReady("https://example.test/account")).toBeUndefined();
		});
	});

	it("reports login-page for a 401 on the expected URL when the page looks like sign-in", () => {
		document.body.innerHTML = '<h1>Log in</h1><input type="password">';
		withLocation("https://example.test/account", () => {
			withNavigationStatus(401, () => {
				expect(detectPageNotReady("https://example.test/account")?.code).toBe(
					"login-page",
				);
			});
		});
	});

	it("reports redirected when the page lands on a different origin or path", () => {
		document.body.innerHTML = "<h1>Account summary</h1>";
		withLocation("https://example.test/other-page", () => {
			expect(
				detectPageNotReady("https://example.test/account")?.code,
			).toBe("redirected");
		});
	});
});

describe("pickerMachine", () => {
	it("wraps both directions, selects the focused key, and gates approval", async () => {
		const { pickerMachine } = await pickerContracts();
		const initial: PickerState = {
			keys: ["compact", "detailed", "visual"],
			currentIndex: 0,
			selectedKey: null,
			approved: false,
			showingOriginal: false,
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
			showingOriginal: false,
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
				showingOriginal: false,
			},
			{ type: "select" },
		);

		const cycled = pickerMachine(selected, { type: "next" });

		expect(cycled.currentIndex).toBe(1);
		expect(cycled.selectedKey).toBeNull();
		expect(cycled.approved).toBe(false);
	});

	it("toggles showing the original without disturbing selection, and any cycle clears it", async () => {
		const { pickerMachine } = await pickerContracts();
		const selected: PickerState = {
			keys: ["compact", "detailed", "visual"],
			currentIndex: 0,
			selectedKey: "compact",
			approved: false,
			showingOriginal: false,
		};

		const showingOriginal = pickerMachine(selected, {
			type: "toggle-original",
		});
		const showingVariation = pickerMachine(showingOriginal, {
			type: "toggle-original",
		});
		const blockedApprovalWhileShowing = pickerMachine(showingOriginal, {
			type: "approve",
		});
		const cycledAwayFromOriginal = pickerMachine(showingOriginal, {
			type: "next",
		});

		expect(showingOriginal).toEqual({ ...selected, showingOriginal: true });
		expect(showingVariation).toEqual(selected);
		expect(blockedApprovalWhileShowing.approved).toBe(true);
		expect(cycledAwayFromOriginal.showingOriginal).toBe(false);
	});

	it("uses explicit selection for approval and current focus for rejection", async () => {
		const { pickerVerdictKey } = await pickerContracts();
		const focusedWithoutSelection: PickerState = {
			keys: ["compact", "detailed", "visual"],
			currentIndex: 1,
			selectedKey: null,
			approved: false,
			showingOriginal: false,
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
			notes: "Make the primary action clearer.",
			ts: 1_721_234_567_890,
		});
		const reject = buildVerdict({
			slug: "account-summary",
			action: "reject",
			selectedKey: "detailed",
			notes: "Reduce the density.",
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

		const approveWithoutNotes = buildVerdict({
			slug: "account-summary",
			action: "approve",
			selectedKey: "compact",
			ts: 1_721_234_567_893,
		});
		const tweak = buildVerdict({
			slug: "account-summary",
			action: "tweak",
			selectedKey: "compact",
			notes: "Round the corners.",
			ts: 1_721_234_567_894,
		});
		expect(() =>
			buildVerdict({
				slug: "account-summary",
				action: "tweak",
				selectedKey: "compact",
				ts: 1_721_234_567_895,
			}),
		).toThrow(/notes/i);

		expect(validateVerdict(approve)).toEqual({
			slug: "account-summary",
			action: "approve",
			selectedKey: "compact",
			notes: "Make the primary action clearer.",
			ts: 1_721_234_567_890,
		});
		expect(approveWithoutNotes).not.toHaveProperty("notes");
		expect(tweak).toMatchObject({ action: "tweak", notes: "Round the corners." });
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
		const inlineStyle = parsed
			.querySelector("#dg-proto-adversarial-preview-inline")
			?.getAttribute("style");

		expect(
			parsed
				.querySelector("#dg-proto-adversarial-preview-encoded")
				?.hasAttribute("href"),
		).toBe(false);
		expect(
			parsed
				.querySelector("#dg-proto-adversarial-preview-benign-link")
				?.getAttribute("href"),
		).toBe("#details");
		expect(inlineStyle).toMatch(/position\s*:\s*static/i);
		expect(inlineStyle).toMatch(/z-index\s*:\s*0/i);
		expect(inlineStyle).toMatch(/color\s*:\s*green/i);
		expect(sanitized.css).not.toMatch(/position\s*:\s*(?:fixed|absolute|var)/i);
		expect(sanitized.css).not.toMatch(/z-index\s*:\s*(?:1001|999999)/i);
		expect(sanitized.css).toMatch(/position\s*:\s*relative/i);
		expect(sanitized.css).toMatch(/z-index\s*:\s*1000/i);
		expect(sanitized.css).toMatch(/color\s*:\s*rebeccapurple/i);
	});

	it("keeps native form controls and their Bootstrap-shaped attributes so they render visibly", async () => {
		const { sanitizePrototypeVariation } = await pickerContracts();
		const source: ProtoVariation = {
			key: "form-controls",
			label: "Form controls",
			html: [
				'<form action="/submit" method="post">',
				'<div class="form-check">',
				'<input type="radio" class="form-check-input" name="plan" value="a" checked required>',
				"</div>",
				'<input type="file" class="form-control" accept="image/png" multiple pattern="[a-z]+" autocomplete="off">',
				'<select class="form-select" required size="3">',
				'<optgroup label="Group"><option value="1">One</option></optgroup>',
				"</select>",
				'<textarea class="form-control" required minlength="4" wrap="soft" autocomplete="off"></textarea>',
				'<progress value="30" max="100"></progress>',
				"</form>",
			].join(""),
			css: "",
		};

		const sanitized = sanitizePrototypeVariation(source);
		const parsed = new window.DOMParser().parseFromString(
			sanitized.html,
			"text/html",
		);

		expect(parsed.querySelector("form")?.hasAttribute("action")).toBe(false);
		expect(parsed.querySelector("form")?.hasAttribute("method")).toBe(false);
		const radio = parsed.querySelector('input[type="radio"]');
		expect(radio?.getAttribute("class")).toBe("form-check-input");
		expect(radio?.hasAttribute("checked")).toBe(true);
		expect(radio?.hasAttribute("required")).toBe(true);
		const file = parsed.querySelector('input[type="file"]');
		expect(file?.getAttribute("accept")).toBe("image/png");
		expect(file?.hasAttribute("multiple")).toBe(true);
		expect(file?.getAttribute("pattern")).toBe("[a-z]+");
		expect(file?.getAttribute("autocomplete")).toBe("off");
		const select = parsed.querySelector("select");
		expect(select?.hasAttribute("required")).toBe(true);
		expect(select?.getAttribute("size")).toBe("3");
		expect(parsed.querySelector("optgroup")?.getAttribute("label")).toBe(
			"Group",
		);
		const textarea = parsed.querySelector("textarea");
		expect(textarea?.hasAttribute("required")).toBe(true);
		expect(textarea?.getAttribute("minlength")).toBe("4");
		expect(textarea?.getAttribute("wrap")).toBe("soft");
		expect(textarea?.getAttribute("autocomplete")).toBe("off");
		const progress = parsed.querySelector("progress");
		expect(progress?.getAttribute("value")).toBe("30");
		expect(progress?.getAttribute("max")).toBe("100");
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

	it("keeps a brace-escape payload from restyling the host page", async () => {
		const { sanitizePrototypeVariation } = await pickerContracts();
		const sanitized = sanitizePrototypeVariation({
			key: "escape",
			label: "Escape",
			html: '<p class="x">Variation</p>',
			css: "} body > * { display: none !important } .x { color: teal }",
		});
		document.body.innerHTML =
			'<p id="host-copy">Host</p><div data-dg-prototype="escape"><p class="x">Variation</p></div>';
		const style = document.createElement("style");
		style.textContent = sanitized.css;
		document.head.append(style);
		try {
			expect(getComputedStyle(document.body).display).not.toBe("none");
			expect(
				getComputedStyle(document.getElementById("host-copy") as Element).display,
			).not.toBe("none");
			expect(sanitized.css).not.toMatch(/^\s*body\s*>\s*\*/);
			expect(sanitized.css === "" || sanitized.css.includes("@scope ([data-dg-prototype])")).toBe(
				true,
			);
			if (sanitized.css) {
				expect(sanitized.css).toMatch(/\.x\s*\{[^}]*color:\s*teal/i);
			}
		} finally {
			style.remove();
		}
	});

	it("prefixes variation ids and rewrites for, aria, and fragment references", async () => {
		const { sanitizePrototypeVariation } = await pickerContracts();
		const sanitized = sanitizePrototypeVariation({
			key: "ids",
			label: "Ids",
			html: [
				'<label for="title">Title</label>',
				'<h2 id="title">Variation title</h2>',
				'<a href="#title" aria-describedby="title extra">Jump</a>',
			].join(""),
			css: "",
		});
		const parsed = new window.DOMParser().parseFromString(
			sanitized.html,
			"text/html",
		);
		expect(parsed.getElementById("title")).toBeNull();
		expect(parsed.getElementById("dg-proto-ids-title")).not.toBeNull();
		expect(parsed.querySelector("label")?.getAttribute("for")).toBe(
			"dg-proto-ids-title",
		);
		expect(parsed.querySelector("a")?.getAttribute("href")).toBe(
			"#dg-proto-ids-title",
		);
		expect(parsed.querySelector("a")?.getAttribute("aria-describedby")).toBe(
			"dg-proto-ids-title extra",
		);
	});

	it("namespaces variation radio names away from the host form", async () => {
		const { sanitizePrototypeVariation } = await pickerContracts();
		const sanitized = sanitizePrototypeVariation({
			key: "choice",
			label: "Choice",
			html: '<input type="radio" name="plan" value="alt" checked>',
			css: "",
		});
		const parsed = new window.DOMParser().parseFromString(
			sanitized.html,
			"text/html",
		);
		expect(parsed.querySelector("input")?.getAttribute("name")).toBe(
			"dg-proto-choice-plan",
		);
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

	const shadowRoots = await captureShadowRoots(async () => {
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

	const host = document.querySelector('[id^="dg-proto-host-"]') as HTMLElement;
	const canvas = host.querySelector('[data-dg-prototype="first"]');
	expect(host.shadowRoot).toBeNull();
	expect(canvas).not.toBeNull();
	expect(document.contains(canvas)).toBe(true);
	expect(shadowRoots).toHaveLength(1);

	window.dispatchEvent(new window.Event("pagehide"));

	expect([...document.body.childNodes]).toEqual(original);
});

it("lets the picker toggle between the original element and the planted variation", async () => {
	const { plantPrototype } = await pickerContracts();
	document.body.innerHTML = `
		<section id="mount" style="display:flex">Original</section>
	`;
	const target = document.getElementById("mount") as HTMLElement;

	const shadowRoots = await captureShadowRoots(async () => {
		await plantPrototype({
			slug: "toggle-original",
			mountSelector: "#mount",
			mode: "replace",
			variations: [
				{ key: "first", label: "First", html: "<p>Preview</p>", css: "" },
			],
		});
	});

	const host = document.querySelector('[id^="dg-proto-host-"]') as HTMLElement;
	const controlsRoot = shadowRoots[0];
	if (!controlsRoot) throw new Error("controls shadow root was not created");
	const toggle = [...controlsRoot.querySelectorAll("button")].find(
		(element) => element.textContent === "Show original",
	) as HappyHTMLElement | undefined;
	if (!toggle) throw new Error("toggle-original button was not rendered");

	expect(target.style.display).toBe("none");
	expect(host.style.display).toBe("flex");

	toggle.click();
	expect(target.style.display).toBe("flex");
	expect(host.style.display).toBe("none");
	expect(toggle.textContent).toBe("Show variation");

	toggle.click();
	expect(target.style.display).toBe("none");
	expect(host.style.display).toBe("flex");
	expect(toggle.textContent).toBe("Show original");

	window.dispatchEvent(new window.Event("pagehide"));
});

it("namespaces a variation radio so it does not clear the original selection", async () => {
	const { plantPrototype } = await pickerContracts();
	document.body.innerHTML = `
		<form>
			<input type="radio" name="plan" value="original" checked id="original-radio">
			<section id="mount">Original</section>
		</form>
	`;
	const original = document.getElementById("original-radio") as HTMLInputElement;

	await plantPrototype({
		slug: "radio-collision",
		mountSelector: "#mount",
		mode: "replace",
		variations: [
			{
				key: "first",
				label: "First",
				html: '<input type="radio" name="plan" value="alt" checked>',
				css: "",
			},
		],
	});

	const planted = document.querySelector(
		'[data-dg-prototype="first"] input[type="radio"]',
	) as HTMLInputElement | null;
	expect(planted).not.toBeNull();
	expect(planted?.getAttribute("name")).toBe("dg-proto-first-plan");
	expect(planted?.checked).toBe(true);
	expect(original.checked).toBe(true);
	expect(original.getAttribute("name")).toBe("plan");

	window.dispatchEvent(new window.Event("pagehide"));
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

it("keeps the picker's own focusin from reaching a host-page modal's focus trap", async () => {
	const { plantPrototype } = await pickerContracts();
	document.body.innerHTML = `
		<div id="host-modal"><button id="modal-target">Modal button</button></div>
		<section id="mount">Original</section>
	`;
	const modal = document.getElementById("host-modal") as HTMLElement;
	const modalTarget = document.getElementById("modal-target") as HTMLElement;
	let trapCalls = 0;
	document.addEventListener("focusin", (event) => {
		if (!modal.contains(event.target as Node)) {
			trapCalls += 1;
			modalTarget.focus();
		}
	});

	const shadowRoots = await captureShadowRoots(async () => {
		await plantPrototype({
			slug: "focus-trap",
			mountSelector: "#mount",
			mode: "replace",
			variations: [
				{ key: "first", label: "First", html: "<p>Preview</p>", css: "" },
			],
		});
	});

	const notes = shadowRoots
		.map((root) => root.querySelector(".dg-proto-notes"))
		.find((element) => element !== null) as HappyHTMLElement | undefined;
	expect(notes).toBeTruthy();

	notes?.focus();
	notes?.dispatchEvent(
		new window.Event("focusin", { bubbles: true, composed: true }),
	);

	expect(trapCalls).toBe(0);
});
