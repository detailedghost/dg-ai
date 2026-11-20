import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	defaultRunSource,
	fetchSecret,
	type RunSource,
	SecretFetchError,
	type SecretSource,
} from "../../src/jobs/secret-sources";

const SOURCE: SecretSource = {
	type: "aws-secretsmanager",
	secretId: "prod/api",
	region: "us-east-1",
	profile: "p",
};
const AWS = "/fake/bin/aws";

type Call = { argv: string[]; env: Record<string, string | undefined>; cwd?: string; timeoutMs: number };

function fake(result: { code?: number; stdout?: string; stderr?: string }) {
	const calls: Call[] = [];
	const runSource: RunSource = async (argv, options) => {
		calls.push({ argv, ...options });
		return { code: result.code ?? 0, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
	};
	return {
		calls,
		deps: {
			which: (name: string) => (name === "aws" ? AWS : null),
			runSource,
			env: { PATH: "/fake/bin", AWS_X: "1" },
		},
	};
}

async function kindOf(run: () => Promise<unknown>): Promise<SecretFetchError> {
	try {
		await run();
	} catch (err) {
		if (err instanceof SecretFetchError) return err;
		throw err;
	}
	throw new Error("did not throw");
}

describe("fetchSecret", () => {
	it("runs the fixed argv with the profile, the caller env and a 30 s limit", async () => {
		const { calls, deps } = fake({ stdout: "v1\n" });

		const value = await fetchSecret(SOURCE, deps);

		expect(value).toBe("v1");
		expect(calls).toHaveLength(1);
		expect(calls[0].argv).toEqual([
			AWS,
			"secretsmanager",
			"get-secret-value",
			"--secret-id",
			"prod/api",
			"--region",
			"us-east-1",
			"--profile",
			"p",
			"--query",
			"SecretString",
			"--output",
			"text",
		]);
		expect(calls[0].env).toEqual(deps.env);
		expect(calls[0].timeoutMs).toBe(30_000);
	});

	it("leaves out --profile when the source has none", async () => {
		const { calls, deps } = fake({ stdout: "v1" });

		await fetchSecret({ ...SOURCE, profile: undefined }, deps);

		expect(calls[0].argv).not.toContain("--profile");
		expect(calls[0].argv.slice(-4)).toEqual(["--query", "SecretString", "--output", "text"]);
	});

	it("keeps the full text with no key, and removes only the last newline", async () => {
		const { deps } = fake({ stdout: '{"K":"v1"}\n\n' });
		expect(await fetchSecret(SOURCE, deps)).toBe('{"K":"v1"}\n');
	});

	it("takes the own string property of a key", async () => {
		const { deps } = fake({ stdout: '{"K":"v1","L":"v2"}\n' });
		expect(await fetchSecret({ ...SOURCE, key: "K" }, deps)).toBe("v1");
	});

	it("throws not-installed with no process when which finds no aws", async () => {
		const { calls, deps } = fake({});

		const err = await kindOf(() => fetchSecret(SOURCE, { ...deps, which: () => null }));

		expect(err.kind).toBe("not-installed");
		expect(calls).toHaveLength(0);
	});

	it("throws failed with the first sanitized stderr line for a non-zero exit", async () => {
		const { deps } = fake({ code: 254, stderr: "\nthe SSO session\u001b[31m expired\nsecond line\n" });

		const err = await kindOf(() => fetchSecret(SOURCE, deps));

		expect(err.kind).toBe("failed");
		expect(err.message).toBe("the SSO session\\u{1b}[31m expired");
	});

	it("falls back to the exit code when stderr is empty", async () => {
		const { deps } = fake({ code: 3 });
		expect((await kindOf(() => fetchSecret(SOURCE, deps))).message).toBe("exit 3");
	});

	it.each([["None\n"], [""], ["\n"]])("throws no-text for stdout %j", async (stdout) => {
		const { deps } = fake({ stdout });
		expect((await kindOf(() => fetchSecret(SOURCE, deps))).kind).toBe("no-text");
	});

	it("throws no-text for None also when a key is given", async () => {
		const { deps } = fake({ stdout: "None" });
		expect((await kindOf(() => fetchSecret({ ...SOURCE, key: "K" }, deps))).kind).toBe("no-text");
	});

	it("throws invalid-json with no part of stdout or of the parser message", async () => {
		const { deps } = fake({ stdout: "hunter2-not-json" });

		const err = await kindOf(() => fetchSecret({ ...SOURCE, key: "K" }, deps));

		expect(err.kind).toBe("invalid-json");
		expect(err.message).toBe("invalid-json");
	});

	it.each([
		['{"L":"v2"}'],
		['{"K":1}'],
		['{"K":null}'],
		["[]"],
		["3"],
		['{"__proto__":{"K":"v1"}}'],
	])("throws no-key when %s has no own string property K", async (stdout) => {
		const { deps } = fake({ stdout });

		const err = await kindOf(() => fetchSecret({ ...SOURCE, key: "K" }, deps));

		expect(err.kind).toBe("no-key");
		expect(err.message).not.toContain("v2");
	});

	it.each(["secretId", "region", "profile"] as const)(
		"refuses a %s that starts with a dash and starts no process",
		async (field) => {
			const { calls, deps } = fake({ stdout: "v1" });

			const err = await kindOf(() => fetchSecret({ ...SOURCE, [field]: "-x" }, deps));

			expect(err.kind).toBe("failed");
			expect(err.message).toBe(`the source "${field}" is not valid`);
			expect(calls).toHaveLength(0);
		},
	);

	it.each(["aws", "./aws", "bin/aws"])("refuses the aws path %p that is not absolute", async (path) => {
		const { calls, deps } = fake({ stdout: "v1" });

		const err = await kindOf(() => fetchSecret(SOURCE, { ...deps, which: () => path }));

		expect(err.kind).toBe("not-installed");
		expect(calls).toHaveLength(0);
	});

	it("lets a runSource timeout through as the timeout kind", async () => {
		const { deps } = fake({});
		const run = () =>
			fetchSecret(SOURCE, {
				...deps,
				runSource: async () => {
					throw new SecretFetchError("timeout", "timed out");
				},
			});
		expect((await kindOf(run)).kind).toBe("timeout");
	});

	it("wraps another thrown error as failed with one sanitized line", async () => {
		const { deps } = fake({});
		const run = () =>
			fetchSecret(SOURCE, {
				...deps,
				runSource: async () => {
					throw new Error("spawn aws ENOENT\nmore");
				},
			});
		const err = await kindOf(run);
		expect(err.kind).toBe("failed");
		expect(err.message).toBe("spawn aws ENOENT");
	});
});

const tmps: string[] = [];
const tmp = () => {
	const dir = mkdtempSync(join(tmpdir(), "dg-secret-"));
	tmps.push(dir);
	return dir;
};
function parsePid(text: string): number | undefined {
	const pid = /^\d+$/.test(text.trim()) ? Number(text) : Number.NaN;
	return Number.isInteger(pid) && pid > 1 ? pid : undefined;
}

const tryReadPid = (path: string): number | undefined =>
	existsSync(path) ? parsePid(readFileSync(path, "utf8")) : undefined;

async function readPid(path: string, ms = 1500): Promise<number> {
	const until = Date.now() + ms;
	for (;;) {
		const pid = tryReadPid(path);
		if (pid !== undefined) return pid;
		if (Date.now() > until) throw new Error(`no pid in ${path}`);
		await Bun.sleep(25);
	}
}

afterEach(async () => {
	for (const dir of tmps.splice(0)) {
		for (const file of ["pid", "gpid"]) {
			const path = join(dir, file);
			const pid = existsSync(path) ? await readPid(path, 300).catch(() => undefined) : undefined;
			if (pid !== undefined) {
				try {
					process.kill(pid, "SIGKILL");
				} catch {}
			}
		}
		rmSync(dir, { recursive: true, force: true });
	}
});

const alive = (pid: number): boolean => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

async function goneWithin(pid: number, ms = 3000): Promise<void> {
	const until = Date.now() + ms;
	while (alive(pid) && Date.now() < until) await Bun.sleep(25);
	expect(alive(pid)).toBe(false);
}

describe("defaultRunSource", () => {
	const program = (code: string) => [process.execPath, "-e", code];
	const options = (timeoutMs: number) => ({ env: { ...process.env }, timeoutMs });

	it("returns the code, stdout and stderr of a program", async () => {
		const result = await defaultRunSource(
			program('process.stdout.write("out"); process.stderr.write("err"); process.exit(3)'),
			options(10_000),
		);
		expect(result).toEqual({ code: 3, stdout: "out", stderr: "err" });
	});

	it("closes stdin so a program that reads it ends", async () => {
		const result = await defaultRunSource(
			program('const t = await Bun.stdin.text(); process.stdout.write(`[${t}]`)'),
			options(10_000),
		);
		expect(result.stdout).toBe("[]");
	});

	it("gives the env of the caller", async () => {
		const result = await defaultRunSource(
			program("process.stdout.write(process.env.ONLY_HERE ?? '')"),
			{ env: { ONLY_HERE: "yes", PATH: process.env.PATH }, timeoutMs: 10_000 },
		);
		expect(result.stdout).toBe("yes");
	});

	it("passes a shell metacharacter in argv as plain text", async () => {
		const text = "$(echo hi); `id` | cat";
		const result = await defaultRunSource(
			[...program("process.stdout.write(process.argv.at(-1) ?? '')"), text],
			options(10_000),
		);
		expect(result.stdout).toBe(text);
	});

	it("kills a program that sleeps past the limit and throws the timeout kind", async () => {
		const started = Date.now();
		const pidFile = join(tmp(), "pid");

		const err = await kindOf(() =>
			defaultRunSource(
				program(`require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setTimeout(() => {}, 60000)`),
				options(1500),
			),
		);

		expect(err.kind).toBe("timeout");
		expect(Date.now() - started).toBeLessThan(5000);
		await goneWithin(await readPid(pidFile));
	});

	it("stops a program whose stdout passes 128 KiB and throws the failed kind", async () => {
		const err = await kindOf(() =>
			defaultRunSource(
				program(
					'const chunk = "x".repeat(65536); for (let i = 0; i < 64; i++) process.stdout.write(chunk); setTimeout(() => {}, 60000)',
				),
				options(20_000),
			),
		);

		expect(err.kind).toBe("failed");
		expect(err.message).toContain("128 KiB");
	});

	it("accepts stdout of exactly 128 KiB", async () => {
		const result = await defaultRunSource(
			program('process.stdout.write("x".repeat(131072))'),
			options(10_000),
		);
		expect(result.stdout).toHaveLength(131072);
	});

	it("settles within the limit for a child that ignores TERM and a grandchild that holds stdout", async () => {
		const started = Date.now();
		const dir = tmp();
		const script = `trap '' TERM; (sleep 30 & echo $! > ${join(dir, "gpid")}); echo $$ > ${join(dir, "pid")}; sleep 30`;

		const err = await kindOf(() => defaultRunSource(["/bin/sh", "-c", script], options(1500)));

		expect(err.kind).toBe("timeout");
		expect(Date.now() - started).toBeLessThan(4000);
		await goneWithin(await readPid(join(dir, "pid")));
		await goneWithin(await readPid(join(dir, "gpid")));
	});
});
