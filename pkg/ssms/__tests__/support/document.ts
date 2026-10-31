export interface FakeNode {
	textContent: string;
	tagName: string;
	paneId?: string;
	attrs: Record<string, string>;
	click(): void;
	dispatchEvent(event?: Event): void;
	getAttribute(name: string): string | null;
}

export function node(
	text: string,
	attrs: Record<string, string> = {},
	tagName = "",
): FakeNode {
	return {
		textContent: text,
		tagName,
		attrs,
		click() {},
		dispatchEvent() {},
		getAttribute(name) {
			return Object.prototype.hasOwnProperty.call(attrs, name) ? (attrs[name] ?? null) : null;
		},
	};
}

export function asTextArea(el: FakeNode): FakeNode {
	const proto = {};
	Object.defineProperty(proto, "value", {
		configurable: true,
		set(this: { usedNativeSetter?: boolean; nativeValue?: string }, value: string) {
			this.usedNativeSetter = true;
			this.nativeValue = value;
		},
		get(this: { nativeValue?: string }) {
			return this.nativeValue ?? "";
		},
	});
	Object.setPrototypeOf(el, proto);
	return el;
}

export function readyThread(doc: object, id: string, header = id): void {
	Object.assign(doc, {
		location: { href: `https://messages.google.com/web/u/0/conversations/${id}` },
		threadHeader: header,
	});
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
