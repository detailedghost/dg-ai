import { describe, expect, test } from "bun:test";
import { EXIT } from "../src/utils/legacy-command";

// ── EXIT constants ────────────────────────────────────────────────────────────

describe("EXIT", () => {
	test("OK is 0", () => expect(EXIT.OK).toBe(0));
	test("ERR is 1", () => expect(EXIT.ERR).toBe(1));
	test("USAGE is 2", () => expect(EXIT.USAGE).toBe(2));
	test("VALIDATION is 3", () => expect(EXIT.VALIDATION).toBe(3));
	test("UNSUPPORTED is defined and distinct from every other EXIT code", () => {
		expect(typeof EXIT.UNSUPPORTED).toBe("number");
		const values = [
			EXIT.OK,
			EXIT.ERR,
			EXIT.USAGE,
			EXIT.VALIDATION,
			EXIT.UNSUPPORTED,
		];
		expect(new Set(values).size).toBe(values.length);
	});
});

// ── die ───────────────────────────────────────────────────────────────────────

describe("die", () => {
	test("die() terminates with its explicit status", () => {
		// We verify the signature without calling it — invoking would kill the process.
		// Observe termination through a child process.
		const proc = Bun.spawnSync(
			[
				process.execPath,
				"--eval",
				`import { die } from "${import.meta.dir}/../src/utils/legacy-command"; die("boom", 2);`,
			],
			{ env: { ...process.env } },
		);
		expect(proc.exitCode).toBe(2);
		expect(proc.stderr.toString()).toContain("boom");
	});

	test("die() writes 'error: <msg>' to stderr with default code 1", () => {
		const proc = Bun.spawnSync(
			[
				process.execPath,
				"--eval",
				`import { die } from "${import.meta.dir}/../src/utils/legacy-command"; die("something failed");`,
			],
			{ env: { ...process.env } },
		);
		expect(proc.exitCode).toBe(1);
		expect(proc.stderr.toString()).toContain("error: something failed");
	});
});

// ── defineCommand dispatch ────────────────────────────────────────────────────

const helperScript = (extra: string) =>
	`
import { defineCommand } from "${import.meta.dir}/../src/utils/legacy-command";
const spec = {
  name: "test-cmd",
  description: "A test command",
  subcommands: {
    greet: {
      description: "Greet someone",
      args: ["name"],
      run: async (args, opts) => {
        if (opts.json) {
          process.stdout.write(JSON.stringify({ greeting: "hello", name: args[0] }) + "\\n");
        } else {
          process.stdout.write("hello " + (args[0] ?? "world") + "\\n");
        }
        return 0;
      },
    },
    fail: {
      description: "Always throws",
      run: async () => { throw new Error("intentional failure"); },
    },
  },
};
const cmd = defineCommand(spec);
${extra}
`;

function runCmd(argv: string[]) {
	const script = helperScript(`await cmd.run(${JSON.stringify(argv)});`);
	return Bun.spawnSync([process.execPath, "--eval", script], {
		env: { ...process.env },
	});
}

describe("defineCommand", () => {
	test("known subcommand runs and exits 0", () => {
		const proc = runCmd(["greet", "alice"]);
		expect(proc.exitCode).toBe(0);
		expect(proc.stdout.toString()).toContain("hello alice");
	});

	test("--json flag is forwarded to run() opts", () => {
		const proc = runCmd(["--json", "greet", "bob"]);
		expect(proc.exitCode).toBe(0);
		const out = JSON.parse(proc.stdout.toString().trim());
		expect(out.greeting).toBe("hello");
		expect(out.name).toBe("bob");
	});

	test("unknown subcommand exits with USAGE (2)", () => {
		const proc = runCmd(["nosuchsub"]);
		expect(proc.exitCode).toBe(EXIT.USAGE);
		expect(proc.stderr.toString()).toContain("unknown subcommand");
		expect(proc.stderr.toString()).toContain("nosuchsub");
	});

	test("no subcommand (bare invocation) exits with USAGE (2)", () => {
		const proc = runCmd([]);
		expect(proc.exitCode).toBe(EXIT.USAGE);
	});

	test("--help prints usage and exits 0 when subcommand also present", () => {
		const proc = runCmd(["greet", "--help"]);
		expect(proc.exitCode).toBe(EXIT.OK);
		expect(proc.stdout.toString()).toContain("Subcommands:");
	});

	test("-h alone exits OK and prints usage", () => {
		const proc = runCmd(["-h"]);
		expect(proc.exitCode).toBe(EXIT.OK);
		expect(proc.stdout.toString()).toContain("Subcommands:");
	});

	test("--help alone exits OK and prints usage", () => {
		const proc = runCmd(["--help"]);
		expect(proc.exitCode).toBe(EXIT.OK);
		expect(proc.stdout.toString()).toContain("Subcommands:");
	});

	test("subcommand that throws exits with ERR (1) and prints error", () => {
		const proc = runCmd(["fail"]);
		expect(proc.exitCode).toBe(EXIT.ERR);
		expect(proc.stderr.toString()).toContain("intentional failure");
	});

	test("usage output lists all subcommands", () => {
		const proc = runCmd(["--help", "greet"]);
		const out = proc.stdout.toString();
		expect(out).toContain("greet");
		expect(out).toContain("fail");
	});

	test("usage output includes --help and --json options", () => {
		const proc = runCmd(["--help", "greet"]);
		const out = proc.stdout.toString();
		expect(out).toContain("--help");
		expect(out).toContain("--json");
	});

	test("subcommand args listed in usage with angle brackets", () => {
		const proc = runCmd(["--help", "greet"]);
		expect(proc.stdout.toString()).toContain("<name>");
	});
});

