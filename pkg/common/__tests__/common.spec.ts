import { describe, expect, it } from "bun:test";
import type { TourScript } from "../src/index";
import {
	extractScriptFromMarkdown,
	partitionTourSteps,
	toPlanMarkdown,
	validate,
} from "../src/index";

const validScript: TourScript = {
	title: "My Tour",
	startUrl: "https://example.com",
	steps: [{ body: "Welcome to the tour." }],
	mode: "walkthrough",
};

describe("validate()", () => {
	it("accepts a valid TourScript", () => {
		expect(() => validate(validScript)).not.toThrow();
		const result = validate(validScript);
		expect(result.startUrl).toBe("https://example.com");
		expect(result.steps).toHaveLength(1);
	});

	it("throws on missing startUrl", () => {
		const bad = { steps: [{ body: "hi" }] };
		expect(() => validate(bad)).toThrow("startUrl");
	});

	it("throws on empty steps array", () => {
		const bad = { startUrl: "https://example.com", steps: [] };
		expect(() => validate(bad)).toThrow("non-empty");
	});

	// Regression guard: a zero-step tour is genuinely invalid (callers gate on
	// script?.steps?.length) — only setup.steps may be empty, never this one.
	it("still throws on empty top-level steps even once setup.steps is allowed to be empty", () => {
		const bad = {
			...validScript,
			steps: [],
			setup: { steps: [], includeInTour: true },
		};
		expect(() => validate(bad)).toThrow(
			"script.steps must be a non-empty array",
		);
	});

	it("throws on invalid mode", () => {
		const bad = {
			startUrl: "https://example.com",
			steps: [{ body: "hi" }],
			mode: "live",
		};
		expect(() => validate(bad)).toThrow("mode");
	});

	it("accepts optional setup while preserving a legacy script", () => {
		const withSetup = {
			...validScript,
			setup: {
				steps: [{ title: "Sign in", body: "Use the demo account." }],
				includeInTour: false,
			},
		};

		expect(validate(validScript)).toEqual(validScript);
		expect(validate(withSetup)).toEqual(withSetup);
	});

	it("accepts a setup block with no steps, meaning no preparation", () => {
		const emptySetup = {
			...validScript,
			setup: { steps: [], includeInTour: true },
		};

		expect(validate(emptySetup)).toEqual(emptySetup);
	});

	it("accepts an empty setup block with includeInTour false too", () => {
		const emptySetup = {
			...validScript,
			setup: { steps: [], includeInTour: false },
		};

		expect(validate(emptySetup)).toEqual(emptySetup);
	});

	it("reports setup paths when setup is malformed", () => {
		expect(() => validate({ ...validScript, setup: "not setup" })).toThrow(
			"script.setup",
		);
		expect(() =>
			validate({
				...validScript,
				setup: { steps: "nope", includeInTour: false },
			}),
		).toThrow("script.setup.steps");
		expect(() =>
			validate({
				...validScript,
				setup: {
					steps: [{ body: 42 }],
					includeInTour: true,
				},
			}),
		).toThrow("setup step 0");
		expect(() =>
			validate({
				...validScript,
				setup: { steps: [{ body: "Prepare" }], includeInTour: "yes" },
			}),
		).toThrow("script.setup.includeInTour");
	});
});

describe("partitionTourSteps()", () => {
	it("keeps excluded setup separate and prepends included setup in source order", () => {
		const steps = [
			{ body: "First tutorial step" },
			{ body: "Second tutorial step" },
		];
		const setup = [{ body: "Prepare account" }, { body: "Seed item" }];
		expect(
			partitionTourSteps({
				...validScript,
				steps,
				setup: { steps: setup, includeInTour: false },
			}),
		).toEqual({ setup, tutorial: steps });
		expect(
			partitionTourSteps({
				...validScript,
				steps,
				setup: { steps: setup, includeInTour: true },
			}),
		).toEqual({ setup: [], tutorial: [...setup, ...steps] });
	});
});

describe("toPlanMarkdown()", () => {
	it("produces markdown containing the title and startUrl", () => {
		const md = toPlanMarkdown(validScript);
		expect(md).toContain("My Tour");
		expect(md).toContain("https://example.com");
	});

	it("emits the human step list, not an embedded json block", () => {
		const md = toPlanMarkdown(validScript);
		expect(md).toContain("## Steps");
		expect(md).not.toContain("```json");
	});
});

describe("extractScriptFromMarkdown()", () => {
	it("extracts a json block from a legacy plan markdown string", () => {
		const md = `\`\`\`json\n${JSON.stringify(validScript)}\n\`\`\``;
		const extracted = extractScriptFromMarkdown(md);
		expect(extracted).toMatchObject({ startUrl: "https://example.com" });
	});

	it("throws when no json block is present", () => {
		expect(() => extractScriptFromMarkdown("# No code block here")).toThrow(
			"no ```json script block found",
		);
	});

	// Regression: empty setup.steps used to make validate() throw, and callers that
	// swallow the throw (readDemoScript) dropped the whole tour, not just setup.
	it("does not drop a legacy plan whose embedded script has an empty setup.steps", () => {
		const scriptWithEmptySetup: TourScript = {
			...validScript,
			steps: [{ body: "Welcome." }, { body: "Click here." }],
			setup: { steps: [], includeInTour: true },
		};
		const md = `# old plan\n\n\`\`\`json\n${JSON.stringify(scriptWithEmptySetup)}\n\`\`\`\n`;

		const tour = validate(extractScriptFromMarkdown(md));

		expect(tour.steps.length).toBeGreaterThan(0);
		expect(tour).toEqual(scriptWithEmptySetup);
	});
});
