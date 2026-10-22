const BUTTONS = ["left", "right", "middle"] as const;
const MODIFIERS = ["Alt", "Control", "ControlOrMeta", "Meta", "Shift"] as const;

export type Button = (typeof BUTTONS)[number];
export type Modifier = (typeof MODIFIERS)[number];

export function parseButton(value: string | undefined): Button {
	if (value === undefined) return "left";
	const match = BUTTONS.find((button) => button === value);
	if (!match) throw new Error(`Unsupported button '${value}': use ${BUTTONS.join(", ")}`);
	return match;
}

export function parseModifiers(value: string | undefined): Modifier[] {
	if (!value) return [];
	return value.split(",").map((raw) => {
		const match = MODIFIERS.find((modifier) => modifier === raw.trim());
		if (!match) throw new Error(`Unsupported modifier '${raw}': use ${MODIFIERS.join(", ")}`);
		return match;
	});
}

export function pointerOptions(button: Button, modifiers: Modifier[]): string {
	const options = { ...(button === "left" ? {} : { button }), ...(modifiers.length > 0 ? { modifiers } : {}) };
	return Object.keys(options).length > 0 ? JSON.stringify(options) : "";
}
