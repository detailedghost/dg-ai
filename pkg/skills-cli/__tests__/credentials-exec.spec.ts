import { describe, expect, test } from "bun:test";
import type { CredentialRecord } from "@dg/common";
import { Command } from "commander";
import {
	type CredentialsDeps,
	type SpawnedChild,
	registerCredentials,
	spawnChild,
} from "../src/credentials/cli";
import { createScrubber, scrubText } from "../src/credentials/scrub";

const marker = "fake-marker-value-for-tests";
const record: CredentialRecord = { value: marker, meta: {}, updatedAt: "2026-01-01T00:00:00.000Z" };

const forms = [
	marker,
	Buffer.from(marker).toString("base64"),
	Buffer.from(marker).toString("base64").replace(/=+$/, ""),
	Buffer.from(marker).toString("base64url"),
	Buffer.from(marker).toString("base64url").replace(/=+$/, ""),
	encodeURIComponent(marker),
	new URLSearchParams({ v: marker }).toString().slice(2),
];

const childScript = `
const v = process.argv[1];
const x = process.env.PW_TEST_TOKEN;
const out = (s) => process.stdout.write(s + "\\n");
out("env=" + x);
out("arg=" + v);
out("b64=" + Buffer.from(v).toString("base64"));
out("b64u=" + Buffer.from(v).toString("base64url"));
out("uri=" + encodeURIComponent(v));
out("form=" + new URLSearchParams({ v }).toString().slice(2));
process.stdout.write("split=" + v.slice(0, 9));
await Bun.sleep(60);
process.stdout.write(v.slice(9) + "\\n");
process.stderr.write("err=" + v + "\\n");
process.exit(Number(process.env.EXIT ?? 0));
`;

function harness(
	options: {
		get?: (name: string) => Promise<CredentialRecord | undefined>;
		spawn?: CredentialsDeps["spawn"];
		list?: () => Promise<never[]>;
	} = {},
) {
	const out: string[] = [];
	const err: string[] = [];
	const lines: string[] = [];
	const codes: number[] = [];
	const gets: string[] = [];
	const deps: CredentialsDeps = {
		createClient: () => ({
			set: async () => {},
			get:
				options.get ??
				(async (name) => {
					gets.push(name);
					return name === "test/marker" ? record : undefined;
				}),
			list: options.list ?? (async () => []),
			delete: async () => true,
			grant: async () => ({ prefix: "p", path: "/x" }),
			revoke: async () => true,
			listGrants: async () => [],
			close: () => {},
		}),
		readValue: async () => marker,
		write: (line) => lines.push(line),
		now: () => new Date(),
		spawn: options.spawn ?? spawnChild,
		stdout: (text) => out.push(text),
		stderr: (text) => err.push(text),
		exit: (code) => codes.push(code),
	};
	const run = (args: string[]) => {
		const program = new Command().exitOverride().enablePositionalOptions();
		program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
		registerCredentials(program, deps);
		return program.parseAsync(["credentials", ...args], { from: "user" });
	};
	return { run, out, err, lines, codes, gets };
}

