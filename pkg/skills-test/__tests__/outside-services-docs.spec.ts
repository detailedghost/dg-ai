import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { count, REPO_ROOT, readRepoFile } from "./test-support";

const ADR_FILE = "0043-outside-services.md";
const ADR_PATH = join("docs", "adr", ADR_FILE);
const CHANGED_DOCS = [
	ADR_PATH,
	join("docs", "adr", "toc.md"),
	join("docs", "jobs-and-services.md"),
	join("docs", "service-api.md"),
	join("docs", "AGENT-INSTALL.md"),
	join("docs", "DEVELOPER.md"),
	join("plugins", "dg", "skills", "jobs", "SKILL.md"),
	"SECURITY.md",
	"README.md",
];

function read(path: string): string {
	return existsSync(join(REPO_ROOT, path)) ? readRepoFile(path) : "";
}

function source(...parts: string[]): string {
	return readRepoFile("pkg", ...parts);
}

function heading(text: string, title: string): string {
	const lines = text.split("\n");
	const start = lines.findIndex(
		(l) => l.replace(/^#+ /, "").trim() === title && /^#+ /.test(l),
	);
	if (start < 0) return "";
	const level = /^#+/.exec(lines[start])?.[0].length ?? 1;
	const rest = lines.slice(start + 1);
	const end = rest.findIndex((l) => {
		const h = /^(#{1,6}) /.exec(l)?.[1].length;
		return h !== undefined && h <= level;
	});
	return (end < 0 ? rest : rest.slice(0, end)).join("\n");
}

function paragraphWith(text: string, needle: string): string {
	return text.split(/\n\s*\n/).find((p) => p.includes(needle)) ?? "";
}

function gitBase(): string | undefined {
	for (const ref of ["origin/master", "master"]) {
		const r = Bun.spawnSync(["git", "rev-parse", "--verify", "--quiet", ref], {
			cwd: REPO_ROOT,
		});
		if (r.exitCode === 0) return ref;
	}
	return undefined;
}

describe("ADR 0043 outside services", () => {
	const adr = read(ADR_PATH);
	const toc = read("docs/adr/toc.md");

	test("toc lists the record exactly once and the file exists", () => {
		expect(count(toc, `(${ADR_FILE})`)).toBe(1);
		expect(existsSync(join(REPO_ROOT, ADR_PATH))).toBe(true);
	});

	test("toc entry is last in Platform, within 160 columns, with the Accepted form", () => {
		const platform = heading(toc, "Platform");
		const entries = platform.split("\n").filter((l) => l.startsWith("- ["));
		const last = entries.at(-1) ?? "";
		expect(last).toMatch(
			/^- \[0043 — .+\]\(0043-outside-services\.md\) — Accepted:/,
		);
		for (const line of platform.split("\n"))
			expect(line.length).toBeLessThanOrEqual(160);
	});

	test("has template headings, Accepted status and a commit date", () => {
		for (const h of [
			"Context",
			"Decision",
			"Consequences",
			"Alternatives considered",
			"Diagrams",
			"References",
		])
			expect(adr).toMatch(new RegExp(`^## ${h}$`, "m"));
		expect(adr).toMatch(/^Status: Accepted$/m);
		expect(adr).toMatch(/^Date: \d{4}-\d{2}-\d{2}$/m);
	});

	test("holds exactly one mermaid block naming the five participants", () => {
		expect(count(adr, "```mermaid")).toBe(1);
		const block = adr.split("```mermaid")[1]?.split("```")[0] ?? "";
		for (const p of ["dg-daemon", "service-api", "grants"])
			expect(block).toContain(p);
		expect(block.toLowerCase()).toContain("credential");
		expect(block.toLowerCase()).toContain("outside service");
	});

	test("describes the design and its decisions", () => {
		for (const w of [
			"passEnv",
			"stopTimeoutMs",
			"grant",
			"dg-daemon start",
			"dg-daemon stop",
			"dg-daemon restart",
			"--force",
			"provisional",
			"not a sandbox",
			"isBrowserOrigin",
			"0002",
			"0006",
			"an outside service",
		])
			expect(adr).toContain(w);
		expect(adr).toMatch(/Origin: null/);
	});

	test("links the references of slices 1 to 4", () => {
		for (const f of [
			"pkg/dg-daemon/src/services/config.ts",
			"pkg/dg-daemon/src/services/supervisor.ts",
			"pkg/dg-daemon/src/dispatch/exec.ts",
			"pkg/dg-daemon/src/server/service-api.ts",
			"pkg/dg-daemon/src/server/credentials.ts",
			"pkg/dg-daemon/src/commands/stop.ts",
			"pkg/common/src/node/daemon-start.ts",
			"pkg/common/src/chat-format.ts",
			"docs/service-api.md",
		])
			expect(heading(adr, "References")).toContain(f);
	});

	test("does not deprecate ADR 0020 or ADRs 0008 to 0019", () => {
		expect(adr).not.toMatch(/supersede[sd]? (ADR )?0020/i);
		expect(toc).not.toMatch(/00(0[89]|1\d)[^\n]*Deprecated/);
	});
});

describe("docs/jobs-and-services.md", () => {
	const doc = read("docs/jobs-and-services.md");

	test("has no ~/.dg path and gives the per-OS locations", () => {
		expect(doc).not.toContain("~/.dg");
		for (const p of [
			"<state>/daemon/config.json",
			"<log>/service-<label>.log",
			"<state>/daemon/services/<label>.pid",
			"~/.local/state/dg/daemon/config.json",
			"~/.local/state/dg/log/service-<label>.log",
			"install.md#where-dg-keeps-its-files",
		])
			expect(doc).toContain(p);
	});

	test("gives run steps in order", () => {
		const order = [
			"service add",
			"dg-daemon start",
			"dg-daemon service start",
			"service status --json",
		].map((s) => doc.indexOf(s));
		for (const i of order) expect(i).toBeGreaterThanOrEqual(0);
		expect([...order].sort((a, b) => a - b)).toEqual(order);
	});

	test("shows service add with a positional label", () => {
		expect(doc).toMatch(/service add [a-z<][\w<>-]* /);
		expect(doc).not.toMatch(/service add --label/);
	});

	test("documents each service add option from the command source", () => {
		const src = source("dg-daemon", "src", "commands", "service.ts");
		for (const opt of [
			"--autostart",
			"--env-file",
			"--cwd",
			"--stop-timeout",
			"--grant",
		]) {
			expect(src).toContain(opt);
			expect(doc).toContain(opt);
		}
		for (const w of [
			"service rm",
			"job exec",
			"passEnv",
			"stopTimeoutMs",
			"grant",
		])
			expect(doc).toContain(w);
	});

	test("documents defaults and limits from config source", () => {
		const cfg = source("dg-daemon", "src", "services", "config.ts").replaceAll(
			"_",
			"",
		);
		for (const n of ["5000", "240000"]) {
			expect(cfg).toContain(n);
			expect(doc).toContain(n);
		}
		expect(cfg).toContain("unknown key(s)");
		expect(doc).toContain("unknown key(s)");
		expect(doc).toContain("dg-daemon restart");
	});

	test("names the injected DG keys from supervisor source", () => {
		const sup = source("dg-daemon", "src", "services", "supervisor.ts");
		for (const k of [
			"DG_SERVICE_API",
			"DG_SERVICE_LABEL",
			"DG_DAEMON_URL",
			"DG_CREDENTIAL_GRANT_PREFIX",
			"DG_CREDENTIAL_GRANT_FILE",
		]) {
			expect(sup).toContain(k);
			expect(doc).toContain(k);
		}
	});

	test("states the four corrected statements", () => {
		expect(doc).toMatch(/POSIX/);
		expect(doc).toMatch(/Windows[^.]*(process tree|tree)/i);
		expect(doc).toMatch(
			/allowlist[\s\S]{0,200}passEnv[\s\S]{0,200}envFile[\s\S]{0,200}DG_/,
		);
		expect(doc).toMatch(/injected[^.]*win/i);
		expect(doc).toMatch(/nothing starts the daemon at login/i);
		expect(doc).toMatch(
			/--autostart[^.]*(does not start the daemon|only when the daemon boots)/i,
		);
	});

	test("states passEnv source, idle exit, stop and restart rules", () => {
		expect(doc).toMatch(
			/passEnv[^.]*environment of the process that started the daemon/i,
		);
		expect(doc).toMatch(/no active session/i);
		expect(doc).toMatch(/240\s?s/);
		expect(doc).toMatch(/--force[^.]*(immediately|at once)/i);
		expect(doc).toMatch(/does not kill a job/i);
		expect(doc).toMatch(/Windows[^.]*(each|every) stop[^.]*forced/i);
		expect(doc).toMatch(/restart[^.]*(only|just)[^.]*autostart/i);
		expect(doc).not.toMatch(
			/DG_BUILD_VERSION[^.]*DG_DAEMON_PACKAGE_VERSION[^.]*compare/i,
		);
		expect(doc).toContain("service-api.md");
	});
});

describe("docs/AGENT-INSTALL.md", () => {
	const doc = read("docs/AGENT-INSTALL.md");

	test("no doc says dg-daemon has no stop command", () => {
		for (const f of readdirDocs())
			expect(readFileSync(f, "utf8")).not.toContain("has no stop command");
	});

	test("upgrade uses restart and rollback uses stop, keeping Restart the daemon", () => {
		expect(doc).toContain("Restart the daemon");
		expect(doc).toContain("dg-daemon restart");
		expect(doc).toContain("dg-daemon stop");
	});
});

function readdirDocs(): string[] {
	const out = Bun.spawnSync(["git", "ls-files", "docs"], { cwd: REPO_ROOT })
		.stdout.toString()
		.split("\n");
	return out.filter((f) => f.endsWith(".md")).map((f) => join(REPO_ROOT, f));
}

describe("jobs SKILL.md", () => {
	const path = "plugins/dg/skills/jobs/SKILL.md";
	const skill = read(path);

	test("carries the final no-daemon message on one line in one code span", () => {
		const msg =
			/"(no live dg-daemon[^"]+)"/.exec(
				source("dg-daemon", "src", "commands", "service.ts"),
			)?.[1] ?? "";
		expect(msg).not.toBe("");
		expect(skill).toContain(`\`${msg}\``);
	});

	test("covers the new actions and the gating rules", () => {
		for (const w of [
			"dg-daemon service add",
			"dg-daemon service rm",
			"dg-daemon job exec",
			"dg-daemon start",
			"dg-daemon stop",
			"dg-daemon restart",
			"--force",
			"dg-agent start",
		])
			expect(skill).toContain(w);
		expect(skill).not.toMatch(/dg-skills[^.\n]*start[^.\n]*daemon on demand/i);
		expect(skill).toMatch(/does not stop a running service/i);
		expect(skill).not.toContain("~/.dg/bin/");
		expect(count(skill, '"hooks": {')).toBeLessThanOrEqual(1);
	});

	test("leaves the bootstrap, SessionStart and channel-review lines untouched", () => {
		const base = gitBase();
		if (!base) return;
		const diff = Bun.spawnSync(["git", "diff", "-U0", base, "--", path], {
			cwd: REPO_ROOT,
		}).stdout.toString();
		const changed = diff.split("\n").filter((l) => /^[+-][^+-]/.test(l));
		for (const l of changed) expect(l).not.toContain("channel-review");
		const old = Bun.spawnSync(["git", "show", `${base}:${path}`], {
			cwd: REPO_ROOT,
		}).stdout.toString();
		const fence = (t: string, key: string) =>
			t
				.split("```")
				.filter((_, i) => i % 2 === 1)
				.find((b) => b.includes(key)) ?? "";
		expect(fence(skill, "bootstrap.sh")).toBe(fence(old, "bootstrap.sh"));
		expect(fence(skill, '"SessionStart"')).toBe(fence(old, '"SessionStart"'));
		const callLine = (t: string) =>
			t.split("\n").find((l) => l.startsWith("Call `dg-daemon`")) ?? "";
		expect(callLine(skill)).toBe(callLine(old));
	});
});

