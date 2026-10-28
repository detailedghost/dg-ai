import { DgCliError } from "@dg/common";
import type { PhoneDb } from "./db";
import { ensureKey, type KeyDeps, loadKey } from "./keys";
import {
	type ContactRecord,
	findContactByHandle,
	findContactByNpub,
	isHandle,
	normalizeHandle,
	numberKeyId,
} from "./store";

/**
 * Card self name that is not a name anyone chose.
 *
 * A current `number` or `invite` with no `--as` carries `dg` (`FALLBACK_SELF_NAME`), not this
 * string. `default` is also the fresh number-key id and the old phone-friend line name. Those
 * are different fields. This check looks only at the card's self name.
 */
export const UNNAMED_CARD_SELF_NAME = "default";

export type AcceptOpts = { name?: string; key?: string };

const UNNAMED_CARD_MESSAGE =
	'this call card\'s self name is missing or "default"; pass --name <handle> to accept it';

function differentContactMessage(handle: string): string {
	return `+${handle} already belongs to a different contact; rename or remove it before accepting this card`;
}

/** Handle to store for this card, or a `DgCliError` before any contact or key row is written.
 * A known npub keeps its handle. A new contact uses `--name` or the card's self name, and never
 * a suffixed duplicate and never another contact's row. */
export function resolveAcceptHandle(
	db: PhoneDb,
	cardHandle: string | undefined,
	cardNpub: string,
	explicitName: string | undefined,
): { handle: string; existing: ContactRecord | undefined } {
	let explicit: string | undefined;
	if (explicitName !== undefined) {
		explicit = normalizeHandle(explicitName);
		if (!isHandle(explicit)) {
			throw new DgCliError(
				`--name must be 1-32 lowercase letters, digits, or dashes, got "${explicitName}"`,
			);
		}
	}
	const existing = findContactByNpub(db, cardNpub);
	if (existing) {
		if (explicit !== undefined && explicit !== existing.handle) {
			throw new DgCliError(
				`this npub is already +${existing.handle}; rename or remove that contact before accepting it under a new name`,
			);
		}
		return { handle: existing.handle, existing };
	}
	if (explicit !== undefined) {
		const taken = findContactByHandle(db, explicit);
		if (taken) throw new DgCliError(differentContactMessage(taken.handle));
		return { handle: explicit, existing: undefined };
	}
	if (cardHandle === undefined || cardHandle === UNNAMED_CARD_SELF_NAME) {
		throw new DgCliError(UNNAMED_CARD_MESSAGE);
	}
	const taken = findContactByHandle(db, cardHandle);
	if (taken) throw new DgCliError(differentContactMessage(taken.handle));
	return { handle: cardHandle, existing: undefined };
}

/** Key that signs this accept. An existing contact keeps its own key. A new contact uses `--key`
 * when that row already exists, otherwise the number key. That key is `default` until migration
 * sets `number_key`. `--key` never mints a row. */
export async function signingKeyForAccept(
	deps: KeyDeps,
	existing: ContactRecord | undefined,
	keyOpt: string | undefined,
): Promise<{ keyId: string; sk: Uint8Array }> {
	if (existing) {
		if (keyOpt !== undefined && keyOpt !== existing.keyId) {
			throw new DgCliError(
				`+${existing.handle} stays on key "${existing.keyId}"; phone accept will not switch its key`,
			);
		}
		const loaded = await loadKey(deps, existing.keyId);
		if (!loaded) throw new DgCliError(`the key for +${existing.handle} is not available`);
		return { keyId: existing.keyId, sk: loaded.sk };
	}
	if (keyOpt !== undefined) {
		const loaded = await loadKey(deps, keyOpt);
		if (!loaded) throw new DgCliError(`no phone key "${keyOpt}"; phone accept will not create one`);
		return { keyId: keyOpt, sk: loaded.sk };
	}
	const keyId = numberKeyId(deps.db);
	return { keyId, sk: (await ensureKey(deps, keyId)).sk };
}
