import { describe, expect, it } from "bun:test";
import type { TourScript } from "@dg/common";
import {
	formatAction,
	envReference,
	MissingEnvError,
	resolveFill,
	parseAction,
	toPlanMarkdown,
	validate,
} from "@dg/common";
import { parsePlanMarkdown } from "../src/utils/plan-parse";

// Reserved `.example` host (RFC 6761) so the fixture can never hit a live site.
const script: TourScript = {
	title: "How to use Google",
	startUrl: "https://app.example",
	mode: "video",
	steps: [
		{ title: "Welcome", body: "Intro.", advance: 4000 },
		{
			selector: 'textarea[name="q"]',
			title: "Search box",
			body: "Type here.",
			action: { do: "fill", value: "cute puppies" },
			advance: 4500,
		},
		{
			selector: "a#more",
			title: "Nav",
			body: "Go on.",
			navigate: "https://app.example/search",
			action: { do: "click" },
			advance: "click",
		},
		{ title: "Prose code", body: "Press `Enter` to run.", advance: 3000 },
	],
};

describe("parsePlanMarkdown()", () => {
	it("round-trips setup inclusion and every setup step field", () => {
		const withSetup: TourScript = {
			...script,
			setup: {
				includeInTour: true,
				steps: [
					{
						title: "Prepare",
						selector: "#seed",
						body: "Seed a record.",
						navigate: "https://app.example/setup",
						action: { do: "click" },
						advance: 2500,
					},
				],
			},
		};

		const markdown = toPlanMarkdown(withSetup);
		expect(markdown).toContain("includeSetup: true");
		expect(markdown).toContain("## Setup");
		expect(markdown).toContain("## Steps");
		expect(validate(parsePlanMarkdown(markdown))).toEqual(withSetup);
	});

	it("omits setup fields and section for scripts without setup", () => {
		const markdown = toPlanMarkdown(script);
		expect(markdown).not.toContain("includeSetup:");
		expect(markdown).not.toContain("## Setup");
		expect(validate(parsePlanMarkdown(markdown))).toEqual(script);
	});

	it("treats false or absent includeSetup as excluded setup", () => {
		const base = `---\ntitle: T\nstartUrl: https://app.example\nmode: walkthrough\n---\n\n## Setup\n\n1. **Sign in** — Use the demo account.\n\n## Steps\n\n1. **Tour** — Show the dashboard.\n`;

		expect(validate(parsePlanMarkdown(base))).toMatchObject({
			setup: { includeInTour: false },
		});
		expect(
			validate(
				parsePlanMarkdown(
					base.replace(
						"mode: walkthrough",
						"mode: walkthrough\nincludeSetup: false",
					),
				),
			),
		).toMatchObject({
			setup: { includeInTour: false },
		});
	});

	it("round-trips a script through the markdown plan form", () => {
		const back = validate(parsePlanMarkdown(toPlanMarkdown(script)));
		expect(back).toEqual(script);
	});

	it("keeps a trailing inline `code` span in the body, not as timing", () => {
		const [, , , step] = (
			parsePlanMarkdown(toPlanMarkdown(script)) as TourScript
		).steps;
		expect(step.body).toBe("Press `Enter` to run.");
		expect(step.advance).toBe(3000);
	});

	it("parses second-unit and click timings", () => {
		const md = `---\ntitle: T\nstartUrl: https://x.test\nmode: walkthrough\n---\n\n## Steps\n\n1. **A** \`#a\` — do a \`2s\`\n2. **B** \`#b\` — do b \`click\`\n`;
		const s = validate(parsePlanMarkdown(md));
		expect(s.steps[0].advance).toBe(2000);
		expect(s.steps[1].advance).toBe("click");
	});

	it("falls back to the embedded json block when there is no frontmatter", () => {
		const md = "# old plan\n\n```json\n" + JSON.stringify(script) + "\n```\n";
		expect(validate(parsePlanMarkdown(md))).toEqual(script);
	});

	it("round-trips step actions (click + fill) through the plan form", () => {
		const back = validate(
			parsePlanMarkdown(toPlanMarkdown(script)),
		) as TourScript;
		expect(back.steps[1].action).toEqual({ do: "fill", value: "cute puppies" });
		expect(back.steps[2].action).toEqual({ do: "click" });
	});

	it("formatAction/parseAction round-trip a fill value with quotes + backslashes", () => {
		const action = { do: "fill", value: 'say "hi"\\done' } as const;
		expect(parseAction(formatAction(action))).toEqual(action);
	});

	it("accepts the action token before the selector/navigate in a hand-authored meta segment", () => {
		const md = `---\ntitle: T\nstartUrl: https://x.test\nmode: walkthrough\n---\n\n## Steps\n\n1. **A** @click \`#a\` → https://x.test/next — do a\n`;
		const s = validate(parsePlanMarkdown(md)) as TourScript;
		expect(s.steps[0]).toMatchObject({
			selector: "#a",
			navigate: "https://x.test/next",
			action: { do: "click" },
		});
	});
});