function registered(extra: string, argv: string[], stdin?: string) {
	const script = helperScript(`
import { Command } from "commander";
import { registerLegacyCommand, registerRawCommand } from ${JSON.stringify(`${import.meta.dir}/../src/utils/legacy-command.ts`)};
const program = new Command().name("dg-skills").enablePositionalOptions();
${extra}
await program.parseAsync(${JSON.stringify(argv)}, { from: "user" });
`);
	return Bun.spawnSync([process.execPath, "--eval", script], {
		stdin: stdin === undefined ? undefined : Buffer.from(stdin),
		env: { ...process.env },
	});
}

describe("registerLegacyCommand", () => {
	test.each(
		[
			["greet", "alice"],
			["--json", "greet", "bob"],
			["greet", "--json", "bob"],
			["greet", "--custom=value", "-sGu"],
			["--", "greet", "alice"],
			["greet", "--", "alice"],
			["nosuchsub"],
			[],
			["greet", "--help"],
			["-h"],
			["fail"],
		].map((argv) => [argv]),
	)("preserves defineCommand streams and status for %j", (argv: string[]) => {
		const expected = runCmd(argv);
		const actual = registered("registerLegacyCommand(program, spec);", [
			"test-cmd",
			...argv,
		]);
		expect(actual.exitCode).toBe(expected.exitCode);
		expect(actual.stdout.toString()).toBe(expected.stdout.toString());
		expect(actual.stderr.toString()).toBe(expected.stderr.toString());
	});

	test.each([0, 1, 2, 3, 4, 124])(
		"preserves a handler's explicit status %i",
		(status) => {
			const proc = registered(
				`registerLegacyCommand(program, {
			name: "status",
			subcommands: { probe: { run: async () => ${status} } },
		});`,
				["status", "probe"],
			);
			expect(proc.exitCode).toBe(status);
			expect(proc.stdout.toString()).toBe("");
			expect(proc.stderr.toString()).toBe("");
		},
	);

	test("passes real stdin to handlers without consuming it during registration", () => {
		const input = "first line\nsecond line\n";
		const proc = registered(
			`registerLegacyCommand(program, {
			name: "input",
			subcommands: { echo: { run: async () => { process.stdout.write(await new Response(Bun.stdin).text()); } } },
		});`,
			["input", "echo"],
			input,
		);
		expect(proc.exitCode).toBe(0);
		expect(proc.stdout.toString()).toBe(input);
		expect(proc.stderr.toString()).toBe("");
	});
});

describe("registerRawCommand", () => {
	test.each(
		[["--", "--json", "tool"], ["tool", "--", "-sGu", ""], ["--"]].map(
			(argv) => [argv],
		),
	)("retains literal separators and operands for %j", (argv: string[]) => {
		const proc = registered(
			`registerRawCommand(program, {
			name: "raw",
			run: (args) => { process.stdout.write(JSON.stringify(args)); },
		});`,
			["raw", ...argv],
		);
		expect(proc.exitCode).toBe(0);
		expect(JSON.parse(proc.stdout.toString())).toEqual(argv);
		expect(proc.stderr.toString()).toBe("");
	});

	test("forwards custom short flags, equals options and their original ordering", () => {
		const argv = ["-sGu", "--dir=/example", "tool", "--json", "a/b"];
		const proc = registered(
			`registerRawCommand(program, {
			name: "raw",
			run: (args) => { process.stdout.write(JSON.stringify(args) + "\\n"); return 0; },
		});`,
			["raw", ...argv],
		);
		expect(proc.exitCode).toBe(0);
		expect(JSON.parse(proc.stdout.toString())).toEqual(argv);
		expect(proc.stderr.toString()).toBe("");
	});

	test.each([1, 2, 124])(
		"preserves raw callback status %i and exact streams",
		(status) => {
			const proc = registered(
				`registerRawCommand(program, {
			name: "raw",
			run: () => { process.stdout.write("out\\n"); process.stderr.write("err\\n"); return ${status}; },
		});`,
				["raw", "--custom"],
			);
			expect(proc.exitCode).toBe(status);
			expect(proc.stdout.toString()).toBe("out\n");
			expect(proc.stderr.toString()).toBe("err\n");
		},
	);

	test("registration is inert until commander dispatches that command", () => {
		const proc = registered(
			`registerRawCommand(program, {
			name: "raw",
			run: () => { throw new Error("unexpected dispatch"); },
		});`,
			["--help"],
		);
		expect(proc.exitCode).toBe(0);
		expect(proc.stdout.toString()).toContain("raw");
		expect(proc.stderr.toString()).toBe("");
	});
});

describe("legacy-command import isolation", () => {
	test("does not dispatch process.argv on import", () => {
		const proc = Bun.spawnSync(
			[
				process.execPath,
				"--eval",
				`await import(${JSON.stringify(`${import.meta.dir}/../src/utils/legacy-command.ts`)}); process.stdout.write("loaded\\n");`,
				"--",
				"nonexistent",
				"--json",
			],
			{ env: { ...process.env } },
		);
		expect(proc.exitCode).toBe(0);
		expect(proc.stdout.toString()).toBe("loaded\n");
		expect(proc.stderr.toString()).toBe("");
	});
});
