import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DaemonNotRunningError } from "@dg/common/node";
import { approvalProblem, credentialApprovalKeys, defaultApprovalKeys, isApproved, macOf } from "../src/plugin/approval";
import { type PluginRecord, readRecord } from "../src/plugin/store";
import fixture from "../../common/fixtures/plugins/approval/cases.json";
import { downKeys, fakeKeys, TEST_KEY_HEX, useApprovalKeys } from "./support/approval-keys";

const key = Buffer.from(fixture.key, "hex");
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

describe("macOf", () => {
	test("refuses to sign a record whose signed fields hold a NUL byte", () => {
		expect(() => macOf(record("nul-in-source"), key)).toThrow(/NUL/);
	});

	test("signs the NUL-joined record fields with HMAC-SHA256 and matches the shared fixture", () => {
		expect(macOf(record("signed"), key)).toBe(fixture.expectedMac);
	});

	test("changes when any signed field changes", () => {
		const base = macOf(record("signed"), key);
		for (const change of [{ name: "demo2" }, { kind: "x" }, { source: "s" }, { pin: { kind: "sha256", value: "a" } }, { treeSha256: "a" }, { approvedSha256: "a" }]) {
			expect(macOf({ ...record("signed"), ...change } as PluginRecord, key)).not.toBe(base);
		}
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
	test("approves the signed fixture record when the key matches and the tree is intact", async () => {
		expect(await isApproved(record("signed"), env, fakeKeys())).toBe(true);
	});

	test("refuses a bad MAC and says to re-approve", async () => {
		const keys = fakeKeys();
		expect(await isApproved(record("badMac"), env, keys)).toBe(false);
		expect(await approvalProblem(record("badMac"), env, keys)).toMatch(/dg plugin verify demo --approve/);
	});

	test("refuses an unsigned record, with or without the mac key", async () => {
		for (const name of ["unsigned", "unsignedNull"] as const) {
			expect(await approvalProblem(record(name), env, fakeKeys())).toMatch(/re-approve.*dg plugin verify demo --approve/);
		}
	});

	test("refuses a record that was never approved without asking for the key", async () => {
		expect(await approvalProblem(record("unapproved"), env, downKeys())).toMatch(/review it.*dg plugin verify demo --approve/);
	});

	test("refuses when the key is absent and says to re-approve", async () => {
		expect(await approvalProblem(record("signed"), env, fakeKeys(null))).toMatch(/no approval key.*dg plugin verify demo --approve/);
	});

	test("refuses when the daemon is down and says to start it", async () => {
		const problem = await approvalProblem(record("signed"), env, downKeys());
		expect(problem).toMatch(/dg agent start/);
		expect(await isApproved(record("signed"), env, downKeys())).toBe(false);
	});

	test("never approves the nul-in-source fixture, whose mac matches the raw NUL join", async () => {
		const nul = record("nul-in-source");
		expect(await isApproved(nul, env, fakeKeys())).toBe(false);
		expect(await approvalProblem(nul, env, fakeKeys())).toMatch(/NUL/);
	});

	test("a failure that is not a stopped daemon names dg doctor, not dg agent start", async () => {
		const problem = await approvalProblem(record("signed"), env, downKeys(new Error("no usable session x is registered on the daemon.")));
		expect(problem).toMatch(/no usable session.*dg doctor/);
		expect(problem).not.toMatch(/dg agent start/);
	});

	test("refuses a different key", async () => {
		expect(await isApproved(record("signed"), env, fakeKeys("ff".repeat(32)))).toBe(false);
	});

	test("refuses a record whose approvedSha256 differs from treeSha256 even with a valid MAC", async () => {
		const forged = { ...record("signed"), approvedSha256: "0".repeat(64) };
		forged.mac = macOf(forged, key);
		expect(await isApproved(forged, env, fakeKeys())).toBe(false);
	});

	test("refuses a signed record whose files changed", async () => {
		writeFileSync(join(root, "dg", "data", "plugins", "demo", "src", "SKILL.md"), "changed");
		expect(await isApproved(record("signed"), env, fakeKeys())).toBe(false);
	});
});

describe("credentialApprovalKeys", () => {
	function fakeClient(initial?: string) {
		const calls = { get: 0, set: [] as [string, string][] };
		let value = initial;
		return {
			calls,
			client: {
				get: async (name: string) => {
					calls.get++;
					expect(name).toBe("dg/plugin-approval-key");
					return value === undefined ? undefined : { value, meta: {}, updatedAt: "" };
				},
				set: async (name: string, text: string) => {
					calls.set.push([name, text]);
					value = text;
				},
			},
		};
	}

	test("fetches the key once per process", async () => {
		const { client, calls } = fakeClient(fixture.key);
		const keys = credentialApprovalKeys(() => client);
		expect((await keys.read())?.toString("hex")).toBe(fixture.key);
		expect((await keys.read())?.toString("hex")).toBe(fixture.key);
		expect(calls.get).toBe(1);
	});

	test("reads an absent key as undefined without creating one", async () => {
		const { client, calls } = fakeClient();
		expect(await credentialApprovalKeys(() => client).read()).toBeUndefined();
		expect(calls.set).toEqual([]);
	});

	test("reads a malformed key as absent", async () => {
		const { client } = fakeClient("not-hex");
		expect(await credentialApprovalKeys(() => client).read()).toBeUndefined();
	});

	test("ensure stores a fresh 32-byte lowercase hex key on first use and reuses it after", async () => {
		const { client, calls } = fakeClient();
		const keys = credentialApprovalKeys(() => client);
		const first = await keys.ensure();
		expect(first).toHaveLength(32);
		expect(calls.set).toHaveLength(1);
		expect(calls.set[0]?.[1]).toMatch(/^[0-9a-f]{64}$/);
		expect((await keys.ensure()).equals(first)).toBe(true);
		expect(calls.set).toHaveLength(1);
	});

	test("lets a daemon error surface and still closes the connection", async () => {
		let closed = 0;
		const keys = credentialApprovalKeys(() => ({
			get: async () => {
				throw new DaemonNotRunningError();
			},
			set: async () => {},
			close: () => void closed++,
		}));
		await expect(keys.read()).rejects.toThrow(/dg agent start/);
		expect(closed).toBe(1);
	});

	test("closes the connection once after a read and once after ensure", async () => {
		let closed = 0;
		const base = fakeClient();
		const keys = credentialApprovalKeys(() => ({ ...base.client, close: () => void closed++ }));
		await keys.read();
		expect(closed).toBe(1);
		await keys.ensure();
		expect(closed).toBe(2);
		await keys.read();
		await keys.ensure();
		expect(closed).toBe(2);
	});
});

describe("defaultApprovalKeys", () => {
	afterEach(() => useApprovalKeys(undefined));

	test("reads the key for each environment it is given, not the first one it saw", async () => {
		const first = fakeKeys(TEST_KEY_HEX);
		useApprovalKeys(first);
		expect((await defaultApprovalKeys(env).read())?.toString("hex")).toBe(TEST_KEY_HEX);
		const other = "ff".repeat(32);
		useApprovalKeys(fakeKeys(other));
		expect((await defaultApprovalKeys({ ...env, DG_HOME: join(root, "other") }).read())?.toString("hex")).toBe(other);
	});
});
