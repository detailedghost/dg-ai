import { evaluateMessagesAction, messagesPageSource, type PageAction } from "./page";

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

export function createScriptedMessagesBrowser(page: EvalPage): MessagesBrowser {
	return {
		async act(action, args) {
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
