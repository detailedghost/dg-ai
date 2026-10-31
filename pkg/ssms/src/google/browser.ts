import { evaluateMessagesAction, messagesPageSource, type PageAction } from "./page";
import { prepareSend, type SendSurface } from "./thread";

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

function clickExpr(id: string): string {
	const wanted = JSON.stringify(id);
	return `(() => {
  const links = Array.from(document.querySelectorAll("a[href*='/conversations/'], mws-conversation-list-item[href*='/conversations/']"));
  const link = links.find((el) => {
    const href = el.getAttribute("href") || "";
    return href.indexOf("/conversations/" + ${wanted}) !== -1;
  });
  if (!link) return false;
  link.click();
  return true;
})()`;
}

function composeExpr(id: string): string {
	const wanted = JSON.stringify(id);
	return `(() => {
  const main = document.querySelector('[role="main"]') || document.querySelector("main");
  if (!main) return false;
  const href = location.href || "";
  if (href.indexOf("/conversations/" + ${wanted}) === -1) return false;
  const box = main.querySelector("textarea, [contenteditable='true']");
  return !!box;
})()`;
}

function writeExpr(id: string, text: string): string {
	const wanted = JSON.stringify(id);
	const body = JSON.stringify(text);
	return `(() => {
  const main = document.querySelector('[role="main"]') || document.querySelector("main");
  if (!main) return false;
  if ((location.href || "").indexOf("/conversations/" + ${wanted}) === -1) return false;
  const box = main.querySelector("textarea, [contenteditable='true']");
  if (!box) return false;
  const name = (box.tagName || "").toUpperCase();
  if (name === "TEXTAREA" || name === "INPUT") {
    const Ctor = name === "TEXTAREA" ? HTMLTextAreaElement : HTMLInputElement;
    const desc = Object.getOwnPropertyDescriptor(Ctor.prototype, "value");
    if (!desc || !desc.set) return false;
    desc.set.call(box, ${body});
    box.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  }
  return false;
})()`;
}

function sendStateExpr(id: string): string {
	const wanted = JSON.stringify(id);
	return `(() => {
  const main = document.querySelector('[role="main"]') || document.querySelector("main");
  if (!main) return null;
  if ((location.href || "").indexOf("/conversations/" + ${wanted}) === -1) return null;
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
	const wanted = JSON.stringify(id);
	return `(() => {
  const main = document.querySelector('[role="main"]') || document.querySelector("main");
  if (!main) return false;
  if ((location.href || "").indexOf("/conversations/" + ${wanted}) === -1) return false;
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
): Promise<{ reason: "sent"; conversationId: string; draftId: string }> {
	const sent = await prepareSend(
		{
			async href() {
				return String(await page.evaluate("location.href"));
			},
			async header() {
				return String(await page.evaluate(headerExpr));
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
			sleep: (ms) => Bun.sleep(ms),
		},
		{
			conversationId: String(args.conversationId ?? ""),
			recipient: String(args.recipient ?? args.conversationId ?? ""),
			text: String(args.text ?? ""),
			confirmed: args.confirmed === true,
			timeoutMs: typeof args.timeoutMs === "number" ? args.timeoutMs : 0,
		},
	);
	return { ...sent, draftId: String(args.draftId ?? "") };
}

export function createScriptedMessagesBrowser(page: EvalPage): MessagesBrowser {
	return {
		async act(action, args) {
			if (action === "send") return sendOnEvalPage(page, args);
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
