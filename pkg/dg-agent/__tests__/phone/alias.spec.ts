import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { rmSync } from "node:fs";
import { DgCliError } from "@dg/common";
import pkg from "../../package.json" with { type: "json" };
import { resolveDgPaths } from "@dg/common/node";
import { Command } from "commander";
import { registerPhoneCommands, type OpenCloseDeps, type PhoneDeps } from "../../src/phone/commands";
import { ALIAS_REMOVAL_VERSION } from "../../src/phone/register";
import { PhoneDb } from "../../src/phone/db";
import type { KeyClient } from "../../src/phone/keys";
import { listenerPidPath } from "../../src/phone/listener";
import { makeHomeTracker, parseNdjson } from "./fake-pool";

let tracker: ReturnType<typeof makeHomeTracker>;
let out: string[];
const NOW = Math.floor(Date.now() / 1000);

function freshHome(): string {
	return tracker.freshHome();
}

function lines(rows: string[] = out): unknown[] {
	return parseNdjson(rows);
}

/** Awaits a removed-verb or `--line` rejection and asserts both the replacement message and exit 2. */
async function expectExit2(promise: Promise<unknown>, message: string): Promise<void> {
	try {
		await promise;
		throw new Error(`expected "${message}" to throw`);
	} catch (err) {
		expect(err).toBeInstanceOf(DgCliError);
		expect((err as DgCliError).message).toContain(message);
		expect((err as DgCliError).exitCode).toBe(2);
	}
}

type Harness = { program: Command; written: { path: string; text: string }[]; removed: string[]; ran: string[][] };

function harness(): Harness {
	const paths = resolveDgPaths({ env: { DG_HOME: freshHome() } });
	const db = PhoneDb.open(paths, () => NOW);
	tracker.trackDb(db);
	const written: { path: string; text: string }[] = [];
	const removed: string[] = [];
	const ran: string[][] = [];
	const installed = new Set<string>();
	const deps: PhoneDeps = {
		paths,
		db,
		sessionClient: async () => undefined,
		grantClient: (): KeyClient => {
			throw new Error("no grant in file-mode tests");
		},
		createPool: () => {
			throw new Error("alias tests never need a relay pool");
		},
		write: (text) => out.push(text),
		readStdin: async () => undefined,
		now: () => NOW,
	};
	const openCloseDeps: OpenCloseDeps = {
		...deps,
		platform: "linux",
		homeDir: "/home/u",
		env: {},
		uid: 501,
		writeFile: (path, data) => {
			const text = typeof data === "string" ? data : Buffer.from(data).toString("utf8");
			written.push({ path, text });
			installed.add(path);
		},
		removeFile: (path) => {
			removed.push(path);
			installed.delete(path);
		},
		fileExists: (path) => installed.has(path),
		run: async (argv) => {
			ran.push(argv);
			if (argv[0] === "systemctl" && argv.includes("disable")) rmSync(listenerPidPath(paths), { force: true });
			return { code: 0, stdout: "", stderr: "" };
		},
		which: (name) => `/resolved${name.startsWith("/") ? name : `/${name}`}`,
		listenerArgv: (extra) => ["/fake/execPath", "phone", "__run", ...extra],
		spawnListener: () => {
			throw new Error("alias tests expect the systemd path to succeed");
		},
		kill: () => {},
		isOurListener: () => true,
		sleep: async () => {},
	};
	const program = new Command();
	program.exitOverride();
	registerPhoneCommands(
		program,
		() => deps,
		() => openCloseDeps,
	);
	return { program, written, removed, ran };
}

beforeEach(() => {
	tracker = makeHomeTracker("dg-phone-alias-");
	out = [];
});

afterEach(() => {
	tracker.cleanup();
});

describe("phone hidden synonyms and removed verbs", () => {
	it("card matches number, byte for byte", async () => {
		const h = harness();

		await h.program.parseAsync(["phone", "number"], { from: "user" });
		const numberOut = out.slice();
		out = [];

		await h.program.parseAsync(["phone", "card"], { from: "user" });

		expect(out).toEqual(numberOut);
	});

	it("dial matches accept when no card is given", async () => {
		const h = harness();

		await expect(h.program.parseAsync(["phone", "accept"], { from: "user" })).rejects.toThrow("no call card given");
		await expect(h.program.parseAsync(["phone", "dial"], { from: "user" })).rejects.toThrow("no call card given");
	});

	it("on matches open and off matches close, byte for byte, including the installed unit", async () => {
		const h = harness();

		await h.program.parseAsync(["phone", "open"], { from: "user" });
		const openOut = out.slice();
		const openWritten = h.written[0]?.text;
		out = [];

		await h.program.parseAsync(["phone", "close"], { from: "user" });
		const closeOut = out.slice();
		out = [];

		await h.program.parseAsync(["phone", "on"], { from: "user" });
		const onOut = out.slice();
		const onWritten = h.written[1]?.text;
		out = [];

		await h.program.parseAsync(["phone", "off"], { from: "user" });
		const offOut = out.slice();

		expect(onOut).toEqual(openOut);
		expect(offOut).toEqual(closeOut);
		expect(onWritten).toEqual(openWritten);
	});

	it("installs and removes exactly the same unit whether reached through open/close or on/off", async () => {
		const h = harness();

		await h.program.parseAsync(["phone", "on"], { from: "user" });

		expect(h.written).toHaveLength(1);
		expect(h.written[0]?.text).toContain('ExecStart="/fake/execPath" "phone" "__run"');
		expect(h.written[0]?.path).toContain("dg-phone.service");

		await h.program.parseAsync(["phone", "close"], { from: "user" });

		expect(h.ran).toContainEqual(["systemctl", "--user", "disable", "--now", "dg-phone.service"]);
		expect(h.removed).toEqual([h.written[0]?.path]);
	});

	it.each([
		["answer", "answer is gone; run phone open to start the listener, then phone unread to read what came in"],
		["deliver", "deliver is gone; use phone open --on-message to run a program for each message"],
		["whoami", "whoami is gone; use phone number --as <name>"],
		["name", "name is gone; use phone contacts rename +old <new>"],
	])("phone %s fails with exit 2 and its replacement", async (verb, message) => {
		const h = harness();

		await expectExit2(h.program.parseAsync(["phone", verb], { from: "user" }), message);
	});

	it("phone deliver fails with exit 2 when given arguments", async () => {
		const h = harness();

		await expectExit2(
			h.program.parseAsync(["phone", "deliver", "on"], { from: "user" }),
			"deliver is gone; use phone open --on-message to run a program for each message",
		);
	});

	it("--line is gone, with exit 2, before dispatching to any subcommand", async () => {
		const h = harness();

		await expectExit2(
			h.program.parseAsync(["phone", "--line", "x", "number"], { from: "user" }),
			"--line is gone: one phone holds every contact; use +handle on text and messages",
		);
	});

	it("phone-friend is an unknown command and prints no notice", async () => {
		const h = harness();
		const stderr = spyOn(process.stderr, "write").mockImplementation(() => true);

		try {
			await expect(h.program.parseAsync(["phone-friend", "number"], { from: "user" })).rejects.toThrow("unknown command");
			expect(stderr.mock.calls.map((call) => String(call[0])).join("")).not.toContain("this alias goes away");
		} finally {
			stderr.mockRestore();
		}
	});
});

