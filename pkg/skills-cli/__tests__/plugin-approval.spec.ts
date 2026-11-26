import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { approvalFields, approvalProblem, daemonApprovalSigner, isApproved, signApproval } from "../src/plugin/approval";
import { type PluginRecord, readRecord } from "../src/plugin/store";
import fixture from "../../common/fixtures/plugins/approval/cases.json";
import { downDaemon, fakeDaemon, signRecord, useApprovalDaemon } from "./support/approval-daemon";

let root: string;
let env: Record<string, string | undefined>;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "dg-plugin-approval-"));
	env = { DG_HOME: join(root, "dg"), HOME: join(root, "home"), DG_PATH_FENCE: root };
	for (const [rel, text] of Object.entries(fixture.tree)) {
		const file = join(root, "dg", "data", "plugins", "demo", "src", rel);
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, text);
	}
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

const record = (name: keyof typeof fixture.records): PluginRecord => structuredClone(fixture.records[name]) as unknown as PluginRecord;

describe("approvalFields", () => {
	test("lists the seven signed fields in the shared order, with no domain string", () => {
		const signed = record("signed");
		expect(approvalFields(signed)).toEqual([
			signed.name,
			signed.kind,
			signed.source,
			signed.pin.kind,
			signed.pin.value,
			signed.treeSha256,
			signed.approvedSha256 as string,
		]);
	});

	test("the shared fixture MAC is what the daemon-style signer makes from them", () => {
		expect(signRecord(record("signed"), fixture.key)).toBe(fixture.expectedMac);
	});
});

describe("signApproval", () => {
	test("refuses to sign a record whose signed fields hold a NUL byte, without asking the daemon", async () => {
		const daemon = fakeDaemon();
		useApprovalDaemon(daemon);
		await expect(signApproval(record("nul-in-source"), daemonApprovalSigner(env))).rejects.toThrow(/NUL/);
		expect(daemon.signs).toBe(0);
	});

	test("returns the daemon MAC for the fields", async () => {
		useApprovalDaemon(fakeDaemon(fixture.key));
		const signer = daemonApprovalSigner(env);
		expect(await signApproval(record("signed"), signer)).toBe(fixture.expectedMac);
		signer.close();
	});

	test("names the daemon when it is down", async () => {
		useApprovalDaemon(downDaemon());
		await expect(signApproval(record("signed"), daemonApprovalSigner(env))).rejects.toThrow(/cannot approve demo.*start the dg daemon/);
	});

	test("says to check the daemon when it refuses", async () => {
		useApprovalDaemon(downDaemon(new Error("Credential storage failed")));
		await expect(signApproval(record("signed"), daemonApprovalSigner(env))).rejects.toThrow(/did not sign.*dg doctor/);
	});
});

describe("readRecord", () => {
	const write = (value: unknown) => writeFileSync(join(root, "dg", "data", "plugins", "demo", "dg-plugin.json"), JSON.stringify(value));

	test("reads the signed fixture record with its mac", () => {
		write(fixture.records.signed);
		expect(readRecord("demo", env).mac).toBe(fixture.expectedMac);
	});

	test("reads a record with no mac key, as older dg wrote it, as unsigned", () => {
		write(fixture.records.unsigned);
		expect(readRecord("demo", env).mac).toBeNull();
	});

	test("reads a null mac as unsigned", () => {
		write(fixture.records.unsignedNull);
		expect(readRecord("demo", env).mac).toBeNull();
	});

	test("refuses a mac that is not 64 lowercase hex and any other extra key", () => {
		write({ ...fixture.records.signed, mac: "ABC" });
		expect(() => readRecord("demo", env)).toThrow(/wrong type/);
		write({ ...fixture.records.signed, extra: 1 });
		expect(() => readRecord("demo", env)).toThrow(/must hold exactly the keys/);
	});
});

