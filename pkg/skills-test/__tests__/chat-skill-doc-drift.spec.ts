import { describe, expect, test } from "bun:test";
import { readRepoFile } from "./test-support";

describe("the chat SKILL.md does not drift from the daemon's real surface", () => {
	const skill = readRepoFile("plugins", "dg", "skills", "chat", "SKILL.md");
	const errors = readRepoFile("pkg", "common", "src", "errors.ts");
	const agentCmds = readRepoFile("pkg", "dg-agent", "src", "commands.ts");
	const entry = readRepoFile("pkg", "dg-agent", "src", "index.ts");

	function declaredCommands(...sources: string[]): string[] {
		return sources
			.flatMap((src) => [...src.matchAll(/\.command\("([^"]+)"/g)])
			.map((m) => m[1])
			.filter((name) => !name.startsWith("__"));
	}

	test("every non-hidden command the CLI registers is documented", () => {
		const commands = declaredCommands(agentCmds, entry);
		expect(commands.length).toBeGreaterThan(5);
		for (const name of commands) {
			expect(skill).toMatch(new RegExp(`\`${name}[ \`]`));
		}
	});

	test("every exit code the daemon defines is listed with its number", () => {
		const codes = [...errors.matchAll(/EXIT_([A-Z_]+)\s*=\s*(\d+)/g)].map(
			(m) => m[2],
		);
		expect(codes.length).toBeGreaterThan(4);
		for (const code of codes) {
			expect(skill).toMatch(new RegExp(`\\|\\s*${code}\\s*\\|`));
		}
	});

	test("the reserved recv timeout code is documented as the loop-on signal", () => {
		const timeout = errors.match(/EXIT_RECV_TIMEOUT\s*=\s*(\d+)/)?.[1];
		expect(timeout).toBeDefined();
		expect(skill).toMatch(
			new RegExp(
				`Code\\s+${timeout}\\s+is\\s+the\\s+one\\s+to\\s+branch\\s+on`,
			),
		);
	});

	test("every flag the recv, progress and manifest commands take is documented", () => {
		for (const flag of [
			"--block",
			"--timeout",
			"--state",
			"--commands",
			"--subagents",
			"--workset",
			"--orchestrator",
			"--open",
		]) {
			expect(skill).toContain(flag);
		}
	});

	test("the documented recv timeout default matches the CLI's own default", () => {
		const def = agentCmds.match(/DEFAULT_RECV_TIMEOUT_MS\s*=\s*([\d_]+)/)?.[1];
		expect(def).toBeDefined();
		const ms = Number((def as string).replace(/_/g, ""));
		expect(skill).toMatch(new RegExp(`${ms}\\s*ms`));
	});

	test("progress states are documented exactly as the CLI validates them", () => {
		expect(agentCmds).toContain('options.state !== "running"');
		expect(agentCmds).toContain('options.state !== "awaiting-input"');
		expect(skill).toMatch(/running\|awaiting-input/);
	});
});
