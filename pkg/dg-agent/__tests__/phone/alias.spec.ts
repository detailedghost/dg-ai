import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { rmSync } from "node:fs";
import { DgCliError } from "@dg/common";
import { resolveDgPaths } from "@dg/common/node";
import { Command } from "commander";
import { registerPhoneCommands, type OpenCloseDeps, type PhoneDeps } from "../../src/phone/commands";
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
		["answer", "answer is gone; run phone open to start the listener, then phone voicemail to read what came in"],
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
			"--line is gone: one phone holds every contact; use +handle on say and inbox",
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
