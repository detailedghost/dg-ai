export interface FakeNode {
	textContent: string;
	attrs: Record<string, string>;
	click(): void;
	getAttribute(name: string): string | null;
}

export function node(text: string, attrs: Record<string, string> = {}): FakeNode {
	return {
		textContent: text,
		attrs,
		click() {},
		getAttribute(name) {
			return Object.prototype.hasOwnProperty.call(attrs, name) ? (attrs[name] ?? null) : null;
		},
	};
}

export function createDocument(nodes: FakeNode[], bodyText: string) {
	const clicks: string[] = [];
	for (const item of nodes) {
		item.click = () => {
			clicks.push(item.textContent || item.attrs["data-conversation-id"] || "");
			if (item.textContent === "Load more conversations") {
				const index = nodes.indexOf(item);
				if (index >= 0) nodes.splice(index, 1);
			}
		};
	}
	return {
		clicks,
		body: { textContent: bodyText },
		querySelectorAll(selector: string) {
			if (selector !== "*") return [];
			return nodes;
		},
	};
}
