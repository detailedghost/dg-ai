import { describe, expect, it } from "bun:test";
import type { TourScript } from "@dg/common";
import {
	formatAction,
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
});
