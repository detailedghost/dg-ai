import { describeError } from "@dg/common";
import { isOwnPageSender } from "./popup-sender";

/** remember is the label of an opt-in checkbox; with no label the page shows no checkbox. */
export type ApprovalRequest = { title: string; origin: string; lines: string[]; remember?: string };
/** deny is a Deny click; closed is the approval window closed with no answer; unopened is a window that could not open. */
export type ApprovalAnswer = "allow" | "deny" | "closed" | "timeout" | "unopened";
/** remember is true only for an Allow with the offered checkbox ticked. */
export type ApprovalChoice = { answer: ApprovalAnswer; remember: boolean };

export const APPROVAL_TIMEOUT_MS = 60_000;
export const APPROVAL_PAGE = "/approve.html";
export const APPROVAL_MSG = {
	get: "dg-approval:get",
	answer: "dg-approval:answer",
} as const;

export type ApprovalWindows = {
	open(url: string): Promise<number | undefined>;
	close(windowId: number): Promise<void>;
	onRemoved(listener: (windowId: number) => void): void;
};

type Pending = {
	request: ApprovalRequest;
	resolve(choice: ApprovalChoice): void;
	windowId?: number;
	timer: ReturnType<typeof setTimeout>;
};

/** Asks the person at the browser to allow one action; only a click in the extension's own window can allow it. */
export function createApprovals({
	windows,
	pageUrl,
	timeoutMs = APPROVAL_TIMEOUT_MS,
	newId = () => crypto.randomUUID(),
}: {
	windows: ApprovalWindows;
	pageUrl(path: string): string;
	timeoutMs?: number;
	newId?: () => string;
}) {
	const pending = new Map<string, Pending>();

	function settle(id: string, answer: ApprovalAnswer, remember = false): void {
		const entry = pending.get(id);
		if (!entry) return;
		pending.delete(id);
		clearTimeout(entry.timer);
		entry.resolve({ answer, remember: remember && answer === "allow" && entry.request.remember !== undefined });
		if (entry.windowId !== undefined) void windows.close(entry.windowId).catch(() => undefined);
	}

	windows.onRemoved((windowId) => {
		for (const [id, entry] of pending) if (entry.windowId === windowId) settle(id, "closed");
	});

	function ask(request: ApprovalRequest): Promise<ApprovalChoice> {
		const id = newId();
		return new Promise<ApprovalChoice>((resolve) => {
			const entry: Pending = {
				request,
				resolve,
				timer: setTimeout(() => settle(id, "timeout"), timeoutMs),
			};
			pending.set(id, entry);
			windows
				.open(pageUrl(`${APPROVAL_PAGE}?id=${encodeURIComponent(id)}`))
				.then((windowId) => {
					if (windowId === undefined) settle(id, "unopened");
					else if (pending.get(id) === entry) entry.windowId = windowId;
					else void windows.close(windowId).catch(() => undefined);
				})
				.catch((error: unknown) => {
					console.warn("[dg-ai-extension] approval window failed", describeError(error));
					settle(id, "unopened");
				});
		});
	}

	return {
		ask,

		async request(request: ApprovalRequest): Promise<ApprovalAnswer> {
			return (await ask(request)).answer;
		},

		/** What the approval page shows; undefined once answered or expired. */
		show(id: string): ApprovalRequest | undefined {
			return pending.get(id)?.request;
		},

		answer(id: string, allow: boolean, remember = false): void {
			settle(id, allow ? "allow" : "deny", remember);
		},
	};
}

export type Approvals = ReturnType<typeof createApprovals>;

let shared: Approvals | undefined;

/** The one approval queue the background shares between pw --ext and the approval page. */
export function browserApprovals(): Approvals {
	shared ??= createApprovals({
		pageUrl: (path) => browser.runtime.getURL(path as never),
		windows: {
			open: async (url) =>
				(await browser.windows.create({ url, type: "popup", width: 460, height: 380, focused: true }))?.id,
			close: (windowId) => browser.windows.remove(windowId),
			onRemoved: (listener) => browser.windows.onRemoved.addListener(listener),
		},
	});
	return shared;
}

/** Answers the approval page: only the extension's own approval page may read or answer a request. */
export function registerApprovals(): void {
	const approvals = browserApprovals();
	const page = browser.runtime.getURL(APPROVAL_PAGE as never);
	browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
		const { type, id, allow, remember } = (message ?? {}) as {
			type?: unknown;
			id?: unknown;
			allow?: unknown;
			remember?: unknown;
		};
		if (type !== APPROVAL_MSG.get && type !== APPROVAL_MSG.answer) return undefined;
		const fromPage = isOwnPageSender(sender, browser.runtime.id, page);
		if (!fromPage || typeof id !== "string") {
			sendResponse(undefined);
			return undefined;
		}
		if (type === APPROVAL_MSG.get) sendResponse(approvals.show(id));
		else {
			approvals.answer(id, allow === true, remember === true);
			sendResponse(true);
		}
		return undefined;
	});
}
