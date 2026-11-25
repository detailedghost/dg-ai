import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

type Node = {
	name: string;
	options?: { flags: string[] }[];
	commands?: Node[];
};

const tree = JSON.parse(
	readFileSync(join(import.meta.dir, "..", "src", "completion-tree.json"), "utf8"),
) as Node;
const job = tree.commands?.find((command) => command.name === "job") as Node;
const verb = (name: string) => job.commands?.find((c) => c.name === name);
const flagsOf = (node: Node | undefined): string[] =>
	(node?.options ?? []).flatMap((option) => option.flags);

describe("the job group in the completion tree", () => {
	it("lists each verb of the group", () => {
		const names = (job.commands ?? []).map((command) => command.name);

		for (const name of [
			"add",
			"list",
			"status",
			"enable",
			"disable",
			"start",
			"stop",
			"restart",
			"update",
			"remove",
			"logs",
		]) {
			expect(names).toContain(name);
		}
	});

	it("has no entry for rm, run, exec, --label, --cron or --pass-env", () => {
		const names = (job.commands ?? []).map((command) => command.name);
		const allFlags = (job.commands ?? []).flatMap((command) => flagsOf(command));

		for (const old of ["rm", "run", "exec"]) expect(names).not.toContain(old);
		for (const old of ["--label", "--cron", "--pass-env"]) {
			expect(allFlags).not.toContain(old);
		}
	});

	it("has no service group", () => {
		const names = (tree.commands ?? []).map((command) => command.name);

		expect(names).not.toContain("service");
	});

	it("gives add the new flags and --credential but no --grant", () => {
		const flags = flagsOf(verb("add"));

		for (const flag of [
			"--name",
			"--cwd",
			"--continuous",
			"--schedule",
			"--every",
			"--timeout",
			"--feed",
			"--notify",
			"--env-file",
			"--env",
			"--stop-timeout",
			"--credential",
		]) {
			expect(flags).toContain(flag);
		}
		expect(flags).not.toContain("--grant");
	});

	it("gives logs the lines and follow options", () => {
		const flags = flagsOf(verb("logs"));

		for (const flag of ["-n", "--lines", "-f", "--follow"]) {
			expect(flags).toContain(flag);
		}
	});

	it("gives list and status the --json option", () => {
		expect(flagsOf(verb("list"))).toContain("--json");
		expect(flagsOf(verb("status"))).toContain("--json");
	});
});
