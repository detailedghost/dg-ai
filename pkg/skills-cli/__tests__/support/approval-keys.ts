import { randomBytes } from "node:crypto";
import { mock } from "bun:test";
import * as common from "@dg/common/node";
import { DaemonNotRunningError } from "@dg/common/node";
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

export function downKeys(error: Error = new DaemonNotRunningError()): ApprovalKeys {
	const fail = async (): Promise<never> => {
		throw error;
	};
	return { read: fail, ensure: fail };
}

const realCreateCredentialClient = common.createCredentialClient;

export function useApprovalKeys(keys: ApprovalKeys | undefined): void {
	const create = keys === undefined ? realCreateCredentialClient : () => ({
		get: async () => {
			const key = await keys.read();
			return key === undefined ? undefined : { value: key.toString("hex") };
		},
		set: async (_name: string, value: string) => {
			(keys as FakeKeys).stored = Buffer.from(value, "hex");
		},
		close: () => undefined,
	});
	mock.module("@dg/common/node", () => ({ ...common, createCredentialClient: create }));
}
