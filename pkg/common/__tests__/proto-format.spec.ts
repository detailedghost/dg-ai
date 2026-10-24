import { describe, expect, it } from "bun:test";
import {
	assembleAnswerPage,
	canonicalizeStyleGuide,
	PROTO_MAX_MARKUP_CHARS,
	PROTO_MAX_VARIATIONS,
	PROTO_MAX_TIMEOUT_MS,
	sanitizeVariationHtml,
	STYLE_GUIDE_MAX_CONTROLS,
	PROTO_MARKED_URL_MAX_LENGTH,
	PROTO_PREVIEW_MAX_CHARS,
	validateProtoBrowserData,
	validateProtoCliRequest,
	validateProtoIdentifier,
	validateProtoNotReadyError,
	validateProtoPlan,
	validateProtoRenderLimits,
	validateStyleGuide,
	validateVerdict,
} from "../src/index";

describe("validateProtoIdentifier", () => {
	it("returns valid identifiers and rejects traversal-capable values", () => {
		const identifier = `a${"b".repeat(127)}`;
		expect(validateProtoIdentifier(identifier)).toBe(identifier);

		for (const invalid of [
			"",
			"../escape",
			".hidden",
			"nested/path",
			"contains space",
			`a${"b".repeat(128)}`,
		]) {
			expect(() => validateProtoIdentifier(invalid)).toThrow();
		}
	});
});

function buildProtoPlan(overrides: Record<string, unknown> = {}) {
	return {
		slug: "account-summary",
		mode: "replace",
		variations: [
			{
				key: "compact",
				label: "Compact",
				html: "<section><h1>Account summary</h1></section>",
				css: "h1 { font-size: 2rem; }",
			},
			{
				key: "detailed",
				label: "Detailed",
				html: "<section><h1>Account details</h1></section>",
				css: "h1 { font-size: 2.25rem; }",
			},
		],
		...overrides,
	};
}

function buildStyleGuide(overrides: Record<string, unknown> = {}) {
	return {
		meta: {
			url: "https://example.test/account",
			scrapedAt: 1_721_234_567_890,
			sameOrigin: true,
		},
		tokens: {
			customProps: { "--brand": "#123456" },
			colors: ["#123456", "#ffffff"],
			fontStack: "Inter, sans-serif",
			typeScale: ["1rem", "1.5rem"],
			spacing: ["0.5rem", "1rem"],
			radii: ["0.25rem"],
			shadows: ["0 1px 2px rgb(0 0 0 / 0.1)"],
		},
		components: {
			button: { background: "#123456" },
			input: { border: "1px solid #123456" },
			link: { color: "#123456" },
		},
		...overrides,
	};
}

