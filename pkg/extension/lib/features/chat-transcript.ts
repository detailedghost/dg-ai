/**
 * Transcript renderer. RENDERING CONTRACT: content is untrusted agent/user
 * text and renders via textContent only, never innerHTML or Markdown, which
 * would give it extension-page script privileges including the session token.
 */

import {
	CHAT_MAX_ASSET_BYTES,
	type ChatFrame,
	type ProgressState,
} from "@dg/common";

/** Stored-record projection returned by history-response — not a wire ChatFrame. */
export type ChatHistoryItem = {
	seq: number;
	id: string;
	role: "user" | "agent";
	body: string;
	createdAt: string;
	attachmentId?: string;
};

export type FetchAssetResult =
	| { status: "ok"; blobUrl: string }
	| { status: "removed" }
	| { status: "error" };

export type FetchAsset = (
	assetId: string,
	sessionId: string,
	token: string,
) => Promise<FetchAssetResult>;

export type TranscriptViewOptions = {
	fetchAsset?: FetchAsset;
	/** Daemon port for the default fetchAsset — assets live on the daemon, not this extension page's own origin. Required unless fetchAsset is overridden. */
	port?: number;
};

export type TranscriptView = {
	appendUserMessage(body: string): void;
	appendAgentMessage(
		frame: Extract<ChatFrame, { type: "agent-message" }>,
		token: string,
	): Promise<void>;
	appendCommandResult(
		frame: Extract<ChatFrame, { type: "command-result" }>,
	): void;
	updateProgress(state: ProgressState): void;
	applyHistory(messages: ChatHistoryItem[]): void;
};

/** Token goes in a request HEADER, never the URL — a query-string token leaks into logs. */
function buildDefaultFetchAsset(port: number | undefined): FetchAsset {
	return async function defaultFetchAsset(
		assetId: string,
		sessionId: string,
		token: string,
	): Promise<FetchAssetResult> {
		if (port === undefined) {
			// Fail loud instead of silently fetching this page's own chrome-extension:// origin.
			throw new Error(
				"createTranscriptView: options.port is required for the default fetchAsset",
			);
		}
		try {
			const res = await fetch(
				`http://127.0.0.1:${port}/assets/${encodeURIComponent(assetId)}`,
				{
					headers: {
						"X-Dg-Session-Id": sessionId,
						"X-Dg-Session-Token": token,
					},
				},
			);
			if (res.status === 404) return { status: "removed" };
			if (!res.ok) return { status: "error" };
			const declared = Number(res.headers?.get("content-length"));
			if (Number.isFinite(declared) && declared > CHAT_MAX_ASSET_BYTES) {
				return { status: "error" };
			}
			const blob = await res.blob();
			if (blob.size > CHAT_MAX_ASSET_BYTES) return { status: "error" };
			return { status: "ok", blobUrl: URL.createObjectURL(blob) };
		} catch {
			return { status: "error" };
		}
	};
}

/** Inline transcript prose, distinct from chat-node.ts's short badge labels (RUNNING/NEEDS YOU). */
function progressText(state: ProgressState): string {
	switch (state) {
		case "running":
			return "Agent is working…";
		case "awaiting-input":
			return "Waiting on your reply…";
		case "agent-gone":
			return "Agent disconnected.";
	}
}

