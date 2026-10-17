import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { cwdHash, projectHash } from "../../common/src/node/scratch-paths";
import { parseArgs } from "../src/stash/index";
import { scratchFixtures } from "./git-repo-fixtures";

setDefaultTimeout(30_000);

const CLI_TS = `${import.meta.dir}/../src/index.ts`;
const fixtures = scratchFixtures();
const tmp = (prefix: string) => fixtures.tmp(prefix);
const fixture = (ignore?: string) => fixtures.repo(ignore);
afterEach(() => fixtures.cleanup());

function stash(
	args: string[],
	cwd: string,
	env: { scratch: string; state: string; home: string },
) {
	const proc = Bun.spawnSync(
		[process.execPath, "run", CLI_TS, "stash", ...args],
		{
			cwd,
			env: {
				...process.env,
				AI_SCRATCH_DIR: env.scratch,
				AI_STATE_DIR: env.state,
				HOME: env.home,
				GIT_CONFIG_GLOBAL: "/dev/null",
				GIT_CONFIG_NOSYSTEM: "1",
				GIT_CONFIG_COUNT: "0",
				GIT_DIR: undefined,
				GIT_WORK_TREE: undefined,
			},
		},
	);
	return {
		out: proc.stdout.toString(),
		err: proc.stderr.toString(),
		code: proc.exitCode,
	};
}

describe("parseArgs", () => {
	test("accepts every short and long flag", () => {
		expect(parseArgs(["-s", "t"]).kind).toBe("state");
		expect(parseArgs(["--state", "t"]).kind).toBe("state");
		expect(parseArgs(["-a", "t"]).kind).toBe("agents");
		expect(parseArgs(["--agents", "t"]).kind).toBe("agents");
		expect(parseArgs(["-m", "t"]).kind).toBe("main");
		expect(parseArgs(["--main", "t"]).kind).toBe("main");
		expect(parseArgs(["--scratch", "t"]).kind).toBe("scratch");
		expect(parseArgs(["-G", "t"]).global).toBe(true);
		expect(parseArgs(["--global", "t"]).global).toBe(true);
		expect(parseArgs(["-u", "t"]).unique).toBe(true);
		expect(parseArgs(["--unique", "t"]).unique).toBe(true);
		expect(parseArgs(["-r"]).root).toBe(true);
		expect(parseArgs(["--root"]).root).toBe(true);
		expect(parseArgs(["-h"]).help).toBe(true);
		expect(parseArgs(["--help"]).help).toBe(true);
		expect(parseArgs(["-C", "/x", "t"]).dir).toBe("/x");
		expect(parseArgs(["--dir", "/x", "t"]).dir).toBe("/x");
	});

	test("expands combined short flags", () => {
		const parsed = parseArgs(["-sGu", "t", "n"]);
		expect([
			parsed.kind,
			parsed.global,
			parsed.unique,
			parsed.tool,
			parsed.name,
		]).toEqual(["state", true, true, "t", "n"]);
	});

	test("rejects conflicting roots, unknown flags, and extra arguments", () => {
		expect(() => parseArgs(["-s", "-a", "t"])).toThrow();
		expect(() => parseArgs(["--bogus"])).toThrow("unknown flag");
		expect(() => parseArgs(["a", "b", "c"])).toThrow("too many");
		expect(() => parseArgs(["-C"])).toThrow();
	});
});

describe("stash scratch and state", () => {
	test("default prints the cwd-hash dir and creates it with mode 0700", () => {
		const f = fixture();
		const r = stash(["demo"], f.main, f);
		expect(r.code).toBe(0);
		expect(r.out).toBe(`${join(f.scratch, "demo", cwdHash(f.main))}\n`);
		expect(statSync(r.out.trim()).isDirectory()).toBe(true);
		expect(statSync(join(f.scratch, "demo")).mode & 0o777).toBe(0o700);
		expect(r.err).toBe("");
	});

	test("--scratch matches the default and a name creates only the parent", () => {
		const f = fixture();
		const r = stash(["--scratch", "demo", "sub/x.mp4"], f.main, f);
		expect(r.out).toBe(
			`${join(f.scratch, "demo", cwdHash(f.main), "sub", "x.mp4")}\n`,
		);
		expect(existsSync(join(f.scratch, "demo", cwdHash(f.main), "sub"))).toBe(
			true,
		);
		expect(existsSync(r.out.trim())).toBe(false);
	});

	test("-s and --state key by the main worktree, so linked worktrees share a bucket", () => {
		const f = fixture();
		const expected = `${join(f.state, "address", projectHash(f.main))}\n`;
		expect(stash(["-s", "address"], f.main, f).out).toBe(expected);
		expect(stash(["--state", "address"], f.linked, f).out).toBe(expected);
	});

	test("scratch buckets differ between main and linked worktrees", () => {
		const f = fixture();
		expect(stash(["t"], f.main, f).out).not.toBe(stash(["t"], f.linked, f).out);
	});

	test("-G and --global drop the bucket for scratch and state", () => {
		const f = fixture();
		expect(stash(["-G", "viz"], f.main, f).out).toBe(
			`${join(f.scratch, "viz")}\n`,
		);
		expect(stash(["--global", "-s", "bg", "j.log"], f.main, f).out).toBe(
			`${join(f.state, "bg", "j.log")}\n`,
		);
	});

	test("works outside a git repo", () => {
		const f = fixture();
		const outside = tmp("stash-outside-");
		const r = stash(["-s", "demo"], outside, f);
		expect(r.code).toBe(0);
		expect(r.out).toBe(`${join(f.state, "demo", projectHash(outside))}\n`);
	});

	test("-C and --dir compute the bucket for another directory", () => {
		const f = fixture();
		expect(stash(["-C", f.linked, "pw"], f.main, f).out).toBe(
			`${join(f.scratch, "pw", cwdHash(f.linked))}\n`,
		);
		expect(stash(["--dir", f.linked, "-s", "pw"], f.main, f).out).toBe(
			`${join(f.state, "pw", projectHash(f.main))}\n`,
		);
	});

	test("makes an existing owned tool directory private", () => {
		const f = fixture();
		mkdirSync(join(f.scratch, "demo"), { mode: 0o755 });
		const r = stash(["demo"], f.main, f);
		expect(r.code).toBe(0);
		expect(r.out).toBe(`${join(f.scratch, "demo", cwdHash(f.main))}\n`);
		expect(r.err).toBe("");
		expect(statSync(join(f.scratch, "demo")).mode & 0o777).toBe(0o700);
	});
});