describe("validateProtoPlan", () => {
	it("accepts structural HTML content without applying sanitizer policy", () => {
		const plan = buildProtoPlan({
			variations: [
				{
					key: "escaped-example",
					label: "Escaped example",
					html: "<pre>&lt;script&gt;alert('example')&lt;/script&gt;</pre>",
					css: "pre { white-space: pre-wrap; }",
				},
			],
		});

		expect(Object.is(validateProtoPlan(plan), plan)).toBe(true);
	});

	it("rejects missing, empty, and duplicate variation keys", () => {
		const missingKey = buildProtoPlan({
			variations: [{ label: "Missing key", html: "<p>One</p>", css: "" }],
		});
		const emptyKey = buildProtoPlan({
			variations: [
				{ key: "", label: "Empty key", html: "<p>Two</p>", css: "" },
			],
		});
		const duplicateKeys = buildProtoPlan({
			variations: [
				{ key: "same", label: "First", html: "<p>Three</p>", css: "" },
				{ key: "same", label: "Second", html: "<p>Four</p>", css: "" },
			],
		});

		expect(() => validateProtoPlan(missingKey)).toThrow();
		expect(() => validateProtoPlan(emptyKey)).toThrow();
		expect(() => validateProtoPlan(duplicateKeys)).toThrow();
	});

	it("rejects an unsupported mode, missing variations, and an empty mount selector", () => {
		expect(() =>
			validateProtoPlan(buildProtoPlan({ mode: "overlay" })),
		).toThrow();
		expect(() =>
			validateProtoPlan(buildProtoPlan({ variations: undefined })),
		).toThrow();
		expect(() =>
			validateProtoPlan(buildProtoPlan({ mountSelector: "" })),
		).toThrow();
	});

	it("enforces the shared file-safe grammar for slugs and variation keys", () => {
		for (const slug of [
			"../escape",
			".hidden",
			"nested/path",
			"contains space",
			`a${"b".repeat(128)}`,
		]) {
			expect(() => validateProtoPlan(buildProtoPlan({ slug }))).toThrow();
		}

		expect(() =>
			validateProtoPlan(
				buildProtoPlan({
					slug: `a${"b".repeat(127)}`,
					variations: [
						{
							key: "valid_key-1",
							label: "Valid",
							html: "<p>Valid identifiers</p>",
							css: "",
						},
					],
				}),
			),
		).not.toThrow();
		expect(() =>
			validateProtoPlan(
				buildProtoPlan({
					variations: [
						{
							key: "../escape",
							label: "Traversal",
							html: "<p>Unsafe key</p>",
							css: "",
						},
					],
				}),
			),
		).toThrow();
	});
});

describe("validateProtoRenderLimits", () => {
	it("keeps structural validation separate from render/transport limits", () => {
		const tooMany = buildProtoPlan({
			variations: Array.from(
				{ length: PROTO_MAX_VARIATIONS + 1 },
				(_, index) => ({
					key: `variation-${index}`,
					label: `Variation ${index}`,
					html: "<p>Preview</p>",
					css: "",
				}),
			),
		});
		const tooMuchMarkup = buildProtoPlan({
			variations: [
				{
					key: "large",
					label: "Large",
					html: "x".repeat(PROTO_MAX_MARKUP_CHARS + 1),
					css: "",
				},
			],
		});

		expect(Object.is(validateProtoPlan(tooMany), tooMany)).toBe(true);
		expect(Object.is(validateProtoPlan(tooMuchMarkup), tooMuchMarkup)).toBe(
			true,
		);
		expect(() => validateProtoRenderLimits(validateProtoPlan(tooMany))).toThrow(
			/at most 5 variations/i,
		);
		expect(() =>
			validateProtoRenderLimits(validateProtoPlan(tooMuchMarkup)),
		).toThrow(/HTML\+CSS|524288/i);
	});
});

