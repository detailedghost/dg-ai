import type { PwExtApprovalPrompt } from "./pw-ext";

export const PW_EXT_APPROVAL_PORT = "pw-ext-approval";
export const PW_APPROVE_PAGE = "pw-approve.html";
const DEADLINE_MARGIN_MS = 5_000;

export type PwExtApprovalPort = {
	name: string;
	sender?: { url?: string };
	postMessage(message: unknown): void;
	onMessage: { addListener(listener: (message: unknown) => void): void };
	onDisconnect: { addListener(listener: () => void): void };
	disconnect(): void;
};

export type PwExtApprovalApi = {
	runtime: {
		getURL(path: string): string;
		onConnect: {
			addListener(listener: (port: PwExtApprovalPort) => void): void;
		};
	};
	windows: {
		create(options: {
			url: string;
			type: "popup";
			width: number;
			height: number;
			focused: boolean;
		}): Promise<{ id?: number }>;
		remove(windowId: number): Promise<void>;
	};
};

type Pending = {
	nonce: string;
	prompt: PwExtApprovalPrompt;
	windowId?: number;
	settle(approved: boolean): void;
};

function isAnswer(
	message: unknown,
	nonce: string,
): message is { approved: boolean } {
	const value = message as Record<string, unknown> | null;
	return (
		typeof value === "object" &&
		value !== null &&
		value.type === "answer" &&
		value.nonce === nonce &&
		typeof value.approved === "boolean"
	);
}

/** Asks the human in a popup that only the nonce-bound approval page can answer. */
export function createPwExtApprover(
	api: PwExtApprovalApi,
	{ newNonce = () => crypto.randomUUID() }: { newNonce?: () => string } = {},
) {
	let pending: Pending | undefined;
	const pageUrl = api.runtime.getURL(`/${PW_APPROVE_PAGE}`);

	api.runtime.onConnect.addListener((port) => {
		if (port.name !== PW_EXT_APPROVAL_PORT) return;
		const current = pending;
		const sender = port.sender;
		if (!current || sender?.url !== `${pageUrl}#${current.nonce}`) {
			port.disconnect();
			return;
		}
		port.onMessage.addListener((message) => {
			if (pending !== current) return;
			const value = message as Record<string, unknown> | null;
			if (value?.type === "hello" && value.nonce === current.nonce)
				port.postMessage({ type: "prompt", prompt: current.prompt });
			else if (isAnswer(message, current.nonce)) current.settle(message.approved);
		});
		port.onDisconnect.addListener(() => {
			if (pending === current) current.settle(false);
		});
	});

	return async (
		prompt: PwExtApprovalPrompt,
		timeoutMs: number,
		signal?: AbortSignal,
	): Promise<boolean> => {
		if (pending)
			throw new Error(
				"Another pw --ext request is waiting for approval in the browser.",
			);
		const nonce = newNonce();
		let settle: (approved: boolean) => void = () => {};
		const decided = new Promise<boolean>((resolve) => {
			settle = resolve;
		});
		const entry: Pending = { nonce, prompt, settle: (approved) => settle(approved) };
		pending = entry;
		const cancel = () => entry.settle(false);
		signal?.addEventListener("abort", cancel, { once: true });
		if (signal?.aborted) cancel();
		const timer = setTimeout(
			() => entry.settle(false),
			Math.max(timeoutMs - DEADLINE_MARGIN_MS, Math.min(timeoutMs, 1_000)),
		);
		try {
			const window = await api.windows.create({
				url: `${pageUrl}#${nonce}`,
				type: "popup",
				width: 480,
				height: 420,
				focused: true,
			});
			entry.windowId = window.id;
			return await decided;
		} catch {
			return false;
		} finally {
			clearTimeout(timer);
			signal?.removeEventListener("abort", cancel);
			if (pending === entry) pending = undefined;
			if (entry.windowId !== undefined)
				await api.windows.remove(entry.windowId).catch(() => {});
		}
	};
}
