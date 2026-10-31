import { PHONE_SYSTEM_SENDER, type MessageRow } from "./db";

export function acceptNotice(handle: string): string {
	return `accepted +${handle}`;
}

export function newContactNotice(handle: string): string {
	return `new contact +${handle}`;
}

function isMessage(row: MessageRow): boolean {
	return row.direction === "in" || row.direction === "out";
}

function matchesPeer(row: MessageRow, peer: { npub: string; handle: string }): boolean {
	if (row.contact === peer.npub || row.sender === peer.npub) return true;
	if (row.sender !== PHONE_SYSTEM_SENDER) return false;
	const text = row.text;
	return text === acceptNotice(peer.handle) || text === newContactNotice(peer.handle);
}

/**
 * Newest `limit` inbox rows, returned oldest first.
 * A handle filter matches the peer npub on `contact` or `sender`, so a row
 * stored under a key id such as `default`, or under a handle from before a
 * rename, still belongs to that contact. Read and unread rows both match.
 * `rowsNewestFirst` is every stored message, newest first.
 */
export function selectInbox(
	rowsNewestFirst: readonly MessageRow[],
	limit: number,
	peer?: { npub: string; handle: string },
): MessageRow[] {
	const matched = rowsNewestFirst.filter((row) => isMessage(row) && (peer === undefined || matchesPeer(row, peer)));
	return matched.slice(0, limit).reverse();
}