describe("stash --agents and --main", () => {
	test("-a prints the current worktree's .agents/<tool>", () => {
		const f = fixture();
		const r = stash(["-a", "prototype"], f.linked, f);
		expect(r.out).toBe(`${join(f.linked, ".agents", "prototype")}\n`);
		expect(r.err).toBe("");
		expect(stash(["--agents", "prototype", "n.md"], f.linked, f).out).toBe(
			`${join(f.linked, ".agents", "prototype", "n.md")}\n`,
		);
	});

	test("-m and --main print the main worktree's dir from a linked worktree", () => {
		const f = fixture();
		const expected = `${join(f.main, ".agents", "spec")}\n`;
		expect(stash(["-m", "spec"], f.linked, f).out).toBe(expected);
		expect(stash(["--main", "spec"], f.linked, f).out).toBe(expected);
	});

	test("-C resolves the worktree from another directory", () => {
		const f = fixture();
		expect(stash(["-a", "-C", f.linked, "t"], f.main, f).out).toBe(
			`${join(f.linked, ".agents", "t")}\n`,
		);
	});

	test("fails outside a worktree", () => {
		const f = fixture();
		const outside = tmp("stash-outside-");
		for (const flag of ["-a", "-m"]) {
			const r = stash([flag, "t"], outside, f);
			expect(r.code).toBe(1);
			expect(r.err).toBe("stash: not in a git worktree\n");
			expect(r.out).toBe("");
		}
	});

	test("warns once on stderr when the dir is not git-ignored, stdout unchanged", () => {
		const f = fixture("");
		const r = stash(["-a", "prototype"], f.main, f);
		expect(r.code).toBe(0);
		expect(r.out).toBe(`${join(f.main, ".agents", "prototype")}\n`);
		expect(r.err).toBe("stash: .agents/prototype is not git-ignored\n");
	});

	test("does not warn when ignored", () => {
		const f = fixture();
		expect(stash(["-m", "prototype"], f.linked, f).err).toBe("");
	});

	test("rejects -G with -a or -m", () => {
		const f = fixture();
		for (const flag of ["-a", "-m"]) {
			const r = stash(["-G", flag, "t"], f.main, f);
			expect(r.code).toBe(1);
			expect(r.err).toContain("--global");
		}
	});
});

describe("stash --root", () => {
	test("prints only the root, without a tool, and creates nothing", () => {
		const f = fixture();
		expect(stash(["-r"], f.main, f).out).toBe(`${f.scratch}\n`);
		expect(stash(["--root", "--scratch"], f.main, f).out).toBe(
			`${f.scratch}\n`,
		);
		expect(stash(["-r", "-s"], f.main, f).out).toBe(`${f.state}\n`);
		expect(stash(["-r", "-a"], f.linked, f).out).toBe(
			`${join(f.linked, ".agents")}\n`,
		);
		expect(stash(["-r", "-m"], f.linked, f).out).toBe(
			`${join(f.main, ".agents")}\n`,
		);
		expect(existsSync(join(f.main, ".agents"))).toBe(false);
	});
});

