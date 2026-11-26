import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mock } from "bun:test";
import * as common from "@dg/common/node";
import { DaemonNotRunningError } from "@dg/common/node";
import { approvalFields } from "../../src/plugin/approval";
import type { PluginRecord } from "../../src/plugin/store";

export const TEST_KEY_HEX = "00112233445566778899aabbccddeeff102132435465768798a9bacbdcedfe0f";
const DOMAIN = "dg-plugin-approval-v1";

export type FakeDaemon = {
	key: Buffer | undefined;
	opened: number;
	closed: number;
	keyReads: number;
	signs: number;
	verifies: number;
};

const hmac = (key: Buffer, fields: string[]) => createHmac("sha256", key).update([DOMAIN, ...fields].join("\0")).digest();

/** Signs a record the way the daemon does for the fixture key, to forge test fixtures. */
export const signRecord = (record: PluginRecord, keyHex = TEST_KEY_HEX): string => hmac(Buffer.from(keyHex, "hex"), approvalFields(record)).toString("hex");

export function fakeDaemon(initial: string | null = TEST_KEY_HEX): FakeDaemon {
	return { key: initial === null ? undefined : Buffer.from(initial, "hex"), opened: 0, closed: 0, keyReads: 0, signs: 0, verifies: 0 };
}

export type DownDaemon = { error: Error };

export const downDaemon = (error: Error = new DaemonNotRunningError()): DownDaemon => ({ error });

const realCreateCredentialClient = common.createCredentialClient;

export function useApprovalDaemon(daemon: FakeDaemon | DownDaemon | undefined): void {
	if (daemon === undefined) {
		mock.module("@dg/common/node", () => ({ ...common, createCredentialClient: realCreateCredentialClient }));
		return;
	}
	const down = "error" in daemon;
	const refuseKey = async (): Promise<never> => {
		if (!down) daemon.keyReads++;
		throw new Error("the CLI must never read or write the approval key credential");
	};
	const create = () => {
		if (!down) daemon.opened++;
		return {
			approvalSign: async (purpose: string, fields: string[]) => {
				if (down) throw daemon.error;
				if (purpose !== "approval") throw new Error(`unexpected purpose ${purpose}`);
				daemon.signs++;
				daemon.key ??= randomBytes(32);
				return hmac(daemon.key, fields).toString("hex");
			},
			approvalVerify: async (purpose: string, fields: string[], mac: string) => {
				if (down) throw daemon.error;
				if (purpose !== "approval") throw new Error(`unexpected purpose ${purpose}`);
				daemon.verifies++;
				if (daemon.key === undefined) return false;
				return timingSafeEqual(hmac(daemon.key, fields), Buffer.from(mac, "hex"));
			},
			get: refuseKey,
			set: refuseKey,
			list: refuseKey,
			exec: refuseKey,
			close: () => {
				if (!down) daemon.closed++;
			},
		};
	};
	mock.module("@dg/common/node", () => ({ ...common, createCredentialClient: create }));
}
