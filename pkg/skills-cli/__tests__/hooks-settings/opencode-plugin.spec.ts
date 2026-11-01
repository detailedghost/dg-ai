import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
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
if [ -f "$d/context" ]; then
  cat "$d/context"
fi
if [ -f "$d/noisy" ]; then
  printf '{"pad":"'
  head -c 1100000 /dev/zero | tr '\\0' a
  printf '","hookSpecificOutput":{"additionalContext":"big"}}'
  exit 0
fi
if [ -f "$d/hang" ]; then
  trap '' TERM
  sleep 3 &
  wait
fi
if [ -f "$d/signal" ]; then
  kill -9 $$
fi
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

		test("passes the opencode session id as session_id", async () => {
			await enableFor("spelling");
			const plugin = await loadPlugin();
			await plugin["tool.execute.after"](
				{ tool: "edit", callID: "c7", sessionID: "ses_1" },
				{ args: { filePath: "/work/tree/a.md" } },
			);
			expect(stdinOf("spelling").session_id).toBe("ses_1");
		});

		test("appends a PostToolUse hook's additional context to the tool output", async () => {
			await enableFor("format");
			writeFileSync(
				join(binDir(), "context"),
				JSON.stringify({
					hookSpecificOutput: {
						hookEventName: "PostToolUse",
						additionalContext: "format: biome failed (status 1)",
					},
				}),
			);
			const plugin = await loadPlugin();
			const output: Record<string, unknown> = {
				args: { filePath: "/work/tree/a.ts" },
				output: "edited",
			};
			await plugin["tool.execute.after"](
				{ tool: "edit", callID: "c8" },
				output,
			);
			expect(output.output).toBe("edited\n\nformat: biome failed (status 1)");
		});

		test("stops a hook that ignores SIGTERM and keeps its pipes open", async () => {
			await enableFor("pr-prose");
			writeFileSync(join(binDir(), "hang"), "");
			process.env["DG_HOOKS_TIMEOUT_MS"] = "200";
			const errors = spyOn(console, "error").mockImplementation(() => {});
			try {
				const plugin = await loadPlugin();
				const started = performance.now();
				await plugin["tool.execute.before"](
					{ tool: "bash", callID: "c10" },
					{ args: { command: "echo hi" } },
				);
				expect(performance.now() - started).toBeLessThan(2500);
				expect(String(errors.mock.calls[0]?.[0])).toContain(
					"dg hook pr-prose did not finish",
				);
			} finally {
				delete process.env["DG_HOOKS_TIMEOUT_MS"];
				errors.mockRestore();
			}
		});

		test("ignores additional context when the hook output is over the cap", async () => {
			await enableFor("format");
			writeFileSync(join(binDir(), "noisy"), "");
			const plugin = await loadPlugin();
			const output: Record<string, unknown> = {
				args: { filePath: "/work/tree/a.ts" },
				output: "edited",
			};
			await plugin["tool.execute.after"](
				{ tool: "edit", callID: "c11" },
				output,
			);
			expect(output.output).toBe("edited");
		});

		test("reports a hook killed by a signal without throwing", async () => {
			await enableFor("pr-prose");
			writeFileSync(join(binDir(), "signal"), "");
			const errors = spyOn(console, "error").mockImplementation(() => {});
			try {
				const plugin = await loadPlugin();
				await plugin["tool.execute.before"](
					{ tool: "bash", callID: "c9" },
					{ args: { command: "echo hi" } },
				);
				expect(errors).toHaveBeenCalledTimes(1);
				expect(String(errors.mock.calls[0]?.[0])).toContain(
					"dg hook pr-prose did not finish",
				);
			} finally {
				errors.mockRestore();
			}
		});
	},
);