type Renamed = { old: string[]; current: string[]; notice: string };

const RENAMED: Renamed[] = [
	{ old: ["say", "+nobody", "hi"], current: ["text", "+nobody", "hi"], notice: "phone say is now phone text" },
	{ old: ["voicemail"], current: ["unread"], notice: "phone voicemail is now phone unread" },
	{ old: ["inbox"], current: ["messages"], notice: "phone inbox is now phone messages" },
	{ old: ["thread", "list"], current: ["group", "list"], notice: "phone thread is now phone group" },
];

async function captureStderr(run: () => Promise<unknown>): Promise<string> {
	const spy = spyOn(process.stderr, "write").mockImplementation(() => true);
	let written = "";
	try {
		await run();
	} catch {
	} finally {
		written = spy.mock.calls.map((call) => String(call[0])).join("");
		spy.mockRestore();
	}
	return written;
}

describe("phone texting-name aliases", () => {
	it.each(RENAMED)("phone $old.0 prints one stderr notice naming $current.0 and the removal release", async ({ old, notice }) => {
		const h = harness();

		const stderr = await captureStderr(() => h.program.parseAsync(["phone", ...old], { from: "user" }));

		expect(stderr).toBe(`${notice}; this alias goes away in ${ALIAS_REMOVAL_VERSION}\n`);
	});

	it.each(RENAMED.filter(({ old }) => old[0] !== "say"))("phone $old.0 writes the same stdout as phone $current.0", async ({ old, current }) => {
		const h = harness();
		await h.program.parseAsync(["phone", ...current], { from: "user" });
		const currentOut = out.slice();
		out = [];

		await captureStderr(() => h.program.parseAsync(["phone", ...old], { from: "user" }));

		expect(out).toEqual(currentOut);
	});

	it("phone text prints no stderr notice", async () => {
		const h = harness();

		const stderr = await captureStderr(() => h.program.parseAsync(["phone", "text", "+nobody", "hi"], { from: "user" }));

		expect(stderr).not.toContain("this alias goes away");
	});

	it("phone say fails the same way phone text does when the contact is unknown", async () => {
		const h = harness();
		const failure = async (verb: string): Promise<string> => {
			try {
				await h.program.parseAsync(["phone", verb, "+nobody", "hi"], { from: "user" });
				return "no error";
			} catch (err) {
				return (err as Error).message;
			}
		};

		const current = await failure("text");
		let old = "";
		await captureStderr(async () => {
			old = await failure("say");
		});

		expect(old).toBe(current);
		expect(old).not.toBe("no error");
	});

	it("phone thread new, list, and show each print the group notice", async () => {
		const h = harness();

		const stderr = await captureStderr(() => h.program.parseAsync(["phone", "thread", "show", "#none"], { from: "user" }));

		expect(stderr).toBe(`phone thread is now phone group; this alias goes away in ${ALIAS_REMOVAL_VERSION}\n`);
	});

	it("keeps the removal version a literal two minors after the next release", () => {
		expect(ALIAS_REMOVAL_VERSION).toMatch(/^\d+\.\d+\.0$/);
		expect(ALIAS_REMOVAL_VERSION).not.toBe(pkg.version);
	});

	it("lists the new names and hides the old ones in phone --help", () => {
		const h = harness();
		const help = h.program.commands.find((command) => command.name() === "phone")?.helpInformation() ?? "";

		for (const name of ["text", "unread", "messages", "group"]) expect(help).toMatch(new RegExp(`^  ${name}\\b`, "m"));
		for (const name of ["say", "voicemail", "inbox", "thread"]) expect(help).not.toMatch(new RegExp(`^  ${name}\\b`, "m"));
	});

	it("describes the renamed commands without the old words in their help", () => {
		const h = harness();
		const help = h.program.commands.find((command) => command.name() === "phone")?.helpInformation() ?? "";

		expect(help).not.toMatch(/voicemail|\bsay\b|\binbox\b|\bthread/i);
	});
});