describe("validateVerdict", () => {
	it("accepts complete approve and reject verdicts", () => {
		const approve = {
			slug: "account-summary",
			action: "approve",
			selectedKey: "compact",
			ts: 1_721_234_567_890,
		};
		const reject = {
			slug: "account-summary",
			action: "reject",
			selectedKey: "detailed",
			feedback: "Keep the hierarchy but reduce the density.",
			ts: 1_721_234_567_890,
		};

		expect(Object.is(validateVerdict(approve), approve)).toBe(true);
		expect(Object.is(validateVerdict(reject), reject)).toBe(true);
	});

	it("accepts approve notes and tweak verdicts and enforces their notes rules", () => {
		const base = { slug: "account-summary", selectedKey: "compact", ts: 1 };
		const approveWithNotes = {
			...base,
			action: "approve" as const,
			notes: "Organize the buttons.",
		};
		const tweak = { ...base, action: "tweak" as const, notes: "Round the corners." };

		expect(validateVerdict(approveWithNotes)).toEqual(approveWithNotes);
		expect(validateVerdict(tweak)).toEqual(tweak);
		expect(() =>
			validateVerdict({ ...base, action: "approve", notes: "   " }),
		).toThrow();
		expect(() => validateVerdict({ ...base, action: "tweak" })).toThrow();
		expect(() =>
			validateVerdict({ ...base, action: "tweak", notes: "  " }),
		).toThrow();
		expect(() =>
			validateVerdict({ ...tweak, feedback: "Not allowed on a tweak." }),
		).toThrow();
		expect(() =>
			validateVerdict({
				...base,
				action: "reject",
				feedback: "Too dense.",
				notes: "Not allowed on a reject.",
			}),
		).toThrow();
	});

	it("rejects an empty selection and action-specific feedback violations", () => {
		expect(() =>
			validateVerdict({
				slug: "account-summary",
				action: "approve",
				selectedKey: "",
				ts: 1_721_234_567_890,
			}),
		).toThrow();
		expect(() =>
			validateVerdict({
				slug: "account-summary",
				action: "approve",
				selectedKey: "compact",
				feedback: "This field is forbidden for approval.",
				ts: 1_721_234_567_890,
			}),
		).toThrow();
		expect(() =>
			validateVerdict({
				slug: "account-summary",
				action: "reject",
				selectedKey: "detailed",
				ts: 1_721_234_567_890,
			}),
		).toThrow();
		expect(() =>
			validateVerdict({
				slug: "account-summary",
				action: "reject",
				selectedKey: "detailed",
				feedback: "   ",
				ts: 1_721_234_567_890,
			}),
		).toThrow();
		expect(() =>
			validateVerdict({
				slug: "account-summary",
				action: "revise",
				selectedKey: "detailed",
				ts: 1_721_234_567_890,
			}),
		).toThrow();
		expect(() =>
			validateVerdict({
				slug: "../account-summary",
				action: "approve",
				selectedKey: "compact",
				ts: 1_721_234_567_890,
			}),
		).toThrow();
		expect(() =>
			validateVerdict({
				slug: "account-summary",
				action: "approve",
				selectedKey: "../../outside",
				ts: 1_721_234_567_890,
			}),
		).toThrow();
		expect(() =>
			validateVerdict({
				slug: "account-summary",
				action: "approve",
				selectedKey: `a${"b".repeat(128)}`,
				ts: 1_721_234_567_890,
			}),
		).toThrow();
	});
});

describe("validateStyleGuide", () => {
	it("accepts a populated guide and rejects a guide without any colors", () => {
		const guide = buildStyleGuide();
		expect(validateStyleGuide(guide)).toBe(guide);
		expect(() =>
			validateStyleGuide(
				buildStyleGuide({
					tokens: {
						...buildStyleGuide().tokens,
						colors: [],
					},
				}),
			),
		).toThrow();
	});

	it("accepts token categories that are explicitly allowed to be empty", () => {
		const guide = buildStyleGuide({
			tokens: {
				...buildStyleGuide().tokens,
				typeScale: [],
				spacing: [],
				radii: [],
				shadows: [],
			},
		});

		expect(() => validateStyleGuide(guide)).not.toThrow();
	});

	it("accepts an older guide with no colorScheme, select, textarea, or controls", () => {
		expect(() => validateStyleGuide(buildStyleGuide())).not.toThrow();
	});

	it("accepts select/textarea components, a colorScheme, and bounded controls", () => {
		const guide = buildStyleGuide({
			meta: {
				url: "https://example.test/account",
				scrapedAt: 1,
				sameOrigin: true,
				colorScheme: "dark",
			},
			components: {
				button: {},
				input: {},
				link: {},
				select: { border: "1px solid #123456" },
				textarea: { border: "1px solid #123456" },
			},
			controls: [
				{ tag: "input", type: "radio", classes: "form-check-input" },
				{
					tag: "select",
					classes: "form-select",
					wrapperClasses: "form-group",
				},
			],
		});

		expect(validateStyleGuide(guide)).toBe(guide);
	});

	it("rejects an invalid colorScheme and a control with an unknown tag", () => {
		expect(() =>
			validateStyleGuide(
				buildStyleGuide({
					meta: {
						url: "https://example.test/account",
						scrapedAt: 1,
						sameOrigin: true,
						colorScheme: "sepia",
					},
				}),
			),
		).toThrow();
		expect(() =>
			validateStyleGuide(
				buildStyleGuide({
					controls: [{ tag: "div", classes: "card" }],
				}),
			),
		).toThrow();
	});

	it(`rejects more than ${STYLE_GUIDE_MAX_CONTROLS} controls`, () => {
		const controls = Array.from({ length: STYLE_GUIDE_MAX_CONTROLS + 1 }, () => ({
			tag: "input" as const,
			classes: "form-control",
		}));
		expect(() =>
			validateStyleGuide(buildStyleGuide({ controls })),
		).toThrow();
	});
});

