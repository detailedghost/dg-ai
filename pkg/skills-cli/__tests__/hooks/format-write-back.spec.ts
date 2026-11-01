import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { editInput, hookWorld } from "./hook-fixtures";

let world: ReturnType<typeof hookWorld>;
beforeEach(() => {
	world = hookWorld();
});
afterEach(() => world.cleanup());

function editing(file: string, tool = "Edit") {
	const input = editInput("x");
	return {
		...input,
		tool_name: tool,
		tool_input: { ...input.tool_input, file_path: file },
	};
}

const PRETTY = '{\n  "a": 1\n}\n';
const only = (bin: string) => (name: string) =>
	name === bin ? `/fake/${bin}` : undefined;

describe("format hook json write-back through jq", () => {
	test("writes the jq output back into the file", async () => {
		const file = world.seed("data.json", '{"a":1}');
		await world.run("format", editing(file), {
			which: only("jq"),
			reply: { status: 0, stdout: PRETTY },
		});
		expect(world.calls.map((c) => c.argv)).toEqual([["jq", ".", file]]);
		expect(readFileSync(file, "utf8")).toBe(PRETTY);
	});

	test("leaves the file alone when jq exits non-zero", async () => {
		const file = world.seed("data.json", '{"a":');
		await world.run("format", editing(file), {
			which: only("jq"),
			reply: { status: 2, stdout: PRETTY, stderr: "parse error" },
		});
		expect(readFileSync(file, "utf8")).toBe('{"a":');
	});

	test("leaves the file alone when jq prints nothing", async () => {
		const file = world.seed("data.json", '{"a":1}');
		await world.run("format", editing(file), {
			which: only("jq"),
			reply: { status: 0, stdout: "" },
		});
		expect(readFileSync(file, "utf8")).toBe('{"a":1}');
	});

	test("leaves no temp file beside the target", async () => {
		const file = world.seed("data.json", '{"a":1}');
		await world.run("format", editing(file), {
			which: only("jq"),
			reply: { status: 0, stdout: PRETTY },
		});
		expect(readdirSync(join(file, ".."))).toEqual(["data.json"]);
	});
});

describe("format hook xml write-back through xmlformat", () => {
	test("writes the xmlformat output back into the file", async () => {
		const file = world.seed("data.xml", "<a><b/></a>");
		await world.run("format", editing(file), {
			which: only("xmlformat"),
			reply: { status: 0, stdout: "<a>\n  <b/>\n</a>\n" },
		});
		expect(readFileSync(file, "utf8")).toBe("<a>\n  <b/>\n</a>\n");
	});

	test("leaves the file alone when xmlformat exits non-zero", async () => {
		const file = world.seed("data.xml", "<a>");
		await world.run("format", editing(file), {
			which: only("xmlformat"),
			reply: { status: 1, stdout: "<junk/>" },
		});
		expect(readFileSync(file, "utf8")).toBe("<a>");
	});

	test("leaves the file alone when xmlformat prints nothing", async () => {
		const file = world.seed("data.xml", "<a/>");
		await world.run("format", editing(file), {
			which: only("xmlformat"),
			reply: { status: 0, stdout: "" },
		});
		expect(readFileSync(file, "utf8")).toBe("<a/>");
	});
});

describe("format hook failures", () => {
	test("leaves the file alone and says so when jq output was truncated", async () => {
		const file = world.seed("big.json", '{"a":1}');
		const r = await world.run("format", editing(file), {
			which: only("jq"),
			reply: { status: 0, stdout: '{\n  "a"', truncated: true },
		});
		expect(readFileSync(file, "utf8")).toBe('{"a":1}');
		expect(JSON.parse(r.stdout).hookSpecificOutput.additionalContext).toBe(
			"format: jq output was incomplete, so the file was left unchanged",
		);
	});

	test("leaves the file alone when xmlformat output was truncated", async () => {
		const file = world.seed("big.xml", "<a/>");
		await world.run("format", editing(file), {
			which: only("xmlformat"),
			reply: { status: 0, stdout: "<a", truncated: true },
		});
		expect(readFileSync(file, "utf8")).toBe("<a/>");
	});

	test("reports a formatter that exits non-zero", async () => {
		const file = world.seed("src/a.py", "x = 1\n");
		const r = await world.run("format", editing(file), {
			which: only("ruff"),
			reply: { status: 2, stderr: "error: cannot parse a.py\nmore" },
		});
		expect(r.code).toBe(0);
		expect(JSON.parse(r.stdout).hookSpecificOutput.additionalContext).toBe(
			"format: ruff failed (status 2): error: cannot parse a.py",
		);
	});

	test("reports a biome format failure instead of a missing formatter", async () => {
		const file = world.seed("src/a.ts", "const a=1\n");
		world.seed("node_modules/.bin/biome", "");
		world.seed(".git/HEAD", "");
		const r = await world.run("format", editing(file), {
			replyFor: (argv) =>
				argv[1] === "format"
					? { status: 1, stderr: "parse error" }
					: { status: 0 },
		});
		const context = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
		expect(context).toContain("biome failed (status 1): parse error");
		expect(context).not.toContain("formatter unavailable");
	});

	test("resolves a relative file_path against the event cwd", async () => {
		const file = world.seed("proj/a.py", "x = 1\n");
		const r = await world.run(
			"format",
			{ ...editing("a.py"), cwd: join(world.work, "proj") },
			{ which: only("ruff") },
		);
		expect(r.code).toBe(0);
		expect(world.calls.map((c) => c.argv)).toEqual([
			["ruff", "format", "--quiet", file],
		]);
	});
});
