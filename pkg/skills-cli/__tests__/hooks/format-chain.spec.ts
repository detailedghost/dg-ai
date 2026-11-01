import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { editInput, hookWorld } from "./hook-fixtures";

let world: ReturnType<typeof hookWorld>;
beforeEach(() => {
	world = hookWorld();
});
afterEach(() => world.cleanup());

function editing(file: string) {
	const input = editInput("x");
	return { ...input, tool_input: { ...input.tool_input, file_path: file } };
}

describe("format hook formatter chain", () => {
	test("runs the formatter found through the which seam and stays silent", async () => {
		const file = world.seed("src/a.py", "x = 1\n");
		const r = await world.run("format", editing(file), {
			which: (bin) => (bin === "ruff" ? "/fake/ruff" : undefined),
		});
		expect(r.code).toBe(0);
		expect(r.stdout).toBe("");
		expect(world.calls.map((c) => c.argv)).toEqual([
			["ruff", "format", "--quiet", file],
		]);
	});

	test("skips a zsh script instead of formatting it", async () => {
		const file = world.seed("run.sh", "#!/usr/bin/env zsh\necho $#\n");
		const r = await world.run("format", editing(file), {
			which: () => "/fake/shfmt",
		});
		expect(r.code).toBe(0);
		expect(world.calls).toEqual([]);
	});
});

describe("format hook tool and path gating", () => {
	test("makes no formatter call and prints nothing when .md is skipped", async () => {
		for (const rel of ["CLAUDE.md", ".agents/x.md", "docs/refactor-foo.md"]) {
			const file = world.seed(rel, "# t\n");
			const r = await world.run("format", editing(file), {
				which: () => "/fake/bin",
			});
			expect(r.code).toBe(0);
			expect(r.stdout).toBe("");
		}
		expect(world.calls).toEqual([]);
	});

	test("formats an ordinary .md through mdformat", async () => {
		const file = world.seed("docs/guide.md", "# t\n");
		await world.run("format", editing(file), {
			which: (bin) => (bin === "mdformat" ? "/fake/mdformat" : undefined),
		});
		expect(world.calls.map((c) => c.argv)).toEqual([["mdformat", file]]);
	});

	test.each([
		["bash script by shebang", "#!/bin/bash\necho hi\n"],
		["script with no shebang", "echo hi\n"],
	])("runs shfmt on a %s", async (_name, text) => {
		const file = world.seed("run.sh", text);
		await world.run("format", editing(file), {
			which: (bin) => (bin === "shfmt" ? "/fake/shfmt" : undefined),
		});
		expect(world.calls.map((c) => c.argv)).toEqual([
			["shfmt", "-i", "2", "-w", file],
		]);
	});

	test("reports shfmt as missing for a bash script when it is absent", async () => {
		const file = world.seed("run.sh", "#!/bin/bash\necho hi\n");
		const r = await world.run("format", editing(file), {
			which: () => undefined,
		});
		expect(JSON.parse(r.stdout).hookSpecificOutput.additionalContext).toContain(
			"shfmt",
		);
	});
});
