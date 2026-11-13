import { validateCredentialName } from "@dg/common";
import { DaemonNotRunningError } from "@dg/common/node";
import type { KeyClient } from "../../src/phone/keys";
import type { VaultClient, VaultDeps, VaultKeyDeps } from "../../src/phone/vault";

/** An in-memory credential store standing in for dg-daemon; tests never reach the real one. */
export type FakeCredentials = {
	store: Map<string, string>;
	up: boolean;
	session: boolean;
	granted: boolean;
	calls: string[];
	/** Awaited inside each session set, so a spec can hold one write open. */
	beforeSet?: () => Promise<void>;
	/** Thrown by every store call, in place of the usual up/grant checks. */
	failure?: Error;
	/** Thrown by the session factory itself, before a client is returned. */
	sessionFailure?: Error;
	/** A get that succeeds as "no such credential", so a write cannot be read back. */
	hideRead?: boolean;
	deps: () => VaultDeps;
	keyDeps: (paths: VaultKeyDeps["paths"]) => VaultKeyDeps;
};

export function createFakeCredentials(opts: { session?: boolean; granted?: boolean } = {}): FakeCredentials {
	const fake: FakeCredentials = {
		store: new Map(),
		up: true,
		session: opts.session ?? true,
		granted: opts.granted ?? false,
		calls: [],
		deps: () => ({ vaultClient, sessionClient }),
		keyDeps: (paths) => ({ vaultClient, sessionClient, paths }),
	};
	const down = () => {
		if (fake.failure) throw fake.failure;
		if (!fake.up) throw new DaemonNotRunningError();
	};
	const vaultClient = (): VaultClient => ({
		async get(name) {
			down();
			if (!fake.granted) throw new Error("no credential grant for phone-vault");
			if (fake.hideRead) return undefined;
			const canonical = validateCredentialName(name);
			fake.calls.push(`get ${canonical}`);
			const value = fake.store.get(canonical);
			return value === undefined ? undefined : { value, meta: {}, updatedAt: "" };
		},
		async list() {
			down();
			if (!fake.granted) throw new Error("no credential grant for phone-vault");
			fake.calls.push("list");
			return [...fake.store.keys()].filter((name) => name.startsWith("phone-vault/")).map((name) => ({ name, meta: {}, updatedAt: "" }));
		},
		close() {},
	});
	const sessionClient = async (): Promise<KeyClient | undefined> => {
		if (fake.sessionFailure) throw fake.sessionFailure;
		if (!fake.session || !fake.up) return undefined;
		return {
			async get(name) {
				down();
				if (fake.hideRead) return undefined;
				const canonical = validateCredentialName(name);
				const value = fake.store.get(canonical);
				return value === undefined ? undefined : { value, meta: {}, updatedAt: "" };
			},
			async set(name, value) {
				down();
				const canonical = validateCredentialName(name);
				await fake.beforeSet?.();
				fake.calls.push(`set ${canonical}`);
				fake.store.set(canonical, value);
			},
			async delete(name) {
				down();
				const canonical = validateCredentialName(name);
				fake.calls.push(`delete ${canonical}`);
				const removed = fake.store.delete(canonical);
				return (name === canonical ? false : fake.store.delete(name)) || removed;
			},
			async grant(prefix) {
				down();
				fake.calls.push(`grant ${prefix}`);
				fake.granted = true;
				return { prefix, path: "" };
			},
			close() {},
		};
	};
	return fake;
}
