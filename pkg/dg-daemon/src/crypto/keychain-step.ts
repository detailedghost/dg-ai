import type { Outcome } from "@dg/common/node/layout";
import type { KeychainBackend, KeychainLookupResult } from "./key-resolution";
import { ACCOUNT, guardedBackend } from "./keychain-backends";

export type KeychainMoveResult = "moved" | "kept" | "absent";

export type KeychainPair = { current: KeychainBackend; legacy: KeychainBackend };

type KeepReason = "legacy-unreadable" | "current-unwritable" | "unverified" | "differs";

type KeychainMoveAction =
	| { kind: "skip" }
	| { kind: "copy"; key: string }
	| { kind: "drop" }
	| { kind: "keep"; reason: KeepReason };

type KeychainMoveInput = {
	current: KeychainLookupResult;
	legacy: KeychainLookupResult;
	daemonOutcome: Outcome["kind"] | undefined;
};

const keep = (reason: KeepReason): KeychainMoveAction => ({ kind: "keep", reason });

function decideFound(
	key: string,
	current: KeychainLookupResult,
	daemonOutcome: KeychainMoveInput["daemonOutcome"],
): KeychainMoveAction {
	switch (current.status) {
		case "absent":
			return { kind: "copy", key };
		case "unreachable":
			return keep("current-unwritable");
		case "found":
			if (current.keyBase64 === key) return { kind: "drop" };
			return daemonOutcome === "setAside" ? { kind: "copy", key } : keep("differs");
	}
}

/** Picks the one action for the two lookups. */
export function decideKeychainMove({ current, legacy, daemonOutcome }: KeychainMoveInput): KeychainMoveAction {
	switch (legacy.status) {
		case "absent":
			return { kind: "skip" };
		case "unreachable":
			return keep("legacy-unreadable");
		case "found":
			return decideFound(legacy.keyBase64, current, daemonOutcome);
	}
}

const KEEP_OLD = "dg keeps the old entry and reads it from the old account";

const say = (reason: string, outcome: string): string => `dg: keychain secret ${ACCOUNT} ${reason}; ${outcome}`;

const KEEP_LINES: Record<KeepReason, (currentAccount: string) => string> = {
	"legacy-unreadable": () => say("could not be read from the old account", "dg leaves both accounts as they are"),
	"current-unwritable": () => say("could not be written to the new account", KEEP_OLD),
	unverified: () => say("did not read back the same from the new account", KEEP_OLD),
	differs: (currentAccount) =>
		say(
			"differs between the old and the new account",
			`dg reads the new account. If the daemon refuses the key, delete the entry ${currentAccount} and start the daemon again`,
		),
};

const UNDELETED_LINE = say(
	"moved to the new account, but the old entry could not be deleted",
	"dg reads the new account, and a copy stays in the old one",
);

type Step = { pair: KeychainPair; currentAccount: string; legacyAccount: string; warn: (line: string) => void };

type KeychainMoveContext = Step & { daemonOutcome: KeychainMoveInput["daemonOutcome"] };

function kept({ warn, currentAccount }: Step, reason: KeepReason): "kept" {
	warn(KEEP_LINES[reason](currentAccount));
	return "kept";
}

async function dropLegacy({ pair, warn }: Step): Promise<"moved"> {
	if ((await pair.legacy.remove?.()) !== "removed") warn(UNDELETED_LINE);
	return "moved";
}

async function copyThenDrop(step: Step, key: string, overwrite: boolean): Promise<KeychainMoveResult> {
	const { current } = step.pair;
	if ((await current.store(key)) !== "stored") return kept(step, overwrite ? "differs" : "current-unwritable");
	const check = await current.lookup();
	if (check.status !== "found" || check.keyBase64 !== key) return kept(step, overwrite ? "differs" : "unverified");
	return dropLegacy(step);
}

/** Copies the old-account key, reads it back, then deletes the old entry; any failure keeps both and warns once. */
export async function moveKeychainKey({ daemonOutcome, pair, ...rest }: KeychainMoveContext): Promise<KeychainMoveResult> {
	const step: Step = { ...rest, pair: { current: guardedBackend(pair.current), legacy: guardedBackend(pair.legacy) } };
	if (step.currentAccount === step.legacyAccount) return "absent";
	const legacy = await step.pair.legacy.lookup();
	if (legacy.status === "absent") return "absent";
	const current = await step.pair.current.lookup();
	const action = decideKeychainMove({ current, legacy, daemonOutcome });
	switch (action.kind) {
		case "skip":
			return "absent";
		case "keep":
			return kept(step, action.reason);
		case "drop":
			return dropLegacy(step);
		case "copy":
			return copyThenDrop(step, action.key, current.status === "found");
	}
}