describe("validateProtoNotReadyError", () => {
	it("accepts a well-formed not-ready error for every ratified code", () => {
		for (const code of [
			"login-page",
			"redirected",
			"http-error",
			"mount-missing",
		] as const) {
			const error = {
				code,
				message: "the page was not ready",
				landedUrl: "https://example.test/login",
			};
			expect(validateProtoNotReadyError(error)).toBe(error);
		}
	});

	it("rejects an unknown code and a missing landedUrl", () => {
		expect(() =>
			validateProtoNotReadyError({
				code: "maintenance-page",
				message: "down for maintenance",
				landedUrl: "https://example.test",
			}),
		).toThrow();
		expect(() =>
			validateProtoNotReadyError({
				code: "login-page",
				message: "the page was not ready",
			}),
		).toThrow();
	});
});

describe("validateProtoBrowserData", () => {
	it("accepts a style-guide payload and a verdict payload with an optional PNG preview", () => {
		const styleGuide = buildStyleGuide();
		expect(
			validateProtoBrowserData({ kind: "style-guide", styleGuide }),
		).toEqual({ kind: "style-guide", styleGuide });

		const verdict = {
			slug: "account-summary-1a2b3c4d",
			action: "approve" as const,
			selectedKey: "compact",
			ts: 1,
		};
		expect(
			validateProtoBrowserData({
				kind: "verdict",
				verdict,
				previewDataUrl: "data:image/png;base64,cHJldmlldw==",
			}),
		).toEqual({
			kind: "verdict",
			verdict,
			previewDataUrl: "data:image/png;base64,cHJldmlldw==",
		});
	});

	it("accepts a JPEG preview and rejects a non-image or oversized preview", () => {
		const verdict = {
			slug: "account-summary-1a2b3c4d",
			action: "approve" as const,
			selectedKey: "compact",
			ts: 1,
		};
		expect(
			validateProtoBrowserData({
				kind: "verdict",
				verdict,
				previewDataUrl: "data:image/jpeg;base64,cHJldmlldw==",
			}),
		).toMatchObject({
			previewDataUrl: "data:image/jpeg;base64,cHJldmlldw==",
		});
		expect(() =>
			validateProtoBrowserData({ kind: "answer", value: "nope" }),
		).toThrow();
		expect(() =>
			validateProtoBrowserData({
				kind: "verdict",
				verdict,
				previewDataUrl: "data:text/plain,not-a-png",
			}),
		).toThrow(/PNG or JPEG/);
		expect(() =>
			validateProtoBrowserData({
				kind: "verdict",
				verdict,
				previewDataUrl: `data:image/jpeg;base64,${"A".repeat(PROTO_PREVIEW_MAX_CHARS)}`,
			}),
		).toThrow(/exceeds/);
	});
});

