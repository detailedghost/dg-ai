import { evaluateMessagesAction, messagesPageSource, type PageAction } from "./page";
import { prepareSend, resolveOpenTimeout, type SendSurface } from "./thread";

export interface EvalPage {
	evaluate<T>(expression: string): Promise<T>;
	close?: () => Promise<void>;
}

export interface MessagesBrowser {
	act(action: PageAction, args: Record<string, unknown>): Promise<unknown>;
	close(): Promise<void>;
}

export function expressionFor(action: PageAction, args: Record<string, unknown>): string {
	return `(() => { ${messagesPageSource()}\nreturn runMessagesAction(document, ${JSON.stringify(action)}, ${JSON.stringify(args)}); })()`;
}

const headerExpr = `(() => {
  const main = document.querySelector('[role="main"]') || document.querySelector("main");
  if (!main) return "";
  const heading = main.querySelector("h1, h2, [role='heading']");
  return heading ? (heading.innerText || heading.textContent || "") : "";
})()`;

const selectedExpr = `(() => {
  const links = Array.from(document.querySelectorAll("a[href*='/conversations/'], mws-conversation-list-item[href*='/conversations/']"));
  const link = links.find((el) => {
    const current = el.getAttribute("aria-current");
    return el.getAttribute("aria-selected") === "true" || current === "true" || current === "page" || current === "step";
  });
  if (!link) return "";
  const href = link.getAttribute("href") || "";
  const match = /\\/conversations\\/([^/?#]+)/.exec(href);
  if (!match) return "";
  try { return decodeURIComponent(match[1]); } catch (e) { return match[1]; }
})()`;

const paneExpr = `(() => {
  const main = document.querySelector('[role="main"]') || document.querySelector("main");
  if (!main) return "";
  const marked = main.querySelector("[data-conversation-id], [data-participant-id], form[data-conversation-id]");
  if (marked) {
    const id = marked.getAttribute("data-conversation-id") || marked.getAttribute("data-participant-id") || "";
    if (id) return id;
  }
  const link = main.querySelector("a[href*='/conversations/']");
  if (!link) return "";
  const href = link.getAttribute("href") || "";
  const match = /\\/conversations\\/([^/?#]+)/.exec(href);
  if (!match) return "";
  try { return decodeURIComponent(match[1]); } catch (e) { return match[1]; }
})()`;

function sameConversation(hrefCode: string, id: string): string {
	const wanted = JSON.stringify(id);
	return `(() => {
    var match = /\\/conversations\\/([^/?#]+)/.exec(String(${hrefCode} || ""));
    var found = "";
    if (match) { try { found = decodeURIComponent(match[1]); } catch (e) { found = match[1]; } }
    return found === ${wanted};
  })()`;
}

function clickExpr(id: string): string {
	return `(() => {
  const links = Array.from(document.querySelectorAll("a[href*='/conversations/'], mws-conversation-list-item[href*='/conversations/']"));
  const link = links.find((el) => {
    const href = el.getAttribute("href") || "";
    return ${sameConversation("href", id)};
  });
  if (!link) return false;
  link.click();
  return true;
})()`;
}

function composeExpr(id: string): string {
	return `(() => {
  const main = document.querySelector('[role="main"]') || document.querySelector("main");
  if (!main) return false;
  const href = location.href || "";
  if (!${sameConversation("href", id)}) return false;
  const box = main.querySelector("textarea, [contenteditable='true']");
  return !!box;
})()`;
}

function writeExpr(id: string, text: string): string {
	const body = JSON.stringify(text);
	return `(() => {
  const main = document.querySelector('[role="main"]') || document.querySelector("main");
  if (!main) return false;
  if (!${sameConversation("location.href || \"\"", id)}) return false;
  const box = main.querySelector("textarea, [contenteditable='true']");
  if (!box) return false;
  const proto = Object.getPrototypeOf(box);
  const desc = proto ? Object.getOwnPropertyDescriptor(proto, "value") : null;
  if (!desc || !desc.set) return false;
  desc.set.call(box, ${body});
  box.dispatchEvent(new Event("input", { bubbles: true }));
  return true;
})()`;
}