describe("parseAction()", () => {
	it("parses a bare @click token", () => {
		expect(parseAction("@click")).toEqual({ do: "click" });
	});

	it("parses an @type token into a fill action", () => {
		expect(parseAction('@type="cute puppies"')).toEqual({
			do: "fill",
			value: "cute puppies",
		});
	});

	it('unescapes \\" and \\\\ inside a hand-authored @type value', () => {
		// Raw meta text as it would appear in an authored plan line, i.e. the
		// literal characters: @type="say \\"hi\\""
		expect(parseAction('@type="say \\"hi\\""')).toEqual({
			do: "fill",
			value: 'say "hi"',
		});
	});

	it("returns undefined when the meta segment has no action", () => {
		expect(parseAction("\`#sel\` → https://x.test")).toBeUndefined();
	});
});

describe("chapter cards", () => {
	const md = (fm: string) =>
		`---\ntitle: Dash\nstartUrl: https://app.example\n${fm}\n---\n\n## Steps\n\n1. **Home** — Hi.\n`;

	it("reads intro and outro as eyebrow, title and detail", () => {
		const parsed = validate(
			parsePlanMarkdown(
				md('intro: "Getting started | Your dashboard | Where things are"\noutro: "Wrap-up | Done | Next: forms"'),
			),
		);
		expect(parsed.intro).toEqual({ eyebrow: "Getting started", title: "Your dashboard", detail: "Where things are" });
		expect(parsed.outro).toEqual({ eyebrow: "Wrap-up", title: "Done", detail: "Next: forms" });
	});

	it("round-trips chapters through toPlanMarkdown", () => {
		const withChapters: TourScript = {
			...script,
			intro: { eyebrow: "Demo", title: "Search", detail: "Find things" },
			outro: { eyebrow: "Wrap-up", title: "Done", detail: "Bye" },
		};
		expect(validate(parsePlanMarkdown(toPlanMarkdown(withChapters)))).toEqual(withChapters);
	});

	it.each([["intro"], ["outro"]])("rejects a %s without three parts, naming the key", (key) => {
		expect(() => validate(parsePlanMarkdown(md(`${key}: "Only | two"`)))).toThrow(key);
	});
});

describe("resolveFill()", () => {
	it("returns literal text unchanged", () => {
		expect(resolveFill("cute puppies", {})).toBe("cute puppies");
	});

	it("reads a $NAME reference from the environment", () => {
		expect(resolveFill("$DG_DEMO_VELORA_PW", { DG_DEMO_VELORA_PW: "s3cret" })).toBe("s3cret");
	});

	it("throws MissingEnvError naming the variable, never a value", () => {
		const error = (() => {
			try {
				resolveFill("$DG_DEMO_VELORA_PW", { OTHER: "s3cret" });
			} catch (e) {
				return e;
			}
		})();
		expect(error).toBeInstanceOf(MissingEnvError);
		expect((error as Error).message).toContain("DG_DEMO_VELORA_PW");
		expect((error as Error).message).not.toContain("s3cret");
	});

	it("treats a lowercase or partial $ string as literal text", () => {
		expect(resolveFill("$lower", {})).toBe("$lower");
		expect(resolveFill("pay $5", {})).toBe("pay $5");
	});

	it("reads only $DG_DEMO_* names as references", () => {
		expect(envReference("$DG_DEMO_X1")).toBe("DG_DEMO_X1");
		expect(envReference("$AWS_SECRET_ACCESS_KEY")).toBeUndefined();
	});
});

describe("validate() fill references", () => {
	const fill = (value: string) => ({
		startUrl: "https://app.example/",
		steps: [
			{ body: "a" },
			{ body: "b", selector: "#p", action: { do: "fill", value } },
		],
	});

	it("accepts a $DG_DEMO_* reference and literal text", () => {
		expect(() => validate(fill("$DG_DEMO_PW"))).not.toThrow();
		expect(() => validate(fill("pay $5"))).not.toThrow();
		expect(() => validate(fill("$lower"))).not.toThrow();
	});

	it("rejects a variable-looking value without the prefix", () => {
		expect(() => validate(fill("$AWS_SECRET_ACCESS_KEY"))).toThrow(
			"step 1: only $DG_DEMO_* variables can be typed",
		);
	});

	it("rejects it in setup steps too", () => {
		expect(() =>
			validate({
				...fill("x"),
				setup: { includeInTour: false, steps: [{ body: "s", selector: "#p", action: { do: "fill", value: "$HOME" } }] },
			}),
		).toThrow("setup step 0: only $DG_DEMO_* variables can be typed");
	});
});
