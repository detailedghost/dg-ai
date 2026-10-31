/**
 * Extra seconds behind NIP-59's two-day gift-wrap backdate.
 *
 * nostr-tools rounds that backdate, so a wrap can land on exactly two days.
 * The cursor is the wall clock at the start of a fetch, which is ahead of a
 * wrap the relay had not returned yet. Without this margin the next `since`
 * moves past that wrap.
 */
export const SINCE_MARGIN_SECONDS = 60 * 60;

/** Relay `since` for one catch-up. Never looks further back than the message ttl, and never negative. */
export function relaySince(cursor: number, now: number, lookback: number, ttl: number, margin = SINCE_MARGIN_SECONDS): number {
	return Math.max(0, cursor - lookback - margin, now - ttl);
}
