import { SendUncertainError } from "../errors";
import { nextGapMs, type Rng } from "../pace/jitter";

export const DEFAULT_OPEN_TIMEOUT_MS = 10_000;

export function resolveOpenTimeout(value: unknown): number {
	if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
	return DEFAULT_OPEN_TIMEOUT_MS;
}

export function normalizeRecipientName(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

export function headerNamesRecipient(header: string, recipient: string): boolean {
	const name = normalizeRecipientName(recipient);
	return name.length > 0 && normalizeRecipientName(header) === name;
}

export function hrefSelectsConversation(href: string, id: string): boolean {
	const match = /\/conversations\/([^/?#]+)/.exec(href);
	if (!match?.[1]) return false;
	try {
		return decodeURIComponent(match[1]) === id;
	} catch {
		return match[1] === id;
	}
}

export interface ComposeBox {
	write(text: string): void | Promise<void>;
}

export interface SendControl {
	disabled: boolean;
	click(): void | Promise<void>;
}

export interface ThreadView {
	href: string;
	header: string;
	selectedId: string;
	pane: string;
}

export interface SendSurface {
	href(): string | Promise<string>;
	header(): string | Promise<string>;
	view(): ThreadView | Promise<ThreadView>;
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
		rng?: Rng;
		ambiguous?: boolean;
	},
): Promise<{ reason: "sent"; conversationId: string }> {
	if (args.confirmed !== true) throw new Error("send requires confirmation");
	const id = args.conversationId;
	const recipient = args.recipient;
	if (!id || !recipient) throw new Error("conversation not found");
	const before = await surface.view();
	const alreadyOpen =
		hrefSelectsConversation(before.href, id) &&
		headerNamesRecipient(before.header, recipient) &&
		before.selectedId === id;
	if (!(await surface.clickConversation(id))) throw new Error("conversation not found");
	const timeout = resolveOpenTimeout(args.timeoutMs);
	const rng = args.rng ?? Math.random;
	const gaps: number[] = [];
	let elapsed = 0;
	for (;;) {
		const view = await surface.view();
		const urlReady = hrefSelectsConversation(view.href, id);
		const headerReady = headerNamesRecipient(view.header, recipient);
		const selected = view.selectedId === id;
		const paneChanged = view.pane !== before.pane && view.pane !== "";
		if (urlReady && headerReady && selected && (paneChanged || alreadyOpen)) break;
		if (elapsed >= timeout || !surface.sleep) {
			if (args.ambiguous) throw new Error("ambiguous recipient");
			throw new Error("open conversation timed out");
		}
		const remaining = timeout - elapsed;
		const gap = Math.max(1, Math.min(nextGapMs(rng, gaps), remaining));
		gaps.push(gap);
		await surface.sleep(gap);
		elapsed += gap;
	}
	const box = await surface.compose(id);
	if (!box) throw new Error("compose box missing");
	await box.write(args.text);
	try {
		const send = await surface.sendControl(id);
		if (!send) throw new SendUncertainError("send control missing");
		if (send.disabled) throw new SendUncertainError("send control disabled");
		await send.click();
	} catch (error) {
		if (error instanceof SendUncertainError) throw error;
		const message = error instanceof Error ? error.message : "send failed";
		throw new SendUncertainError(message);
	}
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
	pane?: string;
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

function selectedConversationId(document: SendDocument): string {
	const selected = nodesOf(document).find((el) => {
		const current = attr(el, "aria-current");
		const on =
			attr(el, "aria-selected") === "true" ||
			current === "true" ||
			current === "page" ||
			current === "step";
		return on && hrefId(attr(el, "href") ?? "") !== "";
	});
	return selected ? hrefId(attr(selected, "href") ?? "") : "";
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
		view: () => ({
			href: String(document.location?.href ?? document.href ?? ""),
			header: String(document.threadHeader ?? ""),
			selectedId: selectedConversationId(document),
			pane: String(document.pane ?? ""),
		}),
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
	const recipient = String(args.recipient ?? "");
	const sent = await prepareSend(surfaceFromDocument(document), {
		conversationId,
		recipient,
		text: String(args.text ?? ""),
		confirmed: args.confirmed === true,
		timeoutMs: resolveOpenTimeout(args.timeoutMs),
		ambiguous: args.ambiguous === true,
	});
	return { ...sent, draftId: String(args.draftId ?? "") };
}
