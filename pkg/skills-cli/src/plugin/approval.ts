import { createCredentialClient, DaemonNotRunningError, resolveDgPaths } from "@dg/common/node";
import { DgCliError } from "@dg/common";
import { type Env, HEX64, type PluginRecord, pluginSrcDir } from "./store";
import { hashTree } from "./tree";

export type ApprovalSigner = {
	sign(fields: string[]): Promise<string>;
	verify(fields: string[], mac: string): Promise<boolean>;
	close(): void;
};

export function approvalFields(record: PluginRecord): string[] {
	return [record.name, record.kind, record.source, record.pin.kind, record.pin.value, record.treeSha256, record.approvedSha256 ?? ""];
}

const hasNul = (record: PluginRecord): boolean => approvalFields(record).some((field) => field.includes("\0"));

/** Asks the dg daemon over one lazily opened credential client; the approval key never reaches this process. */
export function daemonApprovalSigner(env: Env): ApprovalSigner {
	let client: ReturnType<typeof createCredentialClient> | undefined;
	const open = () => (client ??= createCredentialClient({ paths: resolveDgPaths({ env }), env }));
	return {
		sign: (fields) => open().approvalSign("approval", fields),
		verify: (fields, mac) => open().approvalVerify("approval", fields, mac),
		close: () => client?.close(),
	};
}

/** Runs `run` with the given signer, or with one daemon signer that closes when it ends. */
export async function withApprovalSigner<T>(env: Env, given: ApprovalSigner | undefined, run: (signer: ApprovalSigner) => Promise<T>): Promise<T> {
	const signer = given ?? daemonApprovalSigner(env);
	try {
		return await run(signer);
	} finally {
		if (given === undefined) signer.close();
	}
}

export async function signApproval(record: PluginRecord, signer: ApprovalSigner): Promise<string> {
	if (hasNul(record)) throw new DgCliError(`dg plugin: ${record.name} has a NUL byte in a signed field, so dg will not sign it.`);
	try {
		return await signer.sign(approvalFields(record));
	} catch (error) {
		if (error instanceof DaemonNotRunningError) throw new DgCliError(`dg plugin: cannot approve ${record.name}: ${error.message}. Next: start the dg daemon, then try again.`);
		const detail = error instanceof Error ? error.message : String(error);
		throw new DgCliError(`dg plugin: the dg daemon did not sign the approval: ${detail}. Next: check the dg daemon with dg doctor, then try again.`);
	}
}

const reapprove = (name: string) => `re-approve with dg plugin verify ${name} --approve`;

/** Why the record is not approved, or undefined when it is. Asks the daemon only after the cheap checks pass. */
export async function approvalProblem(record: PluginRecord, env: Env, given?: ApprovalSigner): Promise<string | undefined> {
	const { name, approvedSha256, treeSha256, mac } = record;
	if (approvedSha256 === null || approvedSha256 !== treeSha256) return `Next: review it, then run dg plugin verify ${name} --approve.`;
	if (hasNul(record)) return "A signed field holds a NUL byte, so dg never approves it. Next: remove the plugin and add it again.";
	if (mac === null) return `It has no signed approval. Next: ${reapprove(name)}.`;
	let verified: boolean;
	try {
		verified = HEX64.test(mac) && (await withApprovalSigner(env, given, (signer) => signer.verify(approvalFields(record), mac)));
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		return error instanceof DaemonNotRunningError
			? `${detail}. Next: start the dg daemon, then try again.`
			: `Cannot verify the approval with the dg daemon: ${detail}. Next: check the dg daemon with dg doctor, then try again.`;
	}
	if (!verified) return `Its approval signature does not verify. Next: ${reapprove(name)}.`;
	if (hashTree(pluginSrcDir(name, env)) !== treeSha256) return `Its files changed since approval. Next: ${reapprove(name)}.`;
	return undefined;
}

export async function isApproved(record: PluginRecord, env: Env, signer?: ApprovalSigner): Promise<boolean> {
	return (await approvalProblem(record, env, signer)) === undefined;
}
