import { describe, expect, it } from "bun:test";
import { APPROVAL_KEY_CREDENTIAL } from "@dg/common";
import fixture from "../../../common/fixtures/plugins/approval/cases.json";
import { createApprovalSigner } from "../../src/server/approval-signer";

type Stored = { value: string; meta: Record<string, unknown>; updatedAt: string };

function memoryStore(initial?: string) {
	const entries = new Map<string, Stored>();
	if (initial !== undefined) entries.set(APPROVAL_KEY_CREDENTIAL, { value: initial, meta: {}, updatedAt: "" });
	return {
		entries,
		getCredential: (name: string) => entries.get(name),
		setCredential: (name: string, value: string) => void entries.set(name, { value, meta: {}, updatedAt: "" }),
	};
}

const fieldsOf = (record: typeof fixture.records.signed) => [
	record.name,
	record.kind,
	record.source,
	record.pin.kind,
	record.pin.value,
	record.treeSha256,
	record.approvedSha256,
];

describe("createApprovalSigner", () => {
	it("signs the approval fields to the shared fixture MAC for the fixture key", () => {
		const signer = createApprovalSigner(memoryStore(fixture.key));
		expect(signer.sign("approval", fieldsOf(fixture.records.signed))).toBe(fixture.expectedMac);
	});

	it("verifies the fixture MAC and refuses the bad-MAC record", () => {
		const signer = createApprovalSigner(memoryStore(fixture.key));
		const fields = fieldsOf(fixture.records.signed);
		expect(signer.verify("approval", fields, fixture.records.signed.mac)).toBe(true);
		expect(signer.verify("approval", fields, fixture.records.badMac.mac)).toBe(false);
		expect(signer.verify("approval", fields.with(0, "other"), fixture.expectedMac)).toBe(false);
	});

	it("creates a 32-byte lowercase hex key on first sign and reuses it", () => {
		const store = memoryStore();
		const signer = createApprovalSigner(store);
		const first = signer.sign("approval", fieldsOf(fixture.records.signed));
		const key = store.entries.get(APPROVAL_KEY_CREDENTIAL)?.value;
		expect(key).toMatch(/^[0-9a-f]{64}$/);
		expect(createApprovalSigner(store).sign("approval", fieldsOf(fixture.records.signed))).toBe(first);
		expect(store.entries.get(APPROVAL_KEY_CREDENTIAL)?.value).toBe(key);
	});

	it("never creates a key on verify, and verifies false while no key exists", () => {
		const store = memoryStore();
		const signer = createApprovalSigner(store);
		expect(signer.verify("approval", fieldsOf(fixture.records.signed), fixture.expectedMac)).toBe(false);
		expect(store.entries.size).toBe(0);
	});

	it("keeps the two purposes apart even for equal field text", () => {
		const signer = createApprovalSigner(memoryStore(fixture.key));
		const three = ["a", "b", "c"];
		const statcache = signer.sign("statcache", three);
		expect(statcache).toMatch(/^[0-9a-f]{64}$/);
		expect(signer.verify("approval", [...three, "d", "e", "f", "g"], statcache)).toBe(false);
		expect(signer.verify("statcache", three, statcache)).toBe(true);
		expect(signer.verify("approval", fieldsOf(fixture.records.signed), statcache)).toBe(false);
	});

	it("refuses to sign with a damaged stored key and verifies false", () => {
		const signer = createApprovalSigner(memoryStore("not-hex"));
		expect(() => signer.sign("approval", fieldsOf(fixture.records.signed))).toThrow(/damaged/);
		expect(signer.verify("approval", fieldsOf(fixture.records.signed), fixture.expectedMac)).toBe(false);
	});
});
