export const MAILBOX_ALIAS_KINDS = [
	"account",
	"run",
	"revision",
	"message",
	"folder",
	"label",
	"filter",
	"action",
	"cohort",
	"plan",
] as const;

export type MailboxAliasKind = (typeof MAILBOX_ALIAS_KINDS)[number];

export type MailboxAccountAliasScope = Readonly<{
	providerId: string;
	surface: string;
}>;

export type MailboxRunAliasScope = MailboxAccountAliasScope &
	Readonly<{
		accountAlias: string;
	}>;

export type MailboxRevisionAliasScope = MailboxRunAliasScope &
	Readonly<{
		runAlias: string;
	}>;

export type MailboxAliasScope = MailboxRevisionAliasScope &
	Readonly<{
		revisionAlias: string;
	}>;

export type MailboxAliasScopeForKind<Kind extends MailboxAliasKind> =
	Kind extends "account"
		? MailboxAccountAliasScope
		: Kind extends "run"
			? MailboxRunAliasScope
			: Kind extends "revision"
				? MailboxRevisionAliasScope
				: MailboxAliasScope;

export type SessionAliasRegistryDeps = Readonly<{
	randomBytes?: () => Uint8Array;
}>;

export type SessionAliasRegistry = Readonly<{
	bind<Kind extends MailboxAliasKind>(
		scope: MailboxAliasScopeForKind<Kind>,
		kind: Kind,
		rawValue: string,
	): string;
	resolve<Kind extends MailboxAliasKind>(
		scope: MailboxAliasScopeForKind<Kind>,
		kind: Kind,
		alias: string,
	): string;
	has<Kind extends MailboxAliasKind>(
		scope: MailboxAliasScopeForKind<Kind>,
		kind: Kind,
		alias: string,
	): boolean;
	clear(): void;
}>;

const PREFIXES: Record<MailboxAliasKind, string> = {
	account: "acct",
	run: "run",
	revision: "rev",
	message: "msg",
	folder: "fld",
	label: "lbl",
	filter: "flt",
	action: "act",
	cohort: "coh",
	plan: "plan",
};

const PROVIDER_ID = /^[a-z][a-z0-9-]{0,63}$/;
const SURFACE = /^[a-z][a-z0-9_-]{0,63}$/;
const SAFE_ALIAS = /^[a-z]{3,5}_[a-f0-9]{32}$/;

class AliasRegistryError extends Error {
	override readonly name = "AliasRegistryError";
}

function fail(message: "scope" | "collision" | "duplicate" | "alias"): never {
	throw new AliasRegistryError(`Mailbox alias ${message} error`);
}

function requireMatching(value: unknown, pattern: RegExp): string {
	if (typeof value !== "string" || !pattern.test(value)) fail("scope");
	return value;
}

export function isValidMailboxScopedAlias(
	value: unknown,
	prefix: string,
): value is string {
	if (
		typeof value !== "string" ||
		!value.startsWith(`${prefix}_`)
	) {
		return false;
	}
	try {
		validateMailboxError({
			schemaVersion: 1,
			code: "internal_failure",
			retryable: false,
			relatedAlias: value,
		});
		return true;
	} catch {
		return false;
	}
}

function requireScopedAlias(value: unknown, prefix: string): string {
	if (!isValidMailboxScopedAlias(value, prefix)) fail("scope");
	return value;
}

function scopeKey<Kind extends MailboxAliasKind>(
	scope: MailboxAliasScopeForKind<Kind>,
	kind: Kind,
): string {
	if (
		scope === null ||
		typeof scope !== "object" ||
		Object.getPrototypeOf(scope) !== Object.prototype
	) {
		fail("scope");
	}
	const expectedKeys =
		kind === "account"
			? ["providerId", "surface"]
			: kind === "run"
				? ["providerId", "surface", "accountAlias"]
				: kind === "revision"
					? ["providerId", "surface", "accountAlias", "runAlias"]
					: [
							"providerId",
							"surface",
							"accountAlias",
							"runAlias",
							"revisionAlias",
						];
	const keys = Reflect.ownKeys(scope);
	if (
		keys.some((key) => typeof key === "symbol") ||
		keys.length !== expectedKeys.length ||
		!expectedKeys.every((key) => keys.includes(key))
	) {
		fail("scope");
	}
	for (const key of keys as string[]) {
		const descriptor = Object.getOwnPropertyDescriptor(scope, key);
		if (!descriptor || "get" in descriptor || "set" in descriptor) {
			fail("scope");
		}
	}
	const values = [
		requireMatching(scope.providerId, PROVIDER_ID),
		requireMatching(scope.surface, SURFACE),
	];
	if ("accountAlias" in scope) {
		values.push(requireScopedAlias(scope.accountAlias, "acct"));
	}
	if ("runAlias" in scope) {
		values.push(requireScopedAlias(scope.runAlias, "run"));
	}
	if ("revisionAlias" in scope) {
		values.push(requireScopedAlias(scope.revisionAlias, "rev"));
	}
	return values.map((value) => `${value.length}:${value}`).join("|");
}

export function validateMailboxAliasScope(
	scope: MailboxAliasScope,
): MailboxAliasScope {
	scopeKey(scope, "message");
	return scope;
}

