import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { bashInput, hookWorld } from "./hook-fixtures";

let world: ReturnType<typeof hookWorld>;
beforeEach(() => {
	world = hookWorld();
});
afterEach(() => world.cleanup());

async function decision(command: string) {
	const r = await world.run("pr-confirm", bashInput(command));
	return { ...r, json: r.stdout ? JSON.parse(r.stdout) : undefined };
}

describe("pr-confirm hook", () => {
	test("prints the ask decision JSON for gh pr create", async () => {
		const r = await decision("gh pr create --title x --body y");
		expect(r.code).toBe(0);
		expect(r.json.hookSpecificOutput.hookEventName).toBe("PreToolUse");
		expect(r.json.hookSpecificOutput.permissionDecision).toBe("ask");
		expect(r.json.hookSpecificOutput.permissionDecisionReason).toBeString();
	});

	test("prints nothing for gh pr view", async () => {
		const r = await world.run("pr-confirm", bashInput("gh pr view 42"));
		expect(r.code).toBe(0);
		expect(r.stdout).toBe("");
	});

	test("asks for glab mr create the same way as gh pr create", async () => {
		const gh = await decision("gh pr create --title x --body y");
		const glab = await decision("glab mr create --title x --description y");
		expect(glab.json.hookSpecificOutput.permissionDecision).toBe(
			gh.json.hookSpecificOutput.permissionDecision,
		);
	});

	test.each([
		"sudo gh pr create --title x",
		"env X=1 gh pr create --title x",
		"command gh pr create --title x",
		"bash -c 'gh pr create --title x'",
		'sh -c "gh pr create --title x"',
		"exec gh pr create --title x",
		"sudo -E env X=1 gh pr create --title x",
	])("asks for the wrapped form %s", async (command) => {
		const r = await decision(command);
		expect(r.json.hookSpecificOutput.permissionDecision).toBe("ask");
	});

	test("matches a long run of flag lines without runaway backtracking", async () => {
		const r = await world.run(
			"pr-confirm",
			bashInput("gh -a\n".repeat(20_000)),
		);
		expect(r.code).toBe(0);
	}, 5_000);

	test.each([
		"glab mr view 42",
		"gh pr edit 42 --body y",
		"glab mr update 42 --description y",
		"git push",
		"ls -la",
	])("prints nothing for %s", async (command) => {
		const r = await world.run("pr-confirm", bashInput(command));
		expect(r.code).toBe(0);
		expect(r.stdout).toBe("");
	});

	test.each([
		"gh pr create --dry-run --title x --body y",
		"glab mr create --dry-run --title x --description y",
	])("a dry run flag does not exempt %s", async (command) => {
		expect(
			(await decision(command)).json.hookSpecificOutput.permissionDecision,
		).toBe("ask");
	});

	test("reads the Codex tool_input.cmd field", async () => {
		const r = await world.run(
			"pr-confirm",
			bashInput("gh pr create --title x", "cmd"),
		);
		expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision).toBe(
			"ask",
		);
	});

	test("asks when the create sits behind a chained command", async () => {
		const r = await decision("cd repo && gh pr create --title x");
		expect(r.json.hookSpecificOutput.permissionDecision).toBe("ask");
	});

	test("prints nothing when the Bash input has no command", async () => {
		const r = await world.run("pr-confirm", {
			session_id: "TEST",
			tool_name: "Bash",
			tool_input: {},
		});
		expect(r.code).toBe(0);
		expect(r.stdout).toBe("");
	});

	test.each([
		"gh  pr  create --title x",
		"gh\tpr create --title x",
		"gh -R a/b pr create --title x",
		"glab -R a/b mr create --title x",
		"cd repo && gh pr create --title x",
	])("asks for %s", async (command) => {
		const r = await decision(command);
		expect(r.json.hookSpecificOutput.permissionDecision).toBe("ask");
	});

	test.each(["echo gh pr create", "git commit -m 'document gh pr create'"])(
		"stays silent for %s",
		async (command) => {
			const r = await decision(command);
			expect(r.stdout).toBe("");
		},
	);
});