async function failure(promise: Promise<unknown>): Promise<string> {
	try {
		await promise;
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
	throw new Error("expected the command to fail");
}

describe("credentials exec", () => {
	test("gives the child the value by env var and placeholder, and scrubs every form from its output", async () => {
		const cli = harness();
		await cli.run([
			"exec",
			"test/marker=PW_TEST_TOKEN",
			"--",
			"bun",
			"-e",
			childScript,
			"{{cred:test/marker}}",
		]);
		const stdout = cli.out.join("");
		const stderr = cli.err.join("");
		expect(stdout).toContain("env=[redacted]");
		expect(stdout).toContain("arg=[redacted]");
		expect(stdout).toContain("split=[redacted]");
		expect(stderr).toContain("err=[redacted]");
		for (const form of forms) {
			expect(stdout).not.toContain(form);
			expect(stderr).not.toContain(form);
		}
		expect(cli.codes).toEqual([0]);
	});

	test("derives the env var from a bare name", async () => {
		const cli = harness();
		await cli.run([
			"exec",
			"test/marker",
			"--",
			"bun",
			"-e",
			"process.stdout.write(Object.keys(process.env).filter((k) => k === 'TEST_MARKER').join())",
		]);
		expect(cli.out.join("")).toBe("TEST_MARKER");
	});

	test("passes the child exit code through", async () => {
		const cli = harness();
		await cli.run(["exec", "test/marker", "--", "bun", "-e", "process.exit(7)"]);
		expect(cli.codes).toEqual([7]);
	});

	test("maps a signal exit to 128 plus the signal number", async () => {
		const cli = harness();
		await cli.run(["exec", "test/marker", "--", "sh", "-c", "kill -TERM $$"]);
		expect(cli.codes).toEqual([143]);
	});

	test("fetches a placeholder credential that is not listed before --", async () => {
		const cli = harness();
		await cli.run(["exec", "--", "bun", "-e", "process.stdout.write(process.argv[1])", "{{cred:test/marker}}"]);
		expect(cli.gets).toEqual(["test/marker"]);
		expect(cli.out.join("")).toBe("[redacted]");
	});

	describe("failure paths never print a value", () => {
		const cases: [string, string[], Parameters<typeof harness>[0]?][] = [
			["missing credential", ["exec", "nope/missing", "--", "true"]],
			["missing credential in a placeholder", ["exec", "--", "echo", "{{cred:nope/missing}}"]],
			[
				"store error",
				["exec", "test/marker", "--", "true"],
				{
					get: async () => {
						throw new Error(`store down while holding ${marker}`);
					},
				},
			],
			["bad env name", ["exec", `test/marker=1BAD-${marker}`, "--", "true"]],
			["missing separator", ["exec", "test/marker", "true"]],
			["missing command", ["exec", "test/marker", "--"]],
			[
				"spawn failure",
				["exec", "test/marker", "--", "tool", "{{cred:test/marker}}"],
				{
					spawn: () => {
						throw new Error(`ENOENT tool ${marker}`);
					},
				},
			],
		];
		test.each(cases)("%s", async (_label, args, options) => {
			const cli = harness(options);
			const message = await failure(cli.run(args));
			expect(message.length).toBeGreaterThan(0);
			for (const form of forms) expect(message).not.toContain(form);
			expect([...cli.out, ...cli.err, ...cli.lines].join("")).not.toContain(marker);
		});
	});

	test("help text carries the usage line and no value", () => {
		const root = new Command();
		registerCredentials(root, {
			createClient: () => {
				throw new Error("unused");
			},
			readValue: async () => marker,
			write: () => {},
			now: () => new Date(),
		});
		const exec = root.commands
			.find((c) => c.name() === "credentials")
			?.commands.find((c) => c.name() === "exec");
		const help = exec?.helpInformation() ?? "";
		expect(help).toContain("exec <name>[=ENV_VAR]... -- <command...>");
		expect(help).not.toContain(marker);
	});

	test("list output never contains a stored value", async () => {
		const cli = harness({
			list: async () =>
				[
					{ name: "test/marker", meta: { provider: "example" }, updatedAt: "2026-01-01T00:00:00.000Z" },
				] as never[],
		});
		await cli.run(["list"]);
		expect(cli.lines.join("")).toContain("test/marker");
		expect(cli.lines.join("")).not.toContain(marker);
	});
});

describe("scrubber", () => {
	test("replaces every form and skips forms under four characters", () => {
		const text = forms.join(" | ");
		expect(scrubText(text, [marker]).replaceAll("[redacted]", "")).toBe(" |  |  |  |  |  | ");
		expect(scrubText("abc abc", ["abc"])).toBe("abc abc");
	});

	test("replaces lowercase-hex percent forms", () => {
		const value = "a b/c+d=e:f-test";
		const encoded = encodeURIComponent(value).replace(/%[0-9A-F]{2}/g, (h) => h.toLowerCase());
		expect(scrubText(`x ${encoded} y`, [value])).toBe("x [redacted] y");
	});

	test("catches a value split at every chunk boundary", () => {
		const text = `before ${marker} after`;
		for (let cut = 1; cut < text.length; cut++) {
			const scrubber = createScrubber([marker]);
			const joined = scrubber.push(text.slice(0, cut)) + scrubber.push(text.slice(cut)) + scrubber.flush();
			expect(joined).toBe("before [redacted] after");
		}
	});
});
