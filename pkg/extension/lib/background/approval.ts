import { describeError } from "@dg/common";

export type ApprovalRequest = { title: string; origin: string; lines: string[] };
/** deny is a Deny click; closed is the approval window closed with no answer; unopened is a window that could not open. */
export type ApprovalAnswer = "allow" | "deny" | "closed" | "timeout" | "unopened";

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
	resolve(answer: ApprovalAnswer): void;
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

	function settle(id: string, answer: ApprovalAnswer): void {
		const entry = pending.get(id);
		if (!entry) return;
		pending.delete(id);
		clearTimeout(entry.timer);
		entry.resolve(answer);
		if (entry.windowId !== undefined) void windows.close(entry.windowId).catch(() => undefined);
	}

	windows.onRemoved((windowId) => {
		for (const [id, entry] of pending) if (entry.windowId === windowId) settle(id, "closed");
	});

	return {
		request(request: ApprovalRequest): Promise<ApprovalAnswer> {
			const id = newId();
			return new Promise<ApprovalAnswer>((resolve) => {
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
		},

		/** What the approval page shows; undefined once answered or expired. */
		show(id: string): ApprovalRequest | undefined {
			return pending.get(id)?.request;
		},

		answer(id: string, allow: boolean): void {
			settle(id, allow ? "allow" : "deny");
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
		const { type, id, allow } = (message ?? {}) as { type?: unknown; id?: unknown; allow?: unknown };
		if (type !== APPROVAL_MSG.get && type !== APPROVAL_MSG.answer) return undefined;
		const fromPage = sender.id === browser.runtime.id && (sender.url ?? "").split("?")[0] === page;
		if (!fromPage || typeof id !== "string") {
			sendResponse(undefined);
			return undefined;
		}
		if (type === APPROVAL_MSG.get) sendResponse(approvals.show(id));
		else {
			approvals.answer(id, allow === true);
			sendResponse(true);
		}
		return undefined;
	});
}
