import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { NarrationProgressTracker as sharedTracker } from "../../tour-ui/src/narration-progress";
import { cssSelectorFor as sharedSelector } from "../../tour-ui/src/picker";
import * as sharedUiHelpers from "../../tour-ui/src/ui-helpers";
import { holdFor as sharedHold } from "../../tour-ui/src/video-timing";
import config from "../wxt.config";
import { NarrationProgressTracker } from "../lib/narration-progress";
import { cssSelectorFor } from "../lib/picker";
import * as extUiHelpers from "../lib/ui-helpers";
import { holdFor } from "../lib/video-timing";

const EXT = resolve(import.meta.dir, "..");
const read = (rel: string) => readFileSync(resolve(EXT, rel), "utf8");

describe("extension lib re-exports from @dg/tour-ui", () => {
	for (const file of [
		"lib/picker.ts",
		"lib/ui-helpers.ts",
		"lib/video-timing.ts",
		"lib/narration-progress.ts",
	]) {
		it(`${file} is a one-line re-export`, () => {
			const lines = read(file)
				.split("\n")
				.filter((l) => l.trim() !== "");
			expect(lines.length).toBe(1);
			expect(lines[0]).toContain("@dg/tour-ui");
		});
	}

	it("serves the same module instances as the shared package", () => {
		expect(holdFor).toBe(sharedHold);
		expect(cssSelectorFor).toBe(sharedSelector);
		expect(NarrationProgressTracker).toBe(sharedTracker);
		expect(extUiHelpers.createEl).toBe(sharedUiHelpers.createEl);
	});
});

describe("wxt.config.ts", () => {
	it("aliases @dg/tour-ui next to @dg/common", () => {
		const vite = (
			config.vite as unknown as () => {
				resolve: { alias: Record<string, string> };
			}
		)();

		expect(vite.resolve.alias["@dg/common"]).toBeDefined();
		expect(vite.resolve.alias["@dg/tour-ui"]).toEndWith("tour-ui/src/index.ts");
	});
});

describe("demo-tour.ts", () => {
	const source = read("lib/features/demo-tour.ts");

	it("calls into @dg/tour-ui and builds its host with wxtHost", () => {
		expect(source).toContain("@dg/tour-ui");
		expect(source).toContain("wxtHost");
	});

	it("no longer owns the moved overlay and editor implementations", () => {
		for (const moved of [
			"export function buildOverlay",
			"export function* editMachine",
			"export function editorReviewRows",
			"export function draftToScript",
			"export function scriptToDraft",
		]) {
			expect(source).not.toContain(moved);
		}
	});
});