describe("validateProtoCliRequest", () => {
	function buildProtoCliRequest(overrides: Record<string, unknown> = {}) {
		return {
			type: "cli-proto-request" as const,
			requestId: "proto-request-1",
			phase: "scrape" as const,
			slug: "account-summary-1a2b3c4d",
			markedUrl: "https://example.test/account#_proto=fixture",
			...overrides,
		};
	}

	it("accepts a well-formed scrape or plant request", () => {
		expect(validateProtoCliRequest(buildProtoCliRequest())).toEqual(
			buildProtoCliRequest(),
		);
		expect(
			validateProtoCliRequest(
				buildProtoCliRequest({ phase: "plant", timeoutMs: 900_000 }),
			),
		).toEqual(buildProtoCliRequest({ phase: "plant", timeoutMs: 900_000 }));
	});

	it("requires an http(s) marked URL under the marker length cap", () => {
		expect(
			validateProtoCliRequest(
				buildProtoCliRequest({ markedUrl: "http://example.test/account" }),
			).markedUrl,
		).toBe("http://example.test/account");
		expect(() =>
			validateProtoCliRequest(
				buildProtoCliRequest({ markedUrl: "javascript:alert(1)" }),
			),
		).toThrow(/http\(s\)/);
		expect(() =>
			validateProtoCliRequest(
				buildProtoCliRequest({
					markedUrl: `https://example.test/${"a".repeat(PROTO_MARKED_URL_MAX_LENGTH)}`,
				}),
			),
		).toThrow(/marker URL limit/);
	});

	it("rejects an unknown phase, an out-of-range timeout, and an unknown field", () => {
		expect(() =>
			validateProtoCliRequest(buildProtoCliRequest({ phase: "render" })),
		).toThrow();
		expect(() =>
			validateProtoCliRequest(
				buildProtoCliRequest({ timeoutMs: PROTO_MAX_TIMEOUT_MS + 1 }),
			),
		).toThrow();
		expect(() =>
			validateProtoCliRequest(buildProtoCliRequest({ extra: "nope" })),
		).toThrow();
	});
});

describe("canonicalizeStyleGuide", () => {
	it("emits the same serialization for equivalent record insertion orders", () => {
		const first = buildStyleGuide({
			tokens: {
				...buildStyleGuide().tokens,
				customProps: { "--z-index": "1", "--accent": "#123456" },
			},
		});
		const second = buildStyleGuide({
			tokens: {
				...buildStyleGuide().tokens,
				customProps: { "--accent": "#123456", "--z-index": "1" },
			},
		});

		expect(canonicalizeStyleGuide(first)).toBe(canonicalizeStyleGuide(second));
	});

	it("preserves hostile own record keys without prototype mutation", () => {
		const customProps = Object.create(null) as Record<string, string>;
		customProps["--brand"] = "#123456";
		customProps.__proto__ = "preserved-own-value";
		const canonical = JSON.parse(
			canonicalizeStyleGuide(
				buildStyleGuide({
					tokens: { ...buildStyleGuide().tokens, customProps },
				}),
			),
		);

		expect(Object.hasOwn(canonical.tokens.customProps, "__proto__")).toBe(true);
		expect(canonical.tokens.customProps.__proto__).toBe("preserved-own-value");
	});
});

