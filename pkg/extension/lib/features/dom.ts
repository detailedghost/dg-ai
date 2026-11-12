export function element<K extends keyof HTMLElementTagNameMap>(
	doc: Document,
	tag: K,
	className = "",
	text?: string,
): HTMLElementTagNameMap[K] {
	const node = doc.createElement(tag);
	if (className) node.className = className;
	if (text !== undefined) node.textContent = text;
	return node;
}

export function button(
	doc: Document,
	className: string,
	text: string,
	onClick: () => void,
): HTMLButtonElement {
	const node = element(doc, "button", className, text);
	node.type = "button";
	node.addEventListener("click", onClick);
	return node;
}
