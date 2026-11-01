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