describe("stash --unique", () => {
	test("appends a unique name to the dir", () => {
		const f = fixture();
		const r = stash(["-u", "pw"], f.main, f);
		expect(r.out.trim()).toMatch(
			new RegExp(
				`^${join(f.scratch, "pw", cwdHash(f.main))}/pw-\\d{8}-\\d{4}-[a-z0-9]{4}$`,
			),
		);
	});

	test("a name becomes the suffix; an extension attaches directly", () => {
		const f = fixture();
		expect(stash(["--unique", "pw", ".zip"], f.main, f).out.trim()).toMatch(
			/\/pw-\d{8}-\d{4}-[a-z0-9]{4}\.zip$/,
		);
		expect(stash(["-u", "pw", "shot"], f.main, f).out.trim()).toMatch(
			/\/pw-\d{8}-\d{4}-[a-z0-9]{4}-shot$/,
		);
	});

	test("works with -a", () => {
		const f = fixture();
		expect(stash(["-u", "-a", "pw", ".png"], f.main, f).out.trim()).toMatch(
			/\.agents\/pw\/pw-\d{8}-\d{4}-[a-z0-9]{4}\.png$/,
		);
	});
});

describe("stash validation", () => {
	test("rejects traversal, absolute, and empty segments in tool and name", () => {
		const f = fixture();
		for (const args of [
			["..", "x"],
			["/abs"],
			["a//b"],
			["t", ".."],
			["t", "../x"],
			["t", "/etc/x"],
			["t", "a//b"],
			["t", "a/../b"],
		]) {
			const r = stash(args, f.main, f);
			expect(r.code).toBe(1);
			expect(r.out).toBe("");
			expect(r.err).toStartWith("stash: ");
		}
	});

	test("requires a tool unless -r", () => {
		const f = fixture();
		const r = stash([], f.main, f);
		expect(r.code).toBe(1);
		expect(r.err).toBe("stash: missing <tool>\n");
	});

	test("-h and --help print usage on stdout", () => {
		const f = fixture();
		for (const flag of ["-h", "--help"]) {
			const r = stash([flag], f.main, f);
			expect(r.code).toBe(0);
			expect(r.out).toContain("stash");
			expect(r.err).toBe("");
		}
	});
});

describe("stash import isolation", () => {
	test("importing registration and domain helpers neither dispatches argv nor creates roots", () => {
		const f = fixture();
		const scratch = join(f.scratch, "absent");
		const state = join(f.state, "absent");
		const script = `await import(${JSON.stringify(`${import.meta.dir}/../src/commands/stash.ts`)}); await import(${JSON.stringify(`${import.meta.dir}/../src/stash/index.ts`)}); process.stdout.write("imported\\n");`;
		const proc = Bun.spawnSync(
			[process.execPath, "--eval", script, "--", "-G", "probe"],
			{
				cwd: f.home,
				env: {
					...process.env,
					HOME: f.home,
					AI_SCRATCH_DIR: scratch,
					AI_STATE_DIR: state,
				},
			},
		);
		expect(proc.exitCode).toBe(0);
		expect(proc.stdout.toString()).toBe("imported\n");
		expect(proc.stderr.toString()).toBe("");
		expect(existsSync(scratch)).toBe(false);
		expect(existsSync(state)).toBe(false);
	});
});

describe("compiled stash", () => {
	test("matches source operations, help and literal separators outside the checkout without legacy PATH", () => {
		const f = fixture();
		const external = join(f.home, "external cwd");
		mkdirSync(external);
		const binary = join(tmp("stash-binary-"), "dg-skills");
		const build = Bun.spawnSync([
			process.execPath,
			"build",
			CLI_TS,
			"--compile",
			"--outfile",
			binary,
		]);
		expect(build.exitCode, build.stderr.toString()).toBe(0);
		const env = {
			...process.env,
			HOME: f.home,
			PATH: external,
			AI_SCRATCH_DIR: join(f.scratch, "uncreated"),
			AI_STATE_DIR: join(f.state, "uncreated"),
		};
		const run = (entry: string[], args: string[]) => {
			const proc = Bun.spawnSync([...entry, "stash", ...args], {
				cwd: external,
				env,
			});
			return {
				code: proc.exitCode,
				out: proc.stdout.toString(),
				err: proc.stderr.toString(),
			};
		};
		const source = [process.execPath, "run", CLI_TS];
		const help = run([binary], ["-a", "--help"]);
		expect(help).toEqual(run(source, ["-a", "--help"]));
		expect(help.code).toBe(0);
		expect(existsSync(env.AI_SCRATCH_DIR)).toBe(false);
		expect(existsSync(env.AI_STATE_DIR)).toBe(false);
		expect(existsSync(join(external, ".agents"))).toBe(false);
		const operation = run([binary], ["-G", "viz"]);
		expect(operation).toEqual(run(source, ["-G", "viz"]));
		expect(operation).toEqual({
			code: 0,
			out: `${join(env.AI_SCRATCH_DIR, "viz")}\n`,
			err: "",
		});
		expect(statSync(operation.out.trim()).isDirectory()).toBe(true);
		for (const args of [
			["--", "-G", "viz"],
			["-G", "--", "viz"],
		]) {
			const result = run([binary], args);
			expect(result).toEqual(run(source, args));
			expect(result).toEqual({
				code: 1,
				out: "",
				err: "stash: unknown flag --\n",
			});
		}
	});
});
