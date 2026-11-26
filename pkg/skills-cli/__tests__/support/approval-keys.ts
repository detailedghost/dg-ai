import { randomBytes } from "node:crypto";
import type { ApprovalKeys } from "../../src/plugin/approval";

export const TEST_KEY_HEX = "00112233445566778899aabbccddeeff102132435465768798a9bacbdcedfe0f";

export type FakeKeys = ApprovalKeys & { stored: Buffer | undefined };

export function fakeKeys(initial: string | null = TEST_KEY_HEX): FakeKeys {
	const keys: FakeKeys = {
		stored: initial === null ? undefined : Buffer.from(initial, "hex"),
		read: async () => keys.stored,
		ensure: async () => (keys.stored ??= randomBytes(32)),
	};
	return keys;
}

export function downKeys(message = "dg daemon is not running; start it with dg agent start"): ApprovalKeys {
	const fail = async (): Promise<never> => {
		throw new Error(message);
	};
	return { read: fail, ensure: fail };
}
