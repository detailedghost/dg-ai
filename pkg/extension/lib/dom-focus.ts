const NON_TEXT_INPUT_TYPES = new Set([
	"button",
	"checkbox",
	"color",
	"file",
	"image",
	"radio",
	"range",
	"reset",
	"submit",
]);

/** Whether the document's active element is a text input, textarea, or contenteditable region. */
export function isTextEntryFocused(doc: Document): boolean {
	const active = doc.activeElement as HTMLElement | null;
	if (!active) return false;
	if (active.isContentEditable) return true;
	if (active.tagName === "TEXTAREA") return true;
	if (active.tagName !== "INPUT") return false;
	const type = (active as HTMLInputElement).type;
	return !NON_TEXT_INPUT_TYPES.has(type);
}