describe("sanitizeVariationHtml", () => {
	const unsafeHtml = [
		'<section totallyunknownattribute="drop" onclick="alert(1)">',
		'<p style="color:red">Hello</p>',
		"<script>alert('script')</script>",
		'<a href="javascript:alert(2)">JavaScript URL</a>',
		'<a href="data:text/html,%3Cscript%3Ealert(3)%3C/script%3E">Data URL</a>',
		'<img src="data:image/png;base64,iVBORw0KGgo=" alt="pixel">',
		'<img src="data:image/svg+xml,%3Csvg%3E%3C/svg%3E" alt="vector">',
		'<dg-unknown mystery="drop">Unknown wrapper</dg-unknown>',
		"</section>",
	].join("");

	it("removes executable and unknown markup while retaining allowed content", () => {
		const sanitized = sanitizeVariationHtml(unsafeHtml);

		expect(sanitized).not.toContain("onclick");
		expect(sanitized).not.toContain("<script");
		expect(sanitized).not.toContain("javascript:");
		expect(sanitized).not.toContain("data:text/html");
		expect(sanitized).not.toContain("data:image/svg+xml");
		expect(sanitized).not.toContain("totallyunknownattribute");
		expect(sanitized).not.toContain("<dg-unknown");
		expect(sanitized).not.toContain("mystery=");
		expect(sanitized).toContain("<p");
		expect(sanitized).toContain("Hello");
		expect(sanitized).toContain("style=");
		expect(sanitized).toContain("color:red");
		expect(sanitized).toContain("data:image/png;base64,iVBORw0KGgo=");
	});

	it("is idempotent", () => {
		const once = sanitizeVariationHtml(unsafeHtml);

		expect(sanitizeVariationHtml(once)).toBe(once);
	});

	it("drops blocked elements, attributes, and entity-obfuscated URL schemes", () => {
		const sanitized = sanitizeVariationHtml(
			[
				'<base href="https://attacker.test/">',
				'<meta http-equiv="refresh" content="0;url=https://attacker.test/">',
				'<button formaction="https://attacker.test/">Save</button>',
				'<a href="jav&#x61;script:alert(1)">Unsafe link</a>',
				'<iframe srcdoc="<script>alert(2)</script>">frame</iframe>',
				'<svg><a xlink:href="javascript:alert(3)">vector</a></svg>',
			].join(""),
		);

		expect(sanitized).not.toMatch(/<(?:base|embed|iframe|meta|object|svg)\b/i);
		expect(sanitized).not.toMatch(
			/(?:formaction|http-equiv|srcdoc|xlink:href)/i,
		);
		expect(sanitized).not.toContain("javascript:");
		expect(sanitized).toContain("<button>Save</button>");
	});

	it("preserves benign comparison text without reinterpreting invalid tags", () => {
		expect(sanitizeVariationHtml("<p>1 < 2 and 3 > 0</p>")).toBe(
			"<p>1 &lt; 2 and 3 > 0</p>",
		);
		expect(sanitizeVariationHtml("a < b > c")).toBe("a &lt; b > c");
	});
});

