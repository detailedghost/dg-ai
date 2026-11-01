import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { hookWorld, SESSION } from "./hook-fixtures";

let world: ReturnType<typeof hookWorld>;
beforeEach(() => {
	world = hookWorld();
});
afterEach(() => world.cleanup());

function inputFor(file: string) {
	return {
		session_id: SESSION,
		tool_name: "Edit",
		cwd: world.work,
		tool_input: { file_path: file, old_string: "", new_string: "x" },
	};
}

function subcommand(argv: string[]) {
	return argv.slice(-3, -1);
}

describe("spec-plan-lint hook", () => {
	test("is a no-op for a file outside .agents/spec", async () => {
		const file = world.seed("src/app.ts", "x");
		const r = await world.run("spec-plan-lint", inputFor(file), {
			reply: { status: 1, stdout: "must not run" },
		});
		expect(r.code).toBe(0);
		expect(r.stdout + r.stderr).toBe("");
		expect(world.calls).toHaveLength(0);
	});

	test("is a no-op for a non plan.md file under .agents/spec", async () => {
		const file = world.seed(".agents/spec/001_x/context.md", "x");
		const r = await world.run("spec-plan-lint", inputFor(file), {
			reply: { status: 1 },
		});
		expect(r.code).toBe(0);
		expect(world.calls).toHaveLength(0);
	});

	test("exits 2 with the validate output for a plan.md that fails validate", async () => {
		const file = world.seed(".agents/spec/001_x/plan.md", "x");
		const r = await world.run("spec-plan-lint", inputFor(file), {
			reply: { status: 1, stdout: "frontmatter: slices[0].agents is required" },
		});
		expect(r.code).toBe(2);
		expect(r.stderr + r.stdout).toContain(
			"frontmatter: slices[0].agents is required",
		);
		expect(world.calls[0]!.argv.slice(-3)).toEqual(["spec", "validate", file]);
	});

	test("runs validate then lint-waves and exits 0 when both pass", async () => {
		const file = world.seed(".agents/spec/002_y/plan.md", "x");
		const r = await world.run("spec-plan-lint", inputFor(file), {
			reply: { status: 0 },
		});
		expect(r.code).toBe(0);
		expect(world.calls.map((c) => subcommand(c.argv))).toEqual([
			["spec", "validate"],
			["spec", "lint-waves"],
		]);
		expect(world.calls[1]!.argv.at(-1)).toBe(file);
	});

	test("exits 2 and surfaces the output when lint-waves fails", async () => {
		const file = world.seed(".agents/spec/003_z/plan.md", "x");
		const r = await world.run("spec-plan-lint", inputFor(file), {
			reply: { status: 1, stderr: "wave 2 depends on wave 3" },
		});
		expect(r.code).toBe(2);
		expect(r.stderr + r.stdout).toContain("wave 2 depends on wave 3");
	});

	test("lints the file named by tool_response.filePath over tool_input.file_path", async () => {
		const plan = world.seed(".agents/spec/004_w/plan.md", "x");
		const other = world.seed("src/app.ts", "x");
		const r = await world.run(
			"spec-plan-lint",
			{
				...inputFor(other),
				tool_response: { filePath: plan },
			},
			{ reply: { status: 1, stdout: "bad plan" } },
		);
		expect(r.code).toBe(2);
		expect(world.calls.map((c) => c.argv.at(-1))).toEqual([plan, plan]);
	});

	test("ignores tool_response.filePath when it is outside .agents/spec", async () => {
		const plan = world.seed(".agents/spec/004_w/plan.md", "x");
		const other = world.seed("src/app.ts", "x");
		const r = await world.run(
			"spec-plan-lint",
			{ ...inputFor(plan), tool_response: { filePath: other } },
			{ reply: { status: 1 } },
		);
		expect(r.code).toBe(0);
		expect(world.calls).toHaveLength(0);
	});

	test("passes a relative file_path through and runs from the event cwd", async () => {
		const rel = ".agents/spec/005_v/plan.md";
		world.seed(rel, "x");
		const r = await world.run("spec-plan-lint", inputFor(rel), {
			reply: { status: 1, stdout: "bad" },
		});
		expect(r.code).toBe(2);
		expect(world.calls.map((c) => c.cwd)).toEqual([world.work, world.work]);
		expect(world.calls[0]?.argv.at(-1)).toBe(rel);
	});

	test("exits 2 when the self command cannot start", async () => {
		const file = world.seed(".agents/spec/006_u/plan.md", "x");
		const r = await world.run("spec-plan-lint", inputFor(file), {
			reply: { status: 127, stderr: "spawn failed" },
		});
		expect(r.code).toBe(2);
		expect(r.stderr).toContain("spawn failed");
	});

	test("lints a plan.md given with backslash separators", async () => {
		const r = await world.run(
			"spec-plan-lint",
			inputFor("C:\\repo\\.agents\\spec\\006_u\\plan.md"),
			{ reply: { status: 1, stdout: "bad" } },
		);
		expect(r.code).toBe(2);
	});

	test("labels each failing check in the output", async () => {
		const file = world.seed(".agents/spec/007_t/plan.md", "x");
		const r = await world.run("spec-plan-lint", inputFor(file), {
			replyFor: (argv) =>
				argv.at(-2) === "lint-waves"
					? { status: 1, stderr: "wave cycle" }
					: { status: 0 },
		});
		expect(r.code).toBe(2);
		expect(r.stderr).toContain("spec lint-waves failed");
		expect(r.stderr).not.toContain("spec validate failed");
	});

	test("lints a plan.md nested under .agents/spec/todo", async () => {
		const file = world.seed(".agents/spec/todo/008_s/plan.md", "x");
		const r = await world.run("spec-plan-lint", inputFor(file), {
			reply: { status: 1 },
		});
		expect(r.code).toBe(2);
		expect(world.calls).toHaveLength(2);
	});
});
