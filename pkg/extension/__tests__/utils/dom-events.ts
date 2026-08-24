import { Window } from "happy-dom";

export function createTestContainer(): HTMLElement {
	const window = new Window();
	const document = window.document as unknown as Document;
	return document.createElement("div") as unknown as HTMLElement;
}

function view<T>(el: { ownerDocument: Document }, name: string): T {
	return (el.ownerDocument.defaultView as unknown as Record<string, T>)[
		name
	] as T;
}

function ownerDocumentOf(target: HTMLElement | Document): {
	ownerDocument: Document;
} {
	return "defaultView" in target ? { ownerDocument: target } : target;
}

export function keydown(target: HTMLElement | Document, key: string): void {
	const Ctor = view<typeof KeyboardEvent>(
		ownerDocumentOf(target),
		"KeyboardEvent",
	);
	target.dispatchEvent(
		new Ctor("keydown", { key, bubbles: true, cancelable: true }),
	);
}

export function fire(el: HTMLElement, type: string): void {
	const Ctor = view<typeof Event>(el, "Event");
	el.dispatchEvent(new Ctor(type, { bubbles: true }));
}

export function typeValue(el: HTMLInputElement, value: string): void {
	el.value = value;
	fire(el, "input");
}

export function click(el: HTMLElement): void {
	const Ctor = view<typeof Event>(el, "Event");
	el.dispatchEvent(new Ctor("click", { bubbles: true, cancelable: true }));
}

export function pointer(
	el: HTMLElement,
	type: "pointerdown" | "pointermove" | "pointerup",
	init: { clientX: number; clientY: number; pointerId?: number },
): void {
	const Ctor = view<typeof Event>(el, "Event");
	const event = new Ctor(type, { bubbles: true, cancelable: true });
	Object.assign(event, {
		clientX: init.clientX,
		clientY: init.clientY,
		pointerId: init.pointerId ?? 1,
		button: 0,
	});
	const target =
		type === "pointerdown" ? el : (el.ownerDocument as unknown as HTMLElement);
	target.dispatchEvent(event);
}
