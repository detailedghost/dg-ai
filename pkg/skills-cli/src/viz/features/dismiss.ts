import { die, note } from "../io";
import { clearAwaitingVerdict, readPayload, validateSlug } from "../session";

/** Release the awaiting-verdict marker without a submitted verdict. */
export function cmdDismiss(rest: string[]): void {
	const rawSlug = rest[0];
	if (!rawSlug) die("usage: dg-skills viz dismiss <slug>");
	const slug = validateSlug(rawSlug);
	readPayload(slug);
	clearAwaitingVerdict(slug);
	note(`${slug}: no longer awaiting a verdict`);
}
