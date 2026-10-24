import { afterEach, describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { DgCliError } from "@dg/common";
import { resolveDgPaths } from "@dg/common/node";
import {
	ChatStore,
	ENTRY,
	FILE_ONLY_SEAMS,
	cleanupDgHome,
	freshDgHome,
	subprocessEnv,
} from "@dg/dg-daemon/test-harness";
import { parseFeedLines } from "../../../dg-daemon/src/jobs/parse";
import {
	type JobCli,
	type JobCliResult,
	DEFAULT_DELIVERY_EVERY,
	JOB_EXISTS_MARKER,
	JOB_NOT_FOUND_MARKER,
	PHONE_FRIEND_SAFETY_REF,
	deliveryArgv,
	deliveryLabel,
	disableDelivery,
	enableDelivery,
	identityForSession,
	identityFromDaemon,
	resolveDaemonExecutable,
	runArgv,
	runDaemonJobCli,
	siblingDaemonPath,
	voicemailLine,
	voicemailTitle,
} from "../../src/phone-friend/deliver";

const homes: string[] = [];

afterEach(() => {
	for (const home of homes.splice(0)) cleanupDgHome(home);
});

function result(code: number, stderr = "", stdout = ""): JobCliResult {
	return { code, stdout, stderr };
}

function scripted(responses: JobCliResult[]): { run: JobCli; calls: string[][] } {
	const calls: string[][] = [];
	return {
		calls,
		run: async (args) => {
			calls.push(args);
			const next = responses.shift();
			if (!next) throw new Error("unexpected job cli call");
			return next;
		},
	};
}

describe("deliveryArgv", () => {
	it("stores dg-agent phone-friend voicemail for the default line", () => {
		expect(deliveryArgv("default")).toEqual(["dg-agent", "phone-friend", "voicemail"]);
		expect(deliveryArgv("default")).not.toContain("--line");
		expect(deliveryLabel("default")).toBe("phone-friend:default");
	});

	it("puts --line before voicemail for any other line", () => {
		expect(deliveryArgv("work")).toEqual([
			"dg-agent",
			"phone-friend",
			"--line",
			"work",
			"voicemail",
		]);
		expect(deliveryLabel("work")).toBe("phone-friend:work");
	});
});

describe("voicemailLine", () => {
	it("uses the trimmed message text as the feed title", () => {
		expect(voicemailTitle("  hello  ")).toBe("hello");
		expect(voicemailTitle("hello there")).toBe("hello there");
	});

	it("replaces a blank message with a title the job runner accepts", () => {
		expect(voicemailTitle("")).toBe("(empty)");
		expect(voicemailTitle("   ")).toBe("(empty)");
	});

	it("keeps the message fields and lets the title win over an extra title", () => {
		expect(voicemailLine({ id: "m1", text: "  ping  ", from: "npub1" }, { title: "nope", handle: "@work" })).toEqual({
			id: "m1",
			text: "  ping  ",
			from: "npub1",
			handle: "@work",
			title: "ping",
		});
	});

	it("is one feed item the daemon job runner can notify on", () => {
		const printed = voicemailLine(
			{ id: "evt1", ts: 10, from: "npub1abc", text: "ship it" },
			{ call: true, handle: "@work" },
		);
		const parsed = parseFeedLines(`${JSON.stringify(printed)}\n`);
		expect(parsed).toEqual({
			ok: true,
			items: [{ fingerprint: "evt1", title: "ship it" }],
		});
	});

	it("still parses a blank message, whose title is (empty)", () => {
		const parsed = parseFeedLines(JSON.stringify(voicemailLine({ id: "evt2", text: "  " })));
		expect(parsed.ok).toBe(true);
		if (parsed.ok) expect(parsed.items[0]?.title).toBe("(empty)");
	});
});

describe("identityForSession", () => {
	const reviewer = { sessionId: "s1", cwd: "/work/a", agentIdentity: "reviewer" };
	const other = { sessionId: "s2", cwd: "/work/b", agentIdentity: "other" };

	it("returns the named session even when resolving its directory would fail", () => {
		expect(
			identityForSession([reviewer], { sessionId: "s1", cwd: "/missing" }, () => {
				throw new Error("missing");
			}),
		).toBe("reviewer");
	});

	it("ignores a blank identity on the named session", () => {
		expect(() =>
			identityForSession(
				[{ ...reviewer, agentIdentity: "  " }, other],
				{ sessionId: "s1", cwd: "/work/a" },
				(path) => path,
			),
		).toThrow("no active dg session s1");
	});

	it("returns the only live identity in this directory and skips a blank one", () => {
		expect(
			identityForSession(
				[{ ...reviewer, agentIdentity: " " }, { ...other, cwd: "/work/a" }],
				{ cwd: "/work/a" },
				(path) => path,
			),
		).toBe("other");
	});

	it("refuses when this directory has no usable session", () => {
		expect(() => identityForSession([other], { cwd: "/work/a" }, (path) => path)).toThrow(
			"dg-agent start",
		);
	});

	it("refuses when this directory has more than one session", () => {
		expect(() =>
			identityForSession([reviewer, { ...other, cwd: "/work/a" }], { cwd: "/work/a" }, (path) => path),
		).toThrow("more than one dg session");
	});

	it("treats a directory that does not resolve as no session", () => {
		const missing = () => {
			throw new Error("gone");
		};
		expect(() => identityForSession([reviewer], { cwd: "/gone" }, missing)).toThrow(DgCliError);
		expect(() => identityForSession([reviewer], { cwd: "/gone" }, missing)).toThrow(
			"pass --notify <identity>",
		);
		expect(() => identityForSession([reviewer], { cwd: "/gone" }, missing)).not.toThrow("dg-agent start");
	});

	it("skips a record whose directory does not resolve", () => {
		expect(
			identityForSession([reviewer, other], { cwd: "/work/b" }, (path) => {
				if (path === "/work/a") throw new Error("missing");
				return path;
			}),
		).toBe("other");
	});
});

describe("identityFromDaemon", () => {
	it("asks for --notify when the daemon has no session rows", () => {
		const home = freshDgHome();
		homes.push(home);
		const paths = resolveDgPaths({ env: { DG_HOME: home } });
		expect(() => identityFromDaemon(paths)).toThrow("dg-agent start");
		expect(() => identityFromDaemon(paths, "abc")).toThrow("no active dg session abc");
	});
});

describe("enableDelivery", () => {
	const target = {
		line: "work",
		every: " 5m ",
		notifyIdentity: "  reviewer  ",
		cwd: "/tmp/work",
	};

	it("asks dg-daemon to add a notifying voicemail job", async () => {
		const jobs = scripted([result(0, "", "added\n")]);

		expect(await enableDelivery(target, jobs.run)).toBe("added");
		expect(jobs.calls).toEqual([
			[
				"job",
				"add",
				"--label",
				"phone-friend:work",
				"--every",
				"5m",
				"--cwd",
				"/tmp/work",
				"--notify",
				"reviewer",
				"--",
				"dg-agent",
				"phone-friend",
				"--line",
				"work",
				"voicemail",
			],
		]);
	});

	it("does not enable a job whose add succeeded, even if the output mentions already exists", async () => {
		const jobs = scripted([result(0, JOB_EXISTS_MARKER, "")]);

		expect(await enableDelivery(target, jobs.run)).toBe("added");
		expect(jobs.calls).toHaveLength(1);
	});

	it("re-enables an existing job when add reports it from either stream", async () => {
		for (const first of [
			result(1, `a job labelled "phone-friend:work" ${JOB_EXISTS_MARKER}`),
			result(1, "", JOB_EXISTS_MARKER),
		]) {
			const jobs = scripted([first, result(0)]);
			expect(await enableDelivery(target, jobs.run)).toBe("enabled");
			expect(jobs.calls[1]).toEqual(["job", "enable", "phone-friend:work"]);
		}
	});

	it("surfaces an add failure and does not enable", async () => {
		const jobs = scripted([result(1, 'executable "dg-agent" does not resolve on PATH')]);

		await expect(enableDelivery(target, jobs.run)).rejects.toThrow("does not resolve on PATH");
		expect(jobs.calls).toHaveLength(1);
	});

	it("surfaces an empty add failure", async () => {
		const jobs = scripted([result(1)]);

		await expect(enableDelivery(target, jobs.run)).rejects.toThrow("could not schedule phone-friend:work");
	});

	it("surfaces an enable failure after the label already exists", async () => {
		const jobs = scripted([result(1, JOB_EXISTS_MARKER), result(1, "daemon locked")]);

		await expect(enableDelivery(target, jobs.run)).rejects.toThrow("daemon locked");
	});

	it("names the job when enable fails without output", async () => {
		const jobs = scripted([result(1, JOB_EXISTS_MARKER), result(1)]);

		await expect(enableDelivery(target, jobs.run)).rejects.toThrow("could not enable phone-friend:work");
	});

	it("rejects a blank identity and a bad interval before it calls the daemon", async () => {
		const jobs = scripted([]);

		await expect(enableDelivery({ ...target, notifyIdentity: "   " }, jobs.run)).rejects.toThrow(
			"--notify needs an agent identity",
		);
		await expect(enableDelivery({ ...target, every: "tomorrow" }, jobs.run)).rejects.toThrow("--every");
		expect(jobs.calls).toEqual([]);
	});
});

describe("disableDelivery", () => {
	it("disables the line job", async () => {
		const jobs = scripted([result(0, `${JOB_NOT_FOUND_MARKER} ignored because the command succeeded`)]);

		expect(await disableDelivery("work", jobs.run)).toBe("disabled");
		expect(jobs.calls).toEqual([["job", "disable", "phone-friend:work"]]);
	});

	it("treats a missing job as already off when either stream says so", async () => {
		for (const response of [
			result(1, `${JOB_NOT_FOUND_MARKER} "phone-friend:work"`),
			result(1, "", JOB_NOT_FOUND_MARKER),
		]) {
			const jobs = scripted([response]);
			expect(await disableDelivery("work", jobs.run)).toBe("absent");
		}
	});

	it("surfaces any other disable failure", async () => {
		const jobs = scripted([result(1, "", "database is locked")]);

		await expect(disableDelivery("default", jobs.run)).rejects.toThrow("database is locked");
	});

	it("surfaces an empty disable failure", async () => {
		const jobs = scripted([result(1)]);

		await expect(disableDelivery("default", jobs.run)).rejects.toThrow(
			"could not disable phone-friend:default",
		);
	});
});

describe("resolveDaemonExecutable", () => {
	it("prefers the daemon beside this executable", () => {
		expect(siblingDaemonPath("/opt/dg/dg-agent", "linux")).toBe("/opt/dg/dg-daemon");
		expect(siblingDaemonPath("/opt/dg/dg-agent.exe", "win32")).toBe("/opt/dg/dg-daemon.exe");
		expect(
			resolveDaemonExecutable("/opt/dg/dg-agent", "linux", (path) => path.endsWith("dg-daemon"), () => "/usr/bin/dg-daemon"),
		).toBe("/opt/dg/dg-daemon");
	});

	it("uses PATH when the sibling is absent", () => {
		expect(
			resolveDaemonExecutable("/opt/dg/dg-agent", "linux", () => false, (name) =>
				name === "dg-daemon" ? "/usr/bin/dg-daemon" : undefined,
			),
		).toBe("/usr/bin/dg-daemon");
	});

	it("says how to install dg-daemon when neither place has it", () => {
		expect(() => resolveDaemonExecutable("/opt/dg/dg-agent", "linux", () => false, () => undefined)).toThrow(
			"dg-skills install",
		);
	});
});

describe("runArgv", () => {
	it("captures stdout and the env it was given", async () => {
		const ran = await runArgv([process.execPath, "-e", "console.log(process.env.MARKER ?? '')"], {
			...process.env,
			MARKER: "dg-delivery",
		});

		expect(ran.code).toBe(0);
		expect(ran.stdout).toBe("dg-delivery\n");
	});

	it("captures a non-zero exit and stderr", async () => {
		const ran = await runArgv(
			[process.execPath, "-e", "console.error('nope'); process.exit(3)"],
			process.env,
		);

		expect(ran.code).toBe(3);
		expect(ran.stderr).toContain("nope");
	});

	it("returns a failure when the executable cannot be spawned", async () => {
		const ran = await runArgv(["/no/such/dg-daemon-binary"], process.env);

		expect(ran.code).not.toBe(0);
		expect(ran.stdout).toBe("");
		expect(ran.stderr.length).toBeGreaterThan(0);
	});
});

describe("runDaemonJobCli", () => {
	it("runs the dg-daemon found on PATH and forwards the job arguments", async () => {
		const bin = mkdtempSync(join(tmpdir(), "dg-daemon-bin-"));
		writeFileSync(join(bin, "dg-daemon"), "#!/bin/sh\nprintf '%s\n' \"$@\"\n");
		chmodSync(join(bin, "dg-daemon"), 0o755);
		const previous = process.env.PATH;
		process.env.PATH = `${bin}${delimiter}${previous ?? ""}`;
		try {
			const ran = await runDaemonJobCli(["job", "list"]);
			expect(ran.code).toBe(0);
			expect(ran.stdout).toBe("job\nlist\n");
		} finally {
			process.env.PATH = previous;
			rmSync(bin, { recursive: true, force: true });
		}
	});
});

describe("dg-daemon job storage", () => {
	it("stores the voicemail argv, notify identity, and enable/disable state", async () => {
		const dgHome = freshDgHome();
		homes.push(dgHome);
		const bin = mkdtempSync(join(tmpdir(), "dg-agent-bin-"));
		try {
			writeFileSync(join(bin, "dg-agent"), "#!/bin/sh\nexit 0\n");
			chmodSync(join(bin, "dg-agent"), 0o755);
			const run: JobCli = async (args) => {
				const proc = Bun.spawn([process.execPath, ENTRY, ...args], {
					env: subprocessEnv(dgHome, 0, { PATH: `${bin}${delimiter}${process.env.PATH ?? ""}` }),
					stdout: "pipe",
					stderr: "pipe",
					stdin: "ignore",
				});
				const [stdout, stderr, code] = await Promise.all([
					new Response(proc.stdout).text(),
					new Response(proc.stderr).text(),
					proc.exited,
				]);
				return { code: code ?? 1, stdout, stderr };
			};
			const target = {
				line: "work",
				every: DEFAULT_DELIVERY_EVERY,
				notifyIdentity: "reviewer",
				cwd: dgHome,
			};

			expect(await enableDelivery(target, run)).toBe("added");

			const store = await ChatStore.open(resolveDgPaths({ env: { DG_HOME: dgHome } }), FILE_ONLY_SEAMS);
			try {
				const job = store.getJobByLabel("phone-friend:work");
				expect(job?.argv).toEqual(deliveryArgv("work"));
				expect(job?.notifyIdentity).toBe("reviewer");
				expect(job?.intervalMs).toBe(60_000);
				expect(job?.enabled).toBe(true);
				expect(job?.cwd).toBe(dgHome);
			} finally {
				store.close();
			}

			expect(await enableDelivery(target, run)).toBe("enabled");
			expect(await disableDelivery("work", run)).toBe("disabled");

			const after = await ChatStore.open(resolveDgPaths({ env: { DG_HOME: dgHome } }), FILE_ONLY_SEAMS);
			try {
				expect(after.listJobs()).toHaveLength(1);
				expect(after.getJobByLabel("phone-friend:work")?.enabled).toBe(false);
			} finally {
				after.close();
			}

			expect(await disableDelivery("absent", run)).toBe("absent");
		} finally {
			rmSync(bin, { recursive: true, force: true });
		}
	});
});

describe("safety reference", () => {
	it("points at the shared safety profile", () => {
		expect(PHONE_FRIEND_SAFETY_REF).toBe("plugins/dg/skills/phone-friend/references/safety.md");
	});
});

describe("job error markers", () => {
	it("still matches the wording dg-daemon's job CLI throws", () => {
		const daemonSource = readFileSync(
			join(import.meta.dir, "../../../dg-daemon/src/commands/jobs.ts"),
			"utf8",
		);

		expect(daemonSource).toContain(JOB_EXISTS_MARKER);
		expect(daemonSource).toContain(JOB_NOT_FOUND_MARKER);
	});
});
