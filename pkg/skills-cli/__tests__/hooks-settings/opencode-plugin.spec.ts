import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { settingsWorld } from "./settings-fixtures";

type Handler = (
	input: Record<string, unknown>,
	output: Record<string, unknown>,
) => Promise<void>;
type Plugin = (ctx: { directory: string }) => Promise<{
	"tool.execute.before": Handler;
	"tool.execute.after": Handler;
}>;

let world: ReturnType<typeof settingsWorld>;
let launcher: string;
beforeEach(() => {
	world = settingsWorld();
	world.seed(world.paths.opencodeJson, {});
	launcher = world.seed(
		join(world.dgHome, "bin", "dg-skills"),
		`#!/bin/sh
d="$(dirname "$0")"
echo "$3" >> "$d/ids.log"
cat > "$d/stdin.$3.json"
if [ -f "$d/exit" ]; then
  echo blocked-by-hook >&2
  exit "$(cat "$d/exit")"
fi
`,
	);
	chmodSync(launcher, 0o755);
});
afterEach(() => world.cleanup());

const binDir = () => dirname(launcher);
const ranIds = (): string[] => {
	try {
		return readFileSync(join(binDir(), "ids.log"), "utf8")
			.split("\n")
			.filter(Boolean);
	} catch {
		return [];
	}
};
const stdinOf = (id: string) =>
	JSON.parse(readFileSync(join(binDir(), `stdin.${id}.json`), "utf8"));

async function loadPlugin() {
	const mod = (await import(world.paths.opencodePlugin)) as { default: Plugin };
	return mod.default({ directory: "/work/tree" });
}

const enableFor = (id: string) =>
	world.cli(["enable", id, "--runtime", "opencode"], { launcher });

describe.skipIf(process.platform === "win32")(
	"generated opencode plugin",
	() => {
		test("tool.execute.after sends Claude-shaped stdin to a matching PostToolUse hook", async () => {
			await enableFor("spelling");
			const plugin = await loadPlugin();
			await plugin["tool.execute.after"](
				{ tool: "edit", callID: "c1" },
				{
					args: { filePath: "/work/tree/a.md", oldString: "a", newString: "b" },
				},
			);
			expect(ranIds()).toEqual(["spelling"]);
			expect(stdinOf("spelling")).toEqual({
				tool_name: "Edit",
				tool_input: {
					file_path: "/work/tree/a.md",
					old_string: "a",
					new_string: "b",
				},
				cwd: "/work/tree",
			});
		});

		test("matcher filter skips a hook when the tool name does not match", async () => {
			await enableFor("spelling");
			const plugin = await loadPlugin();
			await plugin["tool.execute.after"](
				{ tool: "bash", callID: "c2" },
				{ args: { command: "ls" } },
			);
			expect(ranIds()).toEqual([]);
		});

		test("PreToolUse hooks run on before and not on after", async () => {
			await enableFor("pr-prose");
			const plugin = await loadPlugin();
			await plugin["tool.execute.after"](
				{ tool: "bash", callID: "c3" },
				{ args: { command: "echo hi" } },
			);
			expect(ranIds()).toEqual([]);
			await plugin["tool.execute.before"](
				{ tool: "bash", callID: "c3" },
				{ args: { command: "echo hi" } },
			);
			expect(ranIds()).toEqual(["pr-prose"]);
			expect(stdinOf("pr-prose").tool_input).toEqual({ command: "echo hi" });
			expect(stdinOf("pr-prose").tool_name).toBe("Bash");
		});

		test("args seen on before are reused for the matching after call", async () => {
			await enableFor("spelling");
			const plugin = await loadPlugin();
			await plugin["tool.execute.before"](
				{ tool: "write", callID: "c4" },
				{ args: { filePath: "/work/tree/b.md", content: "x" } },
			);
			await plugin["tool.execute.after"]({ tool: "write", callID: "c4" }, {});
			expect(stdinOf("spelling").tool_input).toEqual({
				file_path: "/work/tree/b.md",
				content: "x",
			});
		});

		test("a hook that exits 2 makes the handler throw with its stderr", async () => {
			await enableFor("pr-prose");
			writeFileSync(join(binDir(), "exit"), "2");
			const plugin = await loadPlugin();
			await expect(
				plugin["tool.execute.before"](
					{ tool: "bash", callID: "c5" },
					{ args: { command: "echo hi" } },
				),
			).rejects.toThrow("blocked-by-hook");
		});

		test("a hook that exits 1 does not throw", async () => {
			await enableFor("pr-prose");
			writeFileSync(join(binDir(), "exit"), "1");
			const plugin = await loadPlugin();
			await plugin["tool.execute.before"](
				{ tool: "bash", callID: "c6" },
				{ args: { command: "echo hi" } },
			);
			expect(ranIds()).toEqual(["pr-prose"]);
		});
	},
);