function sendStateExpr(id: string): string {
	return `(() => {
  const main = document.querySelector('[role="main"]') || document.querySelector("main");
  if (!main) return null;
  if (!${sameConversation("location.href || \"\"", id)}) return null;
  const buttons = Array.from(main.querySelectorAll("button, [role='button']"));
  const send = buttons.find((el) => {
    const label = el.getAttribute("aria-label") || "";
    const text = (el.innerText || el.textContent || "").trim();
    return text === "Send" || text === "Send message" || label === "Send" || label === "Send message";
  });
  if (!send) return null;
  return { disabled: send.disabled === true || send.getAttribute("aria-disabled") === "true" };
})()`;
}

function clickSendExpr(id: string): string {
	return `(() => {
  const main = document.querySelector('[role="main"]') || document.querySelector("main");
  if (!main) return false;
  if (!${sameConversation("location.href || \"\"", id)}) return false;
  const buttons = Array.from(main.querySelectorAll("button, [role='button']"));
  const send = buttons.find((el) => {
    const label = el.getAttribute("aria-label") || "";
    const text = (el.innerText || el.textContent || "").trim();
    return text === "Send" || label === "Send" || label === "Send message";
  });
  if (!send || send.disabled === true || send.getAttribute("aria-disabled") === "true") return false;
  send.click();
  return true;
})()`;
}

async function sendOnEvalPage(
	page: EvalPage,
	args: Record<string, unknown>,
	sleep: (ms: number) => Promise<void> = (ms) => Bun.sleep(ms),
): Promise<{ reason: "sent"; conversationId: string; draftId: string }> {
	const sent = await prepareSend(
		{
			async href() {
				return String(await page.evaluate("location.href"));
			},
			async header() {
				return String(await page.evaluate(headerExpr));
			},
			async view() {
				const href = String(await page.evaluate("location.href"));
				const header = String(await page.evaluate(headerExpr));
				const selectedId = String(await page.evaluate(selectedExpr));
				const paneId = String(await page.evaluate(paneExpr));
				return { href, header, selectedId, paneId };
			},
			async clickConversation(id) {
				return Boolean(await page.evaluate(clickExpr(id)));
			},
			async compose(id) {
				const found = Boolean(await page.evaluate(composeExpr(id)));
				if (!found) return null;
				return {
					async write(text) {
						const wrote = Boolean(await page.evaluate(writeExpr(id, text)));
						if (!wrote) throw new Error("compose box missing");
					},
				};
			},
			async sendControl(id) {
				const state = await page.evaluate<{ disabled: boolean } | null>(sendStateExpr(id));
				if (!state) return null;
				return {
					disabled: state.disabled,
					async click() {
						const clicked = Boolean(await page.evaluate(clickSendExpr(id)));
						if (!clicked) throw new Error("send control missing");
					},
				};
			},
			sleep,
		},
		{
			conversationId: String(args.conversationId ?? ""),
			recipient: String(args.recipient ?? ""),
			text: String(args.text ?? ""),
			confirmed: args.confirmed === true,
			timeoutMs: resolveOpenTimeout(args.timeoutMs),
			ambiguous: args.ambiguous === true,
			rng: typeof args.rng === "function" ? (args.rng as () => number) : undefined,
		},
	);
	return { ...sent, draftId: String(args.draftId ?? "") };
}

export function createScriptedMessagesBrowser(
	page: EvalPage,
	options: { sleep?: (ms: number) => Promise<void> } = {},
): MessagesBrowser {
	return {
		async act(action, args) {
			if (action === "send") return sendOnEvalPage(page, args, options.sleep);
			return page.evaluate(expressionFor(action, args));
		},
		close: () => page.close?.() ?? Promise.resolve(),
	};
}

export function createLocalMessagesBrowser(
	document: unknown,
	close: () => Promise<void> = async () => undefined,
): MessagesBrowser {
	return {
		async act(action, args) {
			return evaluateMessagesAction(document, action, args);
		},
		close,
	};
}
