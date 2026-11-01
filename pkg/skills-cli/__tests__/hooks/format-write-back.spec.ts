import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
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
