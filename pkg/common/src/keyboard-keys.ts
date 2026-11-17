const NAMED = [
	"Enter",
	"Escape",
	"Tab",
	"Backspace",
	"Delete",
	"Insert",
	"Home",
	"End",
	"PageUp",
	"PageDown",
	"ArrowLeft",
	"ArrowRight",
	"ArrowUp",
	"ArrowDown",
	"Space",
	"Shift",
	"Control",
	"Alt",
	"Meta",
	"ControlOrMeta",
	"CapsLock",
	...Array.from({ length: 12 }, (_, i) => `F${i + 1}`),
];

const BY_LOWERCASE = new Map(NAMED.map((name) => [name.toLowerCase(), name]));

export const normalizeKey = (key: string): string =>
	key
		.split("+")
		.map((part) =>
			part.length > 1 ? (BY_LOWERCASE.get(part.toLowerCase()) ?? part) : part,
		)
		.join("+");

export const KEY_MODIFIERS = ["Shift", "Control", "Alt", "Meta", "ControlOrMeta"] as const;
export type KeyModifier = (typeof KEY_MODIFIERS)[number];

/** A normalized key chord split into its modifiers and the one key they hold. */
export type KeyChord = { key: string; modifiers: KeyModifier[] };

const CHORD_KEYS = new Set(NAMED.filter((name) => !(KEY_MODIFIERS as readonly string[]).includes(name)));

/** Splits a normalized chord such as Shift+Tab, Control+a or Enter; undefined when it is not one. */
export function parseKeyChord(chord: string): KeyChord | undefined {
	if (chord.length === 0 || chord.length > 64) return undefined;
	if (chord.endsWith("+") && chord !== "+" && !chord.endsWith("++")) return undefined;
	const parts = chord.endsWith("+") ? [...chord.slice(0, -1).split("+").slice(0, -1), "+"] : chord.split("+");
	const key = parts.pop() as string;
	if (!(CHORD_KEYS.has(key) || (KEY_MODIFIERS as readonly string[]).includes(key) || [...key].length === 1))
		return undefined;
	const modifiers = parts as KeyModifier[];
	if (modifiers.some((part) => !(KEY_MODIFIERS as readonly string[]).includes(part))) return undefined;
	if (new Set([...modifiers, key]).size !== modifiers.length + 1) return undefined;
	return { key, modifiers };
}