function requireKind(kind: string): asserts kind is MailboxAliasKind {
	if (!(MAILBOX_ALIAS_KINDS as readonly string[]).includes(kind)) fail("alias");
}

function defaultRandomBytes(): Uint8Array {
	const bytes = new Uint8Array(16);
	const cryptoApi = globalThis.crypto;
	if (!cryptoApi?.getRandomValues) {
		throw new AliasRegistryError("Mailbox alias entropy unavailable");
	}
	return cryptoApi.getRandomValues(bytes);
}

function encode(bytes: Uint8Array): string {
	if (
		!(bytes instanceof Uint8Array) ||
		Object.getPrototypeOf(bytes) !== Uint8Array.prototype ||
		bytes.byteLength < 16
	) {
		throw new AliasRegistryError("Mailbox alias entropy is insufficient");
	}
	const payload = bytes.subarray(0, 16);
	const meaningful = [...payload].filter((byte) => byte !== 0);
	if (
		new Set(payload).size < 8 ||
		(meaningful.length >= 4 &&
			meaningful.every((byte) => byte >= 0x20 && byte <= 0x7e))
	) {
		throw new AliasRegistryError("Mailbox alias entropy is insufficient");
	}
	return [...payload]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

type Binding = Readonly<{
	scopeKey: string;
	kind: MailboxAliasKind;
	rawValue: string;
}>;

/**
 * Keeps raw provider bindings in memory only. Alias material is random and
 * carries no reversible provider identifier or user-authored text.
 */
export function createSessionAliasRegistry(
	deps: SessionAliasRegistryDeps = {},
): SessionAliasRegistry {
	const randomBytes = deps.randomBytes ?? defaultRandomBytes;
	const byAlias = new Map<string, Binding>();
	const byRawBinding = new Map<string, string>();

	const requireParentBinding = (
		value: unknown,
		kind: MailboxAliasKind,
		expectedScopeKey: string,
	): void => {
		if (typeof value !== "string") fail("scope");
		const binding = byAlias.get(value);
		if (
			binding === undefined ||
			binding.kind !== kind ||
			binding.scopeKey !== expectedScopeKey
		) {
			fail("scope");
		}
	};

	const requireParentChain = <Kind extends MailboxAliasKind>(
		scope: MailboxAliasScopeForKind<Kind>,
		kind: Kind,
	): void => {
		if (kind === "account") return;
		if (!("accountAlias" in scope)) fail("scope");
		const accountScope = {
			providerId: scope.providerId,
			surface: scope.surface,
		};
		requireParentBinding(
			scope.accountAlias,
			"account",
			scopeKey(accountScope, "account"),
		);
		if (kind === "run") return;
		if (!("runAlias" in scope)) fail("scope");
		const runScope = {
			...accountScope,
			accountAlias: scope.accountAlias,
		};
		requireParentBinding(scope.runAlias, "run", scopeKey(runScope, "run"));
		if (kind === "revision") return;
		if (!("revisionAlias" in scope)) fail("scope");
		const revisionScope = {
			...runScope,
			runAlias: scope.runAlias,
		};
		requireParentBinding(
			scope.revisionAlias,
			"revision",
			scopeKey(revisionScope, "revision"),
		);
	};

	return Object.freeze({
			bind(scope, kind, rawValue) {
				requireKind(kind);
				const scoped = scopeKey(scope, kind);
				requireParentChain(scope, kind);
				if (
					typeof rawValue !== "string" ||
					rawValue.length === 0 ||
				rawValue.length > 4096
			) {
					fail("alias");
				}
				const rawBindingKey = `${scoped}|${kind.length}:${kind}|${rawValue.length}:${rawValue}`;
				const existing = byRawBinding.get(rawBindingKey);
				if (existing !== undefined) return existing;

			let entropy: Uint8Array;
			try {
				entropy = randomBytes();
			} catch {
				throw new AliasRegistryError("Mailbox alias entropy unavailable");
			}
				const alias = `${PREFIXES[kind]}_${encode(entropy)}`;
				if (!isValidMailboxScopedAlias(alias, PREFIXES[kind])) {
					throw new AliasRegistryError("Mailbox alias entropy is insufficient");
				}
				if (byAlias.has(alias)) fail("collision");
				byAlias.set(alias, Object.freeze({ scopeKey: scoped, kind, rawValue }));
				byRawBinding.set(rawBindingKey, alias);
				return alias;
			},
			resolve(scope, kind, alias) {
				requireKind(kind);
				if (typeof alias !== "string" || !SAFE_ALIAS.test(alias)) fail("alias");
				const binding = byAlias.get(alias);
				if (!binding) fail("alias");
				if (
					binding.scopeKey !== scopeKey(scope, kind) ||
					binding.kind !== kind
				) {
					fail("scope");
				}
				return binding.rawValue;
		},
		has(scope, kind, alias) {
			requireKind(kind);
				const binding = byAlias.get(alias);
				return (
					binding !== undefined &&
					binding.scopeKey === scopeKey(scope, kind) &&
					binding.kind === kind
				);
		},
		clear() {
			byAlias.clear();
			byRawBinding.clear();
		},
	});
}
import { validateMailboxError } from "@dg/common";
