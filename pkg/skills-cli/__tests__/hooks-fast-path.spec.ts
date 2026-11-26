import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const CLI = join(import.meta.dir, "..", "src", "hooks", "cli.ts");

const DRIVER = `let touched = false;
Object.defineProperty(process, "stdin", { get() { touched = true; throw new Error("process.stdin read"); }, configurable: true });
const { main } = await import(${JSON.stringify(CLI)});
const code = await main(["run", "pr-confirm"]);
process.stdout.write("\\n" + JSON.stringify({ code, touched }));`;

describe("hooks run stdin", () => {
	test("reads the event with Bun.stdin and never touches process.stdin", () => {
		const proc = Bun.spawnSync([process.execPath, "-e", DRIVER], {
			stdout: "pipe",
			stderr: "pipe",
			stdin: Buffer.from(JSON.stringify({ tool_name: "Bash", tool_input: { command: "gh pr create" } })),
		});
		const [hookOut, summary] = proc.stdout.toString().split("\n");
		expect(JSON.parse(summary as string)).toEqual({ code: 0, touched: false });
		expect(JSON.parse(hookOut as string).hookSpecificOutput.permissionDecision).toBe("ask");
	});

	test("treats an empty stdin as an empty event", () => {
		const proc = Bun.spawnSync([process.execPath, "-e", DRIVER], { stdout: "pipe", stderr: "pipe", stdin: Buffer.from("") });
		const [hookOut, summary] = proc.stdout.toString().split("\n");
		expect(hookOut).toBe("");
		expect(JSON.parse(summary as string)).toEqual({ code: 0, touched: false });
	});
});
