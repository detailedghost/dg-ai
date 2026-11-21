import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { completionScript } from "@dg/common/completion";
import { resolveDgPaths } from "@dg/common/node/dg-paths";
import { completionChecks } from "../src/completion/doctor";
import { completionFiles, completionState, removeCompletions, writeCompletions, zshHint } from "../src/completion/files";
import type { DoctorContext } from "../src/doctor/types";
import { fenceEnv } from "./fence-env";

const ENTRY = join(import.meta.dir, "..", "src", "index.ts");
const GENERATOR = join(import.meta.dir, "..", "..", "..", "scripts", "completion-trees.ts");
let bin = "";
let scratch = "";

beforeAll(() => {
	scratch = mkdtempSync(join(tmpdir(), "dg-completion-"));
	bin = join(scratch, "bin");
	mkdirSync(bin);
	const shim = join(bin, "dg");
	writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${ENTRY}" "$@"\n`);
	chmodSync(shim, 0o755);
});

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function complete(...words: string[]): string[] {
	const run = Bun.spawnSync([process.execPath, ENTRY, "__complete", ...words], { stdout: "pipe", stderr: "pipe" });
	expect(run.exitCode).toBe(0);
	return run.stdout
		.toString()
		.split("\n")
		.filter(Boolean)
		.map((line) => line.split("\t")[0] ?? "");
}

function shell(command: string[], script: string): string[] {
	const file = join(scratch, `script-${Math.random().toString(36).slice(2)}`);
	writeFileSync(file, script);
	const run = Bun.spawnSync([...command, file], {
		stdout: "pipe",
		stderr: "pipe",
		env: {
			PATH: `${bin}:${process.env.PATH ?? ""}`,
			HOME: scratch,
			...fenceEnv(),
		},
	});
	expect({ stderr: run.stderr.toString(), code: run.exitCode }).toEqual({ stderr: "", code: 0 });
	return run.stdout.toString().split("\n").filter(Boolean);
}

describe("the dg completion tree", () => {
	test("tree.json matches the registered commands; run bun scripts/completion-trees.ts after a command change", () => {
		const run = Bun.spawnSync([process.execPath, GENERATOR, "--check", "dg-skills"], { stdout: "pipe", stderr: "pipe" });
		expect(run.stderr.toString()).toBe("");
		expect(run.exitCode).toBe(0);
	}, 30_000);
});

describe("dg-skills __complete", () => {
	test("completes commands, nested commands, and the pw --ext verbs", () => {
		expect(complete("st")).toEqual(["stash", "stat"]);
		expect(complete("stat", "ch")).toEqual(["checklist"]);
		expect(complete("credentials", "re")).toEqual(["revoke"]);
		expect(complete("pw", "--ext", "sn")).toEqual(["snapshot"]);
		expect(complete("pw", "--ext", "--tab", "42", "sn")).toEqual(["snapshot"]);
		expect(complete("completion", "--in")).toEqual(["--install"]);
		expect(complete("completion", "f")).toEqual(["fish"]);
	});

	test("completes the adr verbs", () => {
		expect(complete("adr", "").sort()).toEqual(["find", "index", "init", "lint", "new", "relevant"]);
		expect(complete("adr", "re")).toEqual(["relevant"]);
	});

	test("is not a registered command, so help does not list it", () => {
		const run = Bun.spawnSync([process.execPath, ENTRY, "--help"], { stdout: "pipe" });
		expect(run.stdout.toString()).not.toContain("__complete");
	});
});

const which = (name: string): boolean => Bun.which(name) !== null;

describe("the completion scripts in a real shell", () => {
	test.skipIf(!which("bash"))("bash completes st to stat, stat ch to checklist, and an option value after an equals sign", () => {
		const script = `source /dev/stdin <<'EOF'\n${completionScript("bash", "dg")}EOF
for line in "dg st" "dg stat ch" "dg stat " "dg channel-review start --env=d"; do
	COMP_LINE="$line"
	COMP_POINT=\${#line}
	read -ra COMP_WORDS <<< "\${line//=/ = }"
	[[ "$line" == *" " ]] && COMP_WORDS+=("")
	COMP_CWORD=$((\${#COMP_WORDS[@]} - 1))
	_dg
	printf '%s\\n' "\${COMPREPLY[@]}"
done
`;
		expect(shell(["bash"], script)).toEqual(["stash", "stat", "checklist", "checklist", "add", "done", "status", "archive", "reap", "loops", "dev"]);
	});

	test.skipIf(!which("zsh"))("zsh autoloads the file from fpath, completes stat ch to checklist, and a path flag to files", () => {
		const dir = join(scratch, "site-functions");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "_dg"), completionScript("zsh", "dg"));
		const script = `fpath=(${dir} $fpath)
autoload -U _dg
compadd() { print -l -- "\${(@P)argv[-1]}" }
compdef() { : }
compset() { : }
_files() { print files }
words=(dg st); CURRENT=2; _dg
words=(dg stat ch); CURRENT=3; _dg
words=(dg install --repo ""); CURRENT=4; _dg
words=(dg install --repo=/x); CURRENT=3; PREFIX=--repo=/x; _dg
`;
		expect(shell(["zsh", "-f"], script)).toEqual(["stash", "stat", "checklist", "files", "files"]);
	});

	test.skipIf(!which("fish"))("fish completes stat ch to checklist", () => {
		const script = `${completionScript("fish", "dg")}
complete -C "dg st"
complete -C "dg stat ch"
complete -C "dg stat "
`;
		expect(shell(["fish", "--no-config"], script).map((line) => line.split("\t")[0])).toEqual([
			"stash",
			"stat",
			"checklist",
			"add",
			"checklist",
			"done",
			"status",
		]);
	});
});

