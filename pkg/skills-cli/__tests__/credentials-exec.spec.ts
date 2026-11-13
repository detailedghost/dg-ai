import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CredentialExecSpec } from "@dg/common";
import { Command } from "commander";
import { type CredentialsDeps, registerCredentials } from "../src/credentials/cli";

const marker = "fake-marker-value-for-tests";

function harness(reply: (spec: CredentialExecSpec, emit: (stream: "stdout" | "stderr", data: string) => void) => Promise<number>) {
	const out: string[] = [];
	const err: string[] = [];
	const specs: CredentialExecSpec[] = [];
	let exitCode: number | undefined;
	const client = {
		set: async () => undefined,
		list: async () => [{ name: "pw/live.com/owa-auth", meta: { site: "https://outlook.live.com" }, updatedAt: "2026-11-13T00:00:00.000Z" }],
		delete: async () => true,
		grant: async () => ({ prefix: "x", path: "/x" }),
		revoke: async () => true,
		listGrants: async () => [],
		exec: async (spec: CredentialExecSpec, emit: (stream: "stdout" | "stderr", data: string) => void) => {
			specs.push(spec);
			return reply(spec, emit);
		},
		close: () => undefined,
	};
	const deps: CredentialsDeps = {
		createClient: () => client,
		readValue: async () => "",
		write: (line) => out.push(line),
		now: () => new Date("2026-11-13T00:00:00Z"),
		stdout: (text) => out.push(text),
		stderr: (text) => err.push(text),
		exit: (code) => {
			exitCode = code;
		},
	};
	const run = async (args: string[]) => {
		const program = new Command().exitOverride().configureOutput({ writeOut: (t) => out.push(t), writeErr: (t) => err.push(t) });
		registerCredentials(program, deps);
		try {
			await program.parseAsync(["node", "dg-skills", "credentials", ...args]);
		} catch (error) {
			err.push(error instanceof Error ? error.message : String(error));
		}
	};
	return { run, out, err, specs, exit: () => exitCode, client };
}

describe("credentials exec", () => {
	test("sends names, command, cwd and env to the daemon and holds no value", async () => {
		const h = harness(async (_, emit) => {
			emit("stdout", "len=27 [redacted]\n");
			emit("stderr", "warn\n");
			return 3;
		});
		await h.run(["exec", "pw/live.com/owa-auth=TOKEN", "other/name", "--", "sh", "-c", 'echo "$TOKEN"']);
		expect(h.specs).toEqual([
			{
				bindings: [
					{ name: "pw/live.com/owa-auth", env: "TOKEN" },
					{ name: "other/name", env: "OTHER_NAME" },
				],
				argv: ["sh", "-c", 'echo "$TOKEN"'],
				cwd: process.cwd(),
				env: expect.any(Object),
			},
		]);
		expect(h.out.join("")).toBe("len=27 [redacted]\n");
		expect(h.err.join("")).toBe("warn\n");
		expect(h.exit()).toBe(3);
		expect("get" in h.client).toBe(false);
	});

	test("refuses --session after exec and says where it goes", async () => {
		const h = harness(async () => 0);
		await h.run(["exec", "pw/x/y=X", "--session", "session-a", "--", "true"]);
		expect(h.specs).toEqual([]);
		expect(h.err.join("\n")).toContain("Put --session before exec");
	});

	test.each([
		[["exec", "pw/x/y"], "Put -- between"],
		[["exec", "--", "echo"], "Name at least one credential"],
		[["exec", "pw/x/y", "--"], "Give a command"],
		[["exec", "pw/x/y=1BAD", "--", "echo"], ""],
	])("refuses %p before it calls the daemon", async (args, message) => {
		const h = harness(async () => 0);
		await h.run(args);
		expect(h.specs).toEqual([]);
		expect(h.err.join("\n")).toContain(message);
		expect([...h.out, ...h.err].join("\n")).not.toContain(marker);
	});

	test("prints a daemon error and no value", async () => {
		const h = harness(async () => {
			throw new Error("No credential named pw/x/y.");
		});
		await h.run(["exec", "pw/x/y=X", "--", "echo"]);
		expect(h.err.join("\n")).toContain("No credential named pw/x/y.");
	});

	test("list output never contains a stored value", async () => {
		const h = harness(async () => 0);
		await h.run(["list"]);
		expect(h.out.join("\n")).toContain("pw/live.com/owa-auth");
		expect(h.out.join("\n")).not.toContain(marker);
	});
});

describe("credentials allow", () => {
	test("prints a pinned line and writes no file", async () => {
		const dir = realpathSync(mkdtempSync(join(tmpdir(), "dg-allow-cli-")));
		const script = join(dir, "show-len");
		writeFileSync(script, "#!/bin/sh\necho ok\n");
		chmodSync(script, 0o755);
		const before = new Set(require("node:fs").readdirSync(dir));
		const h = harness(async () => 0);
		await h.run(["allow", script, "pw/live.com/*"]);
		expect(h.out.join("\n")).toMatch(new RegExp(`^${script} sha256=[0-9a-f]{64} pw/live.com/\\*$`));
		expect(new Set(require("node:fs").readdirSync(dir))).toEqual(before);
		expect(existsSync(join(dir, "exec-allowlist"))).toBe(false);
		rmSync(dir, { recursive: true, force: true });
	});
});
