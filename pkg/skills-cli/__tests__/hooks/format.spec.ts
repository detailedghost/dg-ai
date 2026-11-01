import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	chmodSync,
	lstatSync,
	readdirSync,
	rmSync,
	readFileSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { editInput, hookWorld, SESSION } from "./hook-fixtures";

let world: ReturnType<typeof hookWorld>;
beforeEach(() => {
	world = hookWorld();
});
afterEach(() => world.cleanup());

function editing(file: string, session = SESSION) {
	const input = editInput("x");
	return {
		...input,
		session_id: session,
		tool_input: { ...input.tool_input, file_path: file },
	};
}

function context(stdout: string) {
	return JSON.parse(stdout).hookSpecificOutput.additionalContext as string;
}

describe("format hook", () => {
	test("exits 0 and emits additionalContext when no formatter is installed", async () => {
		const file = world.seed("src/a.py", "x = 1\n");
		const r = await world.run("format", editing(file), {
			which: () => undefined,
		});
		expect(r.code).toBe(0);
		expect(JSON.parse(r.stdout).hookSpecificOutput.hookEventName).toBe(
			"PostToolUse",
		);
		expect(context(r.stdout)).toMatch(/not formatted/i);
	});

	test("emits the additionalContext once per session", async () => {
		const file = world.seed("src/a.py", "x = 1\n");
		const first = await world.run("format", editing(file));
		const second = await world.run("format", editing(file));
		expect(first.stdout).not.toBe("");
		expect(second.code).toBe(0);
		expect(second.stdout).toBe("");
	});

	test("a different session is told again", async () => {
		const file = world.seed("src/a.py", "x = 1\n");
		await world.run("format", editing(file, "S1"));
		const other = await world.run("format", editing(file, "S2"));
		expect(context(other.stdout)).toMatch(/not formatted/i);
	});

	test("skips a file that does not exist", async () => {
		const r = await world.run("format", editing("/nonexistent/dir/a.py"));
		expect(r.code).toBe(0);
		expect(r.stdout).toBe("");
	});

	test("skips a file type with no formatter chain", async () => {
		const file = world.seed("notes.unknownext", "x");
		const r = await world.run("format", editing(file));
		expect(r.code).toBe(0);
		expect(r.stdout).toBe("");
	});
});

describe("format hook missing-tool context", () => {
	test("names a missing formatter once and not again in the session", async () => {
		const file = world.seed("src/a.py", "x = 1\n");
		const first = await world.run("format", editing(file));
		expect(context(first.stdout).match(/ruff/g)).toHaveLength(1);
		const second = await world.run("format", editing(file));
		expect(second.stdout).toBe("");
	});

	test("a missing biome is reported once through its marker name", async () => {
		const file = world.seed("src/a.ts", "const a = 1;\n");
		const first = await world.run("format", editing(file));
		expect(first.code).toBe(0);
		expect(context(first.stdout).match(/biome/g)).toHaveLength(1);
		const second = await world.run("format", editing(file));
		expect(second.stdout).toBe("");
	});

	test("a second missing tool in the same session is still reported", async () => {
		const py = world.seed("src/a.py", "x = 1\n");
		const go = world.seed("src/a.go", "package a\n");
		await world.run("format", editing(py));
		const next = await world.run("format", editing(go));
		expect(context(next.stdout)).toContain("gofmt");
		expect(context(next.stdout)).not.toContain("ruff");
	});

	test("ignores a Read input and runs no formatter", async () => {
		const file = world.seed("src/a.py", "x = 1\n");
		const r = await world.run(
			"format",
			{ ...editing(file), tool_name: "Read" },
			{ which: () => "/bin/ruff" },
		);
		expect(r.code).toBe(0);
		expect(world.calls).toHaveLength(0);
	});

	test("keeps a symlink a symlink after a jq write-back", async () => {
		const real = world.seed("real/data.json", '{"a":1}');
		const link = join(world.work, "link.json");
		symlinkSync(real, link);
		await world.run("format", editing(link), {
			which: (bin) => (bin === "jq" ? "/bin/jq" : undefined),
			reply: { status: 0, stdout: '{\n  "a": 1\n}\n' },
		});
		expect(lstatSync(link).isSymbolicLink()).toBe(true);
		expect(readFileSync(real, "utf8")).toBe('{\n  "a": 1\n}\n');
	});

	test("keeps the file mode when jq rewrites a json file", async () => {
		const file = world.seed("data.json", '{"a":1}');
		chmodSync(file, 0o755);
		await world.run("format", editing(file), {
			which: (bin) => (bin === "jq" ? "/bin/jq" : undefined),
			reply: { status: 0, stdout: '{\n  "a": 1\n}\n' },
		});
		expect(statSync(file).mode & 0o777).toBe(0o755);
		expect(readFileSync(file, "utf8")).toBe('{\n  "a": 1\n}\n');
	});

	test("does not throw for a file named after an Object.prototype key", async () => {
		const file = world.seed("src/a.constructor", "x");
		const r = await world.run("format", editing(file), {
			which: () => undefined,
		});
		expect(r.code).toBe(0);
	});

	test("skips markdown under .claude when the path uses backslashes", async () => {
		const file = world.seed("C:\\repo\\.claude\\x.md", "x");
		const r = await world.run("format", editing(file), {
			which: () => "/fake/mdformat",
		});
		expect(r.code).toBe(0);
		expect(world.calls).toEqual([]);
	});
});

describe("format hook biome probe", () => {
	test("probes biome --version once per process even when the marker file is gone", async () => {
		const file = world.seed("src/a.ts", "x");
		const options = {
			which: (bin: string) => (bin === "biome" ? "/bin/biome" : undefined),
			reply: { status: 0, stdout: "Version: 2.0.0" },
		};
		await world.run("format", editing(file), options);
		for (const name of readdirSync(join(world.scratch, "hooks")))
			if (name.startsWith("biome-real."))
				rmSync(join(world.scratch, "hooks", name));
		await world.run("format", editing(file), options);
		const probes = world.calls.filter((c) => c.argv[1] === "--version");
		expect(probes).toHaveLength(1);
	});
});

describe("format write-back with a concurrent edit", () => {
	test("leaves a file that changed while jq ran", async () => {
		const file = world.seed("data.json", '{"a":1}');
		const r = await world.run("format", editing(file), {
			which: (bin) => (bin === "jq" ? "/bin/jq" : undefined),
			replyFor: () => {
				writeFileSync(file, '{"a":2}');
				return { status: 0, stdout: '{\n  "a": 1\n}\n' };
			},
		});
		expect(readFileSync(file, "utf8")).toBe('{"a":2}');
		expect(`${r.stdout}${r.stderr}`).toContain("changed while jq ran");
	});
});