describe("completion files", () => {
	const home = (): string => mkdtempSync(join(scratch, "home-"));

	test("go to the per-user shell folders, and follow XDG_DATA_HOME and XDG_CONFIG_HOME", () => {
		const paths = completionFiles({ env: {}, home: "/h", platform: "linux", binDir: "/h/none" });
		expect(paths.map((file) => file.path)).toEqual([
			"/h/.local/share/bash-completion/completions/dg",
			"/h/.local/share/zsh/site-functions/_dg",
			"/h/.config/fish/completions/dg.fish",
		]);
		const xdg = completionFiles({ env: { XDG_DATA_HOME: "/d", XDG_CONFIG_HOME: "/c" }, home: "/h", platform: "linux", binDir: "/h/none" });
		expect(xdg.map((file) => file.path)).toEqual([
			"/d/bash-completion/completions/dg",
			"/d/zsh/site-functions/_dg",
			"/c/fish/completions/dg.fish",
		]);
	});

	test("stay inside DG_HOME when it is set, and are skipped on Windows", () => {
		const paths = completionFiles({ env: { DG_HOME: "/g", XDG_DATA_HOME: "/d" }, home: "/h", platform: "linux" });
		expect(paths.every((file) => file.path.startsWith("/g/"))).toBe(true);
		expect(completionFiles({ env: {}, home: "/h", platform: "win32" })).toEqual([]);
	});

	test("are written for dg only, refreshed when stale, and removed", () => {
		const seams = { env: { PATH: "" }, home: home(), platform: "linux" as const, binDir: join(scratch, "no-bin") };
		const lines: string[] = [];
		expect(writeCompletions(seams, (line) => lines.push(line))).toHaveLength(3);
		expect(completionFiles(seams).map(completionState)).toEqual(Array(3).fill("current"));
		expect(writeCompletions(seams, () => undefined)).toEqual([]);

		const [first] = completionFiles(seams);
		writeFileSync(first?.path ?? "", "old");
		expect(completionState(first ?? completionFiles(seams)[0]!)).toBe("stale");
		expect(writeCompletions(seams, () => undefined)).toEqual([first?.path]);

		expect(removeCompletions(seams, () => undefined)).toHaveLength(3);
		expect(completionFiles(seams).some((file) => existsSync(file.path))).toBe(false);
	});

	test("removal keeps a file that dg did not write", () => {
		const seams = { env: { PATH: "" }, home: home(), platform: "linux" as const };
		const [file] = completionFiles(seams);
		mkdirSync(join(file?.path ?? "", ".."), { recursive: true });
		writeFileSync(file?.path ?? "", "complete -W 'mine' dg\n");
		removeCompletions(seams, () => undefined);
		expect(readFileSync(file?.path ?? "", "utf8")).toContain("mine");
	});

	test.skipIf(!which("zsh"))("the zsh hint names the folder unless FPATH has it", () => {
		const path = process.env.PATH;
		expect(zshHint("/x/site-functions", { PATH: path })).toContain("fpath=(/x/site-functions $fpath)");
		expect(zshHint("/x/site-functions", { PATH: path, FPATH: "/a:/x/site-functions" })).toBeUndefined();
	});
});

describe("dg completion", () => {
	test("prints the script for a shell", () => {
		const run = Bun.spawnSync([process.execPath, ENTRY, "completion", "bash"], { stdout: "pipe" });
		expect(run.stdout.toString()).toBe(completionScript("bash", "dg"));
	});

	test("--install writes the files under the test DG_HOME", () => {
		const dgHome = mkdtempSync(join(scratch, "dg-home-"));
		const run = Bun.spawnSync([process.execPath, ENTRY, "completion", "--install"], {
			stdout: "pipe",
			stderr: "pipe",
			env: { ...process.env, DG_HOME: dgHome, PATH: "" },
		});
		expect(run.exitCode).toBe(0);
		expect(existsSync(join(dgHome, "share", "bash-completion", "completions", "dg"))).toBe(true);
		expect(existsSync(join(dgHome, "config", "fish", "completions", "dg.fish"))).toBe(true);
		expect(existsSync(join(dgHome, "share", "bash-completion", "completions", "dg-daemon"))).toBe(false);
		expect(existsSync(join(dgHome, "config", "fish", "completions", "dg-agent.fish"))).toBe(false);
	});

	test("rejects --install with --uninstall, and a missing shell", () => {
		for (const args of [["--install", "--uninstall"], []]) {
			const run = Bun.spawnSync([process.execPath, ENTRY, "completion", ...args], { stdout: "pipe", stderr: "pipe" });
			expect(run.exitCode).toBe(2);
		}
	});
});

describe("doctor completion", () => {
	const context = (home: string): DoctorContext => ({ home, env: { PATH: "" }, paths: resolveDgPaths({ homeDir: home, env: {} }) }) as unknown as DoctorContext;

	test("warns about missing files with the install fix, then reports them current", async () => {
		const home = mkdtempSync(join(scratch, "doctor-"));
		const [files] = completionChecks;
		const missing = await files?.run(context(home));
		expect(missing).toMatchObject({ status: "warn", fix: "dg completion --install" });
		writeCompletions({ env: { PATH: "" }, home }, () => undefined);
		expect((await files?.run(context(home)))?.status).toBe("ok");
	});
});