describe("SECURITY.md supervised-service paragraph", () => {
	const para = paragraphWith(read("SECURITY.md"), "passEnv");

	test("names passEnv, injected keys, grant file path and the state config path", () => {
		expect(para).not.toBe("");
		for (const w of [
			"passEnv",
			"envFile",
			"DG_",
			"<state>/daemon/config.json",
			"install.md",
			"POST /service-api/v1/credentials",
			"Origin",
		])
			expect(para).toContain(w);
		expect(para).not.toContain("<DG_HOME>");
	});
});

describe("DEVELOPER.md and README.md", () => {
	test("DEVELOPER credential section links the service API", () => {
		const sec = heading(
			read("docs/DEVELOPER.md"),
			"Using the credential store from another package",
		);
		expect(sec).toContain("service-api.md");
		expect(sec).toContain("/service-api/v1/credentials");
	});

	test("README links Service API v1 after the jobs bullet with blank lines around", () => {
		const lines = read("README.md").split("\n");
		const i = lines.indexOf(
			"- [Service API v1 (provisional)](docs/service-api.md)",
		);
		expect(i).toBeGreaterThan(0);
		expect(lines[i - 1]).toBe("");
		expect(lines[i + 1]).toBe("");
		expect(
			lines
				.slice(0, i)
				.reverse()
				.find((l) => l.trim() !== ""),
		).toContain("jobs-and-services.md");
	});
});

describe("changed documents", () => {
	test("each relative link opens an existing file", () => {
		for (const f of CHANGED_DOCS) {
			const text = read(f);
			expect(text).not.toBe("");
			for (const m of text.matchAll(
				/\]\((?!https?:|#|mailto:)([^)\s#]+)(?:#[^)]*)?\)/g,
			)) {
				expect(existsSync(resolve(REPO_ROOT, dirname(f), m[1]))).toBe(true);
			}
		}
	});

	test("service API literals match the route source", () => {
		const route = source("common", "src", "chat-format.ts");
		expect(route).toContain("/service-api/v1/credentials");
		expect(read("docs/service-api.md")).toContain(
			"/service-api/v1/credentials",
		);
	});
});
