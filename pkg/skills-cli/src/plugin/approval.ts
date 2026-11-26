import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createCredentialClient, DaemonNotRunningError, resolveDgPaths } from "@dg/common/node";
import { type Env, type PluginRecord, pluginSrcDir } from "./store";
import { hashTree } from "./tree";

export const APPROVAL_KEY_CREDENTIAL = "dg/plugin-approval-key";
const MAC_DOMAIN = "dg-plugin-approval-v1";
const KEY_HEX = /^[0-9a-f]{64}$/;

export type ApprovalKeys = {
	read(): Promise<Buffer | undefined>;
	ensure(): Promise<Buffer>;
};

type KeyStore = {
	get(name: string): Promise<{ value: string } | undefined>;
	set(name: string, value: string): Promise<void>;
	close?(): void;
};

export function macOf(record: PluginRecord, key: Buffer): string {
	const fields = [MAC_DOMAIN, record.name, record.kind, record.source, record.pin.kind, record.pin.value, record.treeSha256, record.approvedSha256 ?? ""];
	return createHmac("sha256", key).update(fields.join("\0")).digest("hex");
}

function macMatches(record: PluginRecord, key: Buffer): boolean {
	if (record.mac === null || !KEY_HEX.test(record.mac)) return false;
	return timingSafeEqual(Buffer.from(record.mac, "hex"), Buffer.from(macOf(record, key), "hex"));
}

export function credentialApprovalKeys(open: () => KeyStore): ApprovalKeys {
	let cached: Buffer | undefined;
	const lookup = async (store: KeyStore): Promise<Buffer | undefined> => {
		if (cached !== undefined) return cached;
		const stored = await store.get(APPROVAL_KEY_CREDENTIAL);
		if (stored === undefined || !KEY_HEX.test(stored.value)) return undefined;
		return (cached = Buffer.from(stored.value, "hex"));
	};
	return {
		read: async () => {
			if (cached !== undefined) return cached;
			const store = open();
			try {
				return await lookup(store);
			} finally {
				store.close?.();
			}
		},
		ensure: async () => {
			if (cached !== undefined) return cached;
			const store = open();
			try {
				const existing = await lookup(store);
				if (existing !== undefined) return existing;
				await store.set(APPROVAL_KEY_CREDENTIAL, randomBytes(32).toString("hex"));
				const stored = await lookup(store);
				if (stored === undefined) throw new Error("dg plugin: the dg daemon did not keep the approval key. Next: run dg doctor, then try again.");
				return stored;
			} finally {
				store.close?.();
			}
		},
	};
}

let override: ApprovalKeys | undefined;
let shared: ApprovalKeys | undefined;

/** Test seam: replaces the credential-store key for this process; pass undefined to restore it. */
export function overrideApprovalKeys(keys: ApprovalKeys | undefined): void {
	override = keys;
}

export function defaultApprovalKeys(env: Env): ApprovalKeys {
	return override ?? (shared ??= credentialApprovalKeys(() => createCredentialClient({ paths: resolveDgPaths({ env }), env })));
}

const reapprove = (name: string) => `re-approve with dg plugin verify ${name} --approve`;

/** Why the record is not approved, or undefined when it is. Asks for the key only after the cheap checks pass. */
export async function approvalProblem(record: PluginRecord, env: Env, keys: ApprovalKeys = defaultApprovalKeys(env)): Promise<string | undefined> {
	const { name, approvedSha256, treeSha256, mac } = record;
	if (approvedSha256 === null || approvedSha256 !== treeSha256) return `Next: review it, then run dg plugin verify ${name} --approve.`;
	if (mac === null) return `It has no signed approval. Next: ${reapprove(name)}.`;
	let key: Buffer | undefined;
	try {
		key = await keys.read();
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		return error instanceof DaemonNotRunningError
			? `${detail}. Next: start the dg daemon, then try again.`
			: `Cannot read the approval key: ${detail}. Next: check the dg daemon with dg doctor, then try again.`;
	}
	if (key === undefined) return `There is no approval key in the dg credential store. Next: ${reapprove(name)}.`;
	if (!macMatches(record, key)) return `Its approval signature does not verify. Next: ${reapprove(name)}.`;
	if (hashTree(pluginSrcDir(name, env)) !== treeSha256) return `Its files changed since approval. Next: ${reapprove(name)}.`;
	return undefined;
}

export async function isApproved(record: PluginRecord, env: Env, keys: ApprovalKeys = defaultApprovalKeys(env)): Promise<boolean> {
	return (await approvalProblem(record, env, keys)) === undefined;
}