describe("assembleAnswerPage", () => {
	it("neutralizes CSS breakouts and escapes metadata", () => {
		const page = assembleAnswerPage(
			{
				key: "breakout",
				label: "Breakout",
				html: '<main onclick="alert(3)">Safe body</main>',
				css: [
					'.preview::after { content: "</style><img src=x onerror=alert(1)>"; }',
					'.comment::after { content: "<!-- -->"; }',
				].join("\n"),
			},
			{
				url: 'https://example.test/<img src=x onerror="url-field">',
				scrapedAt: 1_721_234_567_890,
				question: '<script data-origin="question-field">alert(2)</script>',
			},
		);

		expect(page.match(/<\/style/gi)).toHaveLength(1);
		expect(page).not.toContain("<img src=x onerror=alert(1)>");
		expect(page).not.toContain('<img src=x onerror="url-field">');
		expect(page).not.toContain('<script data-origin="question-field">');
		expect(page).not.toContain("onclick");
		expect(page).not.toContain("<!--");
		expect(page).not.toContain("-->");
		expect(page).toContain("&lt;img");
		expect(page).toContain("&lt;script");
	});

	it("emits one self-contained document with inline variation content", () => {
		const css = ".prototype { color: rebeccapurple; }";
		const page = assembleAnswerPage(
			{
				key: "self-contained",
				label: "Self-contained",
				html: [
					'<main id="prototype">Rendered prototype</main>',
					'<script src="https://cdn.example.test/app.js"></script>',
					'<link rel="stylesheet" href="https://cdn.example.test/app.css">',
				].join(""),
				css,
			},
			{
				scrapedAt: 1_721_234_567_890,
				question: "Which variation should ship?",
			},
		);

		expect(page).toMatch(/<!doctype html>/i);
		expect(page).toContain("<style");
		expect(page).toContain(css);
		expect(page).toContain("<body");
		expect(page).toContain('id="prototype"');
		expect(page).toContain("Rendered prototype");
		expect(page).not.toMatch(/<script\b[^>]*\bsrc\s*=/i);
		expect(page).not.toMatch(/<link\b[^>]*\bhref\s*=/i);
	});

	it("blocks every external HTML and CSS load while retaining local content", () => {
		const page = assembleAnswerPage(
			{
				key: "network-free",
				label: "Network free",
				html: [
					'<img src="https://image.attacker.test/a.png" alt="external">',
					'<img src="//scheme.attacker.test/a.png" alt="scheme relative">',
					'<img src="./relative.png" alt="relative">',
					'<img src="data:image/png;base64,iVBORw0KGgo=" alt="inline">',
					'<a href="https://link.attacker.test/">External</a>',
					'<a href="#local">Local</a>',
					String.raw`<div style="color:green;background:u\72l(https://inline.attacker.test/x.png)">Safe text</div>`,
				].join(""),
				css: String.raw`
					@import url("https://import.attacker.test/x.css");
					.remote { background: url(https://css.attacker.test/x.png); }
					.escaped { background: u\72l(https://escaped.attacker.test/x.png); }
					.set { background: image-s\65t(url(https://set.attacker.test/x.png) 1x); }
					.safe { color: green; }
				`,
			},
			{ scrapedAt: 1_721_234_567_890 },
		);

		expect(page).toContain("Safe text");
		expect(page).toContain("color:green");
		expect(page).toContain("color: green");
		expect(page).toContain("data:image/png;base64,iVBORw0KGgo=");
		expect(page).toContain('href="#local"');
		expect(page).not.toMatch(/attacker\.test/);
		expect(page).not.toMatch(/@import/i);
		expect(page).not.toMatch(/\burl\s*\(/i);
		expect(page).not.toMatch(/\bimage-set\s*\(/i);

		const cspIndex = page.indexOf('http-equiv="Content-Security-Policy"');
		expect(cspIndex).toBeGreaterThan(0);
		expect(cspIndex).toBeLessThan(page.indexOf("<style"));
		expect(page).toContain("default-src 'none'");
		expect(page).toContain("style-src 'unsafe-inline'");
		expect(page).toContain("img-src data:");
	});

	it("removes escaped CSS import rules", () => {
		const page = assembleAnswerPage(
			{
				key: "escaped-import",
				label: "Escaped import",
				html: "<main>Safe</main>",
				css: String.raw`@\69mport "https://import.attacker.test/x.css"; .safe { color: green; }`,
			},
			{ scrapedAt: 1_721_234_567_890 },
		);

		expect(page).not.toContain("import.attacker.test");
		expect(page).not.toMatch(/@import/i);
		expect(page).toContain(".safe { color: green; }");
	});

	it("preserves quoted CSS text while removing load-bearing functions", () => {
		const css = String.raw`
			.label::after { content: "literal url(example) and say \"hi\""; }
			.remote { background: u\72l(https://attacker.test/x.png); }
		`;
		const page = assembleAnswerPage(
			{
				key: "quoted-content",
				label: "Quoted content",
				html: "<main>Safe</main>",
				css,
			},
			{ scrapedAt: 1_721_234_567_890 },
		);

		expect(page).toContain(
			String.raw`content: "literal url(example) and say \"hi\""`,
		);
		expect(page).not.toContain("attacker.test");
		expect(page).toContain(".remote { background: none; }");
	});

	it("terminates safely for trailing escapes in stylesheet and inline CSS", () => {
		const page = assembleAnswerPage(
			{
				key: "trailing-escape",
				label: "Trailing escape",
				html: '<div style="content:\\">Safe</div>',
				css: "\\",
			},
			{ scrapedAt: 1_721_234_567_890 },
		);

		expect(page).toContain("<style>\uFFFD</style>");
		expect(page).toContain('style="content:\uFFFD"');
		expect(page).toContain(">Safe</div>");
	});
});