describe("isApproved", () => {
	beforeEach(() => useApprovalDaemon(fakeDaemon(fixture.key)));
	afterEach(() => useApprovalDaemon(undefined));

	test("approves the signed fixture record when the daemon verifies it and the tree is intact", async () => {
		expect(await isApproved(record("signed"), env)).toBe(true);
	});

	test("refuses a bad MAC and says to re-approve", async () => {
		expect(await isApproved(record("badMac"), env)).toBe(false);
		expect(await approvalProblem(record("badMac"), env)).toMatch(/dg plugin verify demo --approve/);
	});

	test("refuses an unsigned record without asking the daemon", async () => {
		const daemon = fakeDaemon(fixture.key);
		useApprovalDaemon(daemon);
		for (const name of ["unsigned", "unsignedNull"] as const) {
			expect(await approvalProblem(record(name), env)).toMatch(/re-approve.*dg plugin verify demo --approve/);
		}
		expect(daemon.opened).toBe(0);
	});

	test("refuses a record that was never approved without opening a daemon client", async () => {
		const daemon = fakeDaemon();
		useApprovalDaemon(daemon);
		expect(await approvalProblem(record("unapproved"), env)).toMatch(/review it.*dg plugin verify demo --approve/);
		expect(daemon.opened).toBe(0);
	});

	test("refuses when the daemon holds no key and says to re-approve", async () => {
		useApprovalDaemon(fakeDaemon(null));
		expect(await approvalProblem(record("signed"), env)).toMatch(/signature does not verify.*dg plugin verify demo --approve/);
	});

	test("refuses when the daemon is down and says to start it", async () => {
		useApprovalDaemon(downDaemon());
		const problem = await approvalProblem(record("signed"), env);
		expect(problem).toMatch(/start the dg daemon/);
		expect(problem).toMatch(/dg agent start/);
		expect(await isApproved(record("signed"), env)).toBe(false);
	});

	test("never approves the nul-in-source fixture, whose mac matches the raw NUL join", async () => {
		const nul = record("nul-in-source");
		expect(await isApproved(nul, env)).toBe(false);
		expect(await approvalProblem(nul, env)).toMatch(/NUL/);
	});

	test("a failure that is not a stopped daemon names dg doctor, not dg agent start", async () => {
		useApprovalDaemon(downDaemon(new Error("no usable session x is registered on the daemon.")));
		const problem = await approvalProblem(record("signed"), env);
		expect(problem).toMatch(/no usable session.*dg doctor/);
		expect(problem).not.toMatch(/dg agent start/);
	});

	test("refuses a different daemon key", async () => {
		useApprovalDaemon(fakeDaemon("ff".repeat(32)));
		expect(await isApproved(record("signed"), env)).toBe(false);
	});

	test("refuses a record whose approvedSha256 differs from treeSha256 even with a valid MAC", async () => {
		const forged = { ...record("signed"), approvedSha256: "0".repeat(64) };
		forged.mac = signRecord(forged, fixture.key);
		expect(await isApproved(forged, env)).toBe(false);
	});

	test("refuses a signed record whose files changed", async () => {
		writeFileSync(join(root, "dg", "data", "plugins", "demo", "src", "SKILL.md"), "changed");
		expect(await isApproved(record("signed"), env)).toBe(false);
	});

	test("verifies with one client that it opens and closes itself, and never reads the key credential", async () => {
		const daemon = fakeDaemon(fixture.key);
		useApprovalDaemon(daemon);
		await isApproved(record("signed"), env);
		expect(daemon).toMatchObject({ opened: 1, closed: 1, verifies: 1, keyReads: 0 });
	});

	test("leaves a signer it was given open for the caller", async () => {
		const daemon = fakeDaemon(fixture.key);
		useApprovalDaemon(daemon);
		const signer = daemonApprovalSigner(env);
		await isApproved(record("signed"), env, signer);
		await isApproved(record("signed"), env, signer);
		expect(daemon).toMatchObject({ opened: 1, closed: 0, verifies: 2 });
		signer.close();
		expect(daemon.closed).toBe(1);
	});
});

describe("daemonApprovalSigner", () => {
	afterEach(() => useApprovalDaemon(undefined));

	test("opens no client until it is asked, and does not close one it never opened", () => {
		const daemon = fakeDaemon();
		useApprovalDaemon(daemon);
		daemonApprovalSigner(env).close();
		expect(daemon.opened).toBe(0);
	});
});
