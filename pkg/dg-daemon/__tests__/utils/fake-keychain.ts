import type { KeychainBackend, KeychainLookupResult } from "../../src/crypto/key-resolution";

export const SECRET = Buffer.from("secret-key-encryption-key-32bytes").toString("base64");
export const OTHER_SECRET = Buffer.from("another-key-encryption-key-bytes").toString("base64");

export type FakeOptions = {
	label?: string;
	events?: string[];
	storeFails?: boolean;
	storeAs?: string;
	storeUpdates?: boolean;
	removeFails?: boolean;
	lookupUnreachable?: boolean;
	rejectWith?: string;
	reads?: KeychainLookupResult[];
	delayMs?: number;
};

export type FakeKeychain = {
	value?: string;
	calls: string[];
	count: (call: string) => number;
	backend: KeychainBackend;
};

export function fakeKeychain(value: string | undefined, options: FakeOptions = {}): FakeKeychain {
	const { label = "fake", events, delayMs = 0 } = options;
	const reads = [...(options.reads ?? [])];
	const enter = async (call: string): Promise<void> => {
		fake.calls.push(call);
		events?.push(`${label}.${call}`);
		if (delayMs > 0) await Bun.sleep(delayMs);
		if (options.rejectWith !== undefined) throw new Error(options.rejectWith);
	};
	const fake: FakeKeychain = {
		value,
		calls: [],
		count: (call) => fake.calls.filter((entry) => entry === call).length,
		backend: {
			async lookup(): Promise<KeychainLookupResult> {
				await enter("lookup");
				const scripted = reads.shift();
				if (scripted) return scripted;
				if (options.lookupUnreachable) return { status: "unreachable" };
				return fake.value === undefined ? { status: "absent" } : { status: "found", keyBase64: fake.value };
			},
			async store(keyBase64) {
				await enter("store");
				if (options.storeFails) return "unreachable";
				if (options.storeUpdates === false && fake.value !== undefined) return "unreachable";
				fake.value = options.storeAs ?? keyBase64;
				return "stored";
			},
			async remove() {
				await enter("remove");
				if (options.removeFails) return "unreachable";
				fake.value = undefined;
				return "removed";
			},
		},
	};
	return fake;
}
