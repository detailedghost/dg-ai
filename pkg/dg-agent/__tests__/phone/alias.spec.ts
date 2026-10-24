import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DgCliError } from "@dg/common";
import { resolveDgPaths } from "@dg/common/node";
import { Command } from "commander";
import pkg from "../../package.json" with { type: "json" };
import { registerPhoneCommands, type OpenCloseDeps, type PhoneDeps } from "../../src/phone/commands";
import { PhoneDb } from "../../src/phone/db";
import type { KeyClient } from "../../src/phone/keys";
import { listenerPidPath } from "../../src/phone/listener";

let homes: string[];
let out: string[];
const NOW = Math.floor(Date.now() / 1000);

const [MAJOR, MINOR] = pkg.version.split(".").map(Number);
const EXPECTED_NOTICE = `phone-friend is now phone; this alias goes away in ${MAJOR}.${MINOR + 2}.0\n`;

function freshHome(): string {
	const home = mkdtempSync(join(tmpdir(), "dg-phone-alias-"));
	homes.push(home);
	return home;
}

function lines(rows: string[] = out): unknown[] {
	return rows
		.join("")
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((row) => JSON.parse(row));
}

type Harness = { program: Command; written: { path: string; text: string }[]; removed: string[]; ran: string[][] };

function harness(): Harness {
	const paths = resolveDgPaths({ env: { DG_HOME: freshHome() } });
	const db = PhoneDb.open(paths, () => NOW);
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
		writeFile: (path, text) => {
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
	homes = [];
	out = [];
});

afterEach(() => {
	for (const home of homes) rmSync(home, { recursive: true, force: true });
});

describe("phone-friend alias", () => {
	it("number matches phone's output byte for byte, plus one stderr notice", async () => {
		const h = harness();

		await h.program.parseAsync(["phone", "number"], { from: "user" });
		const phoneOut = out.slice();
		out = [];
		const stderr = spyOn(process.stderr, "write").mockImplementation(() => true);
		await h.program.parseAsync(["phone-friend", "number"], { from: "user" });

		expect(out).toEqual(phoneOut);
		expect(stderr.mock.calls.map((call) => String(call[0]))).toEqual([EXPECTED_NOTICE]);
		stderr.mockRestore();
	});

	it("prints no notice for the phone group itself", async () => {
		const h = harness();
		const stderr = spyOn(process.stderr, "write").mockImplementation(() => true);

		await h.program.parseAsync(["phone", "number"], { from: "user" });

		expect(stderr.mock.calls).toEqual([]);
		stderr.mockRestore();
	});

	it("dial matches accept, on matches open, off matches close, card matches number", async () => {
		const h = harness();
		const stderr = spyOn(process.stderr, "write").mockImplementation(() => true);

		await h.program.parseAsync(["phone-friend", "card"], { from: "user" });
		const card = out.slice();
		out = [];

		await h.program.parseAsync(["phone-friend", "on"], { from: "user" });
		const on = out.slice();
		out = [];

		await h.program.parseAsync(["phone-friend", "off"], { from: "user" });
		const off = out.slice();
		stderr.mockRestore();

		expect(lines(card)[0]).toMatchObject({ card: expect.any(String), npub: expect.any(String) });
		expect(lines(on)[0]).toMatchObject({ status: "started", autostart: "systemd" });
		expect(lines(off)[0]).toMatchObject({ status: "closed" });
	});

	it("installs and removes exactly the same unit whether reached through open/close or on/off", async () => {
		const h = harness();
		const stderr = spyOn(process.stderr, "write").mockImplementation(() => true);

		await h.program.parseAsync(["phone-friend", "on"], { from: "user" });
		stderr.mockRestore();

		expect(h.written).toHaveLength(1);
		expect(h.written[0]?.text).toContain('ExecStart="/fake/execPath" "phone" "__run"');
		expect(h.written[0]?.path).toContain("dg-phone.service");

		const stderr2 = spyOn(process.stderr, "write").mockImplementation(() => true);
		await h.program.parseAsync(["phone", "close"], { from: "user" });
		stderr2.mockRestore();

		expect(h.ran).toContainEqual(["systemctl", "--user", "disable", "--now", "dg-phone.service"]);
		expect(h.removed).toEqual([h.written[0]?.path]);
	});

	it.each([
		["answer", "answer is gone; run phone open to start the listener, then phone voicemail to read what came in"],
		["deliver", "deliver is gone; use phone open --on-message to run a program for each message"],
		["whoami", "whoami is gone; use phone number --as <name>"],
		["name", "name is gone; use phone contacts rename +old <new>"],
	])("phone-friend %s fails with exit 2 and its replacement", async (verb, message) => {
		const h = harness();
		const stderr = spyOn(process.stderr, "write").mockImplementation(() => true);

		try {
			await expect(h.program.parseAsync(["phone-friend", verb], { from: "user" })).rejects.toThrow(message);
		} finally {
			stderr.mockRestore();
		}
	});

	it("phone deliver also fails with exit 2, not only the phone-friend alias", async () => {
		const h = harness();

		await expect(h.program.parseAsync(["phone", "deliver", "on"], { from: "user" })).rejects.toThrow(
			"deliver is gone; use phone open --on-message to run a program for each message",
		);
	});

	it("--line is gone on the phone-friend group too, before dispatching to any subcommand", async () => {
		const h = harness();
		const stderr = spyOn(process.stderr, "write").mockImplementation(() => true);

		try {
			await expect(h.program.parseAsync(["phone-friend", "--line", "x", "number"], { from: "user" })).rejects.toThrow(
				"--line is gone: one phone holds every contact; use +handle on say and inbox",
			);
		} finally {
			stderr.mockRestore();
		}
	});

	it("removed verbs and --line exit with code 2", async () => {
		const h = harness();
		const stderr = spyOn(process.stderr, "write").mockImplementation(() => true);

		try {
			await h.program.parseAsync(["phone-friend", "whoami"], { from: "user" });
			throw new Error("expected whoami to throw");
		} catch (err) {
			expect(err).toBeInstanceOf(DgCliError);
			expect((err as DgCliError).exitCode).toBe(2);
		} finally {
			stderr.mockRestore();
		}
	});
});