export function createTranscriptView(
	container: HTMLElement,
	options: TranscriptViewOptions = {},
): TranscriptView {
	const fetchAsset = options.fetchAsset ?? buildDefaultFetchAsset(options.port);
	const doc = container.ownerDocument;
	let progressEl: HTMLElement | undefined;

	function makeEl(tag: string, className: string): HTMLElement {
		const node = doc.createElement(tag);
		node.className = className;
		return node as unknown as HTMLElement;
	}

	function buildMessageEl(
		role: "user" | "agent",
		body: string,
		attachmentNode?: HTMLElement,
	): HTMLElement {
		const message = makeEl(
			"div",
			`chat-transcript__message chat-transcript__message--${role}`,
		);
		const bodyEl = makeEl("div", "chat-transcript__body");
		bodyEl.textContent = body; // never innerHTML — body is untrusted agent/user text
		message.appendChild(bodyEl);
		if (attachmentNode) message.appendChild(attachmentNode);
		return message;
	}

	function appendMessage(
		role: "user" | "agent",
		body: string,
		attachmentNode?: HTMLElement,
	): void {
		container.appendChild(buildMessageEl(role, body, attachmentNode));
	}

	// Ids of history items already rendered, so a second backfill (every
	// reconnect requests one) never re-renders the same stored record.
	const renderedHistoryIds = new Set<string>();
	// Live-rendered (role, body) pairs awaiting a stored-record match — the wire
	// carries no id, so backfill correlates on content instead of duplicating.
	const liveUnmatchedCounts = new Map<string, number>();

	function liveKey(role: "user" | "agent", body: string): string {
		return `${role}:${body.length}:${body}`;
	}

	function noteLiveRendered(role: "user" | "agent", body: string): void {
		const key = liveKey(role, body);
		liveUnmatchedCounts.set(key, (liveUnmatchedCounts.get(key) ?? 0) + 1);
	}

	/** Consumes one matching live entry if present; returns whether a match was found. */
	function consumeLiveMatch(role: "user" | "agent", body: string): boolean {
		const key = liveKey(role, body);
		const count = liveUnmatchedCounts.get(key) ?? 0;
		if (count <= 0) return false;
		if (count === 1) liveUnmatchedCounts.delete(key);
		else liveUnmatchedCounts.set(key, count - 1);
		return true;
	}

	async function renderAttachment(
		assetId: string,
		sessionId: string,
		token: string,
	): Promise<HTMLElement> {
		const result = await fetchAsset(assetId, sessionId, token);
		if (result.status === "ok") {
			const wrap = makeEl("div", "chat-transcript__attachment");
			const img = doc.createElement("img") as unknown as HTMLImageElement;
			img.className = "chat-transcript__attachment-image";
			const release = () => URL.revokeObjectURL(result.blobUrl);
			img.addEventListener("load", release, { once: true });
			img.addEventListener("error", release, { once: true });
			img.setAttribute("src", result.blobUrl);
			wrap.appendChild(img as unknown as HTMLElement);
			return wrap;
		}
		if (result.status === "removed") {
			const wrap = makeEl(
				"div",
				"chat-transcript__attachment chat-transcript__attachment--removed",
			);
			wrap.textContent = "Attachment removed";
			return wrap;
		}
		const wrap = makeEl(
			"div",
			"chat-transcript__attachment chat-transcript__attachment--error",
		);
		wrap.textContent = "Attachment failed to load";
		return wrap;
	}

	return {
		appendUserMessage(body: string): void {
			noteLiveRendered("user", body);
			appendMessage("user", body);
		},

		appendAgentMessage(frame, token): Promise<void> {
			// Append synchronously so order never depends on attachment fetch
			// timing — the attachment slots into this same node once ready.
			noteLiveRendered("agent", frame.body);
			const messageEl = buildMessageEl("agent", frame.body);
			container.appendChild(messageEl);
			if (!frame.attachmentId) return Promise.resolve();
			return renderAttachment(frame.attachmentId, frame.sessionId, token).then(
				(attachmentNode) => {
					messageEl.appendChild(attachmentNode);
				},
			);
		},

		appendCommandResult(frame): void {
			const message = makeEl(
				"div",
				`chat-transcript__message chat-transcript__command-result chat-transcript__command-result--${frame.ok ? "ok" : "error"}`,
			);
			const bodyEl = makeEl("div", "chat-transcript__body");
			bodyEl.textContent = frame.ok
				? (frame.output ?? "")
				: (frame.error ?? "");
			message.appendChild(bodyEl);
			container.appendChild(message);
		},

		updateProgress(state: ProgressState): void {
			if (!progressEl) {
				progressEl = makeEl("div", "chat-transcript__progress");
				progressEl.setAttribute("role", "status");
				container.appendChild(progressEl);
			}
			progressEl.dataset.state = state;
			progressEl.textContent = progressText(state);
		},

		applyHistory(messages: ChatHistoryItem[]): void {
			// Reconnect re-requests the whole seq-ascending backfill; append each
			// fresh id in order, unless a live-rendered node already stands for it.
			for (const item of messages) {
				if (renderedHistoryIds.has(item.id)) continue;
				renderedHistoryIds.add(item.id);
				if (consumeLiveMatch(item.role, item.body)) continue;
				container.appendChild(buildMessageEl(item.role, item.body));
			}
		},
	};
}
