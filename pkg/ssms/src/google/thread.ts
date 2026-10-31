export interface ComposeBox {
	write(text: string): void | Promise<void>;
}

export interface SendControl {
	disabled: boolean;
	click(): void | Promise<void>;
}

export interface SendSurface {
	href(): string | Promise<string>;
	header(): string | Promise<string>;
	clickConversation(id: string): boolean | Promise<boolean>;
	compose(conversationId: string): ComposeBox | null | Promise<ComposeBox | null>;
	sendControl(conversationId: string): SendControl | null | Promise<SendControl | null>;
	sleep?(ms: number): void | Promise<void>;
}

export async function prepareSend(
	surface: SendSurface,
	args: {
		conversationId: string;
		recipient: string;
		text: string;
		confirmed: boolean;
		timeoutMs?: number;
	},
): Promise<{ reason: "sent"; conversationId: string }> {
	if (args.confirmed !== true) throw new Error("send requires confirmation");
	const id = args.conversationId;
	const recipient = args.recipient;
	if (!id || !recipient) throw new Error("conversation not found");
	if (!(await surface.clickConversation(id))) throw new Error("conversation not found");
	const timeout = args.timeoutMs ?? 0;
	let elapsed = 0;
	for (;;) {
		const href = await surface.href();
		const header = await surface.header();
		const urlReady = href.includes(`/conversations/${id}`);
		const headerReady = header.toLowerCase().includes(recipient.toLowerCase());
		if (urlReady && headerReady) break;
		if (elapsed >= timeout || !surface.sleep) {
			throw new Error("open conversation timed out");
		}
		const gap = Math.max(1, Math.min(50, timeout - elapsed));
		await surface.sleep(gap);
		elapsed += gap;
	}
	const box = await surface.compose(id);
	if (!box) throw new Error("compose box missing");
	await box.write(args.text);
	const send = await surface.sendControl(id);
	if (!send) throw new Error("send control missing");
	if (send.disabled) throw new Error("send control disabled");
	await send.click();
	return { reason: "sent", conversationId: id };
}

export interface PageNode {
	textContent?: string;
	tagName?: string;
	paneId?: string;
	disabled?: boolean;
	attrs?: Record<string, string>;
	click?: () => void;
	dispatchEvent?: (event: Event) => void;
	getAttribute?: (name: string) => string | null;
}

export interface SendDocument {
	location?: { href?: string };
	href?: string;
	threadHeader?: string;
	querySelectorAll?: (selector: string) => PageNode[];
	sleep?: (ms: number) => void;
}

function nodesOf(document: SendDocument): PageNode[] {
	const listed = document.querySelectorAll?.("*");
	return listed ? Array.from(listed) : [];
}

function attr(el: PageNode, name: string): string | null {
	return el.getAttribute?.(name) ?? el.attrs?.[name] ?? null;
}

function textOf(el: PageNode): string {
	return String(el.textContent ?? "").replace(/\s+/g, " ").trim();
}

function hrefId(href: string): string {
	const match = /\/conversations\/([^/?#]+)/.exec(href);
	return match ? decodeURIComponent(match[1]) : "";
}

function isSendLabel(el: PageNode): boolean {
	const label = attr(el, "aria-label");
	const text = textOf(el);
	return text === "Send" || text === "Send message" || label === "Send" || label === "Send message";
}

function writeBox(box: PageNode, text: string): void {
	const proto = Object.getPrototypeOf(box) as object;
	const desc = Object.getOwnPropertyDescriptor(proto, "value");
	if (!desc?.set) throw new Error("compose box missing");
	desc.set.call(box, text);
	if (typeof box.dispatchEvent !== "function") throw new Error("compose box missing");
	box.dispatchEvent(new Event("input", { bubbles: true }));
}

export function surfaceFromDocument(document: SendDocument): SendSurface {
	return {
		href: () => String(document.location?.href ?? document.href ?? ""),
		header: () => String(document.threadHeader ?? ""),
		clickConversation(id) {
			const link = nodesOf(document).find(
				(el) => hrefId(attr(el, "href") ?? "") === id,
			);
			if (!link?.click) return false;
			link.click();
			return true;
		},
		compose(conversationId) {
			const box = nodesOf(document).find((el) => {
				if (el.paneId !== conversationId) return false;
				const name = String(el.tagName ?? "").toUpperCase();
				return name === "TEXTAREA" || attr(el, "aria-label") === "Text message";
			});
			if (!box) return null;
			return { write: (text) => writeBox(box, text) };
		},
		sendControl(conversationId) {
			const button = nodesOf(document).find(
				(el) => el.paneId === conversationId && isSendLabel(el),
			);
			if (!button?.click) return null;
			const disabled = button.disabled === true || attr(button, "aria-disabled") === "true";
			return { disabled, click: () => button.click?.() };
		},
		sleep: document.sleep,
	};
}

export async function sendOnDocument(
	document: SendDocument,
	args: Record<string, unknown>,
): Promise<{ reason: "sent"; conversationId: string; draftId: string }> {
	const conversationId = String(args.conversationId ?? "");
	const recipient = String(args.recipient ?? args.conversationId ?? "");
	const sent = await prepareSend(surfaceFromDocument(document), {
		conversationId,
		recipient,
		text: String(args.text ?? ""),
		confirmed: args.confirmed === true,
		timeoutMs: typeof args.timeoutMs === "number" ? args.timeoutMs : 0,
	});
	return { ...sent, draftId: String(args.draftId ?? "") };
}
