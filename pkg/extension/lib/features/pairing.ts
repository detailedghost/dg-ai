import {
	CHAT_PAIR_PATH,
	type PairResponse,
	validatePairResponse,
} from "@dg/common";
import { browser } from "wxt/browser";
import { MSG, type PairingSession } from "@/lib/chat-messages";
import { findDaemonPort } from "@/lib/daemon-port";

type PairRuntimeListener = (message: unknown) => void;

export type PairRuntime = {
	onMessage?: {
		addListener(listener: PairRuntimeListener): void;
		removeListener?(listener: PairRuntimeListener): void;
	};
	sendMessage?(message: unknown): Promise<unknown>;
};

export type PairingOptions = {
	variant: "entry" | "options";
	initialConnected?: boolean;
	runtime?: PairRuntime;
	findPort?: () => Promise<number | undefined>;
	fetch?: (input: string, init: RequestInit) => Promise<Response>;
};

export type PairingHandle = {
	ready: Promise<void>;
	setConnected(connected: boolean): void;
	setCurrentSession(sessionId: string | undefined): void;
	destroy(): void;
};

const START_DAEMON = "Start the daemon: run dg-agent start";
const ASK_FOR_CODE = "Run dg-daemon pair in a terminal, then enter the code";
const CODE_EXPIRED = "Code expired. Run dg-daemon pair again.";
const OTHER_EXTENSION =
	"Paired to another extension. Run dg-daemon origin clear, then try again.";
const CONNECTION_FAILED =
	"Could not finish pairing. Run dg-daemon pair again, then retry.";

function element<K extends keyof HTMLElementTagNameMap>(
	doc: Document,
	tag: K,
	className: string,
	text?: string,
): HTMLElementTagNameMap[K] {
	const node = doc.createElement(tag);
	node.className = className;
	if (text !== undefined) node.textContent = text;
	return node;
}

function isConnectedReply(value: unknown): boolean {
	return (
		typeof value === "object" &&
		value !== null &&
		(value as Record<string, unknown>).connected === true
	);
}

function isPairingSuccessReply(value: unknown): boolean {
	return (
		typeof value === "object" &&
		value !== null &&
		(value as Record<string, unknown>).ok === true
	);
}

async function errorMessage(response: Response): Promise<string> {
	if (response.status === 401) {
		let attemptsLeft: unknown;
		try {
			const body = await response.text();
			try {
				attemptsLeft = (JSON.parse(body) as Record<string, unknown>)
					.attemptsLeft;
			} catch {
				attemptsLeft = Number(/(\d+)\s+attempts? left/i.exec(body)?.[1]);
			}
		} catch {}
		return typeof attemptsLeft === "number" && Number.isFinite(attemptsLeft)
			? `Wrong code. ${attemptsLeft} tries left.`
			: "Wrong code.";
	}
	if (response.status === 404 || response.status === 410) return CODE_EXPIRED;
	if (response.status === 409) return OTHER_EXTENSION;
	return "Could not pair. Try again.";
}

export function mountPairing(
	root: HTMLElement,
	options: PairingOptions,
): PairingHandle {
	const doc = root.ownerDocument;
	const runtime =
		options.runtime ??
		((browser as unknown as { runtime?: PairRuntime }).runtime ?? {});
	const findPort = options.findPort ?? (() => findDaemonPort());
	const fetchPair = options.fetch ?? ((input, init) => fetch(input, init));
	let port: number | undefined;
	let connected = options.initialConnected ?? false;
	let refreshVersion = 0;
	let pending = false;
	let sessions: PairingSession[] = [];
	let confirmationTimer: number | undefined;
	let destroyed = false;
	let awaitingSessionId: string | undefined;
	let selectedSessionId: string | undefined;

	root.classList.add("pair-shell", `pair-shell--${options.variant}`);
	root.hidden = true;
	const panel = element(doc, "section", "pair-panel");
	const heading = element(
		doc,
		"h2",
		options.variant === "options" ? "sec-h" : "pair-panel__title",
		options.variant === "options" ? "Pairing" : "Not paired",
	);
	const copy = element(doc, "p", "pair-panel__copy");
	const reveal = element(doc, "button", "pair-button", "Pair");
	reveal.type = "button";
	const form = element(doc, "form", "pair-form");
	const label = element(doc, "label", "pair-form__label", "Pair code");
	const input = element(doc, "input", "pair-form__input");
	input.type = "text";
	input.inputMode = "numeric";
	input.autocomplete = "one-time-code";
	input.pattern = "[0-9]{6}";
	input.maxLength = 6;
	input.required = true;
	label.append(input);
	const submit = element(doc, "button", "pair-button", "Pair");
	submit.type = "submit";
	const status = element(doc, "p", "pair-panel__status");
	status.setAttribute("role", "status");
	form.append(label, submit);
	const sessionList = element(doc, "ul", "pair-sessions");
	panel.append(heading, copy, reveal, form, status, sessionList);
	root.replaceChildren(panel);

	function clearConfirmationTimer(): void {
		if (confirmationTimer !== undefined)
			doc.defaultView?.clearTimeout(confirmationTimer);
		confirmationTimer = undefined;
	}

	function renderSessions(): void {
		sessionList.replaceChildren();
		for (const session of sessions) {
			const hasSelection = sessions.some((item) => item.sessionId === selectedSessionId);
			const isCurrent = hasSelection ? session.sessionId === selectedSessionId : session.current === true;
			const row = element(doc, "li", isCurrent ? "pair-session pair-session--current" : "pair-session");
			const label = element(
				doc,
				"span",
				"pair-session__label",
				`${isCurrent ? "Current · " : ""}${session.agentIdentity} · ${session.sessionId.slice(0, 8)} · ${session.connected ? "Connected" : "Disconnected"}`,
			);
			const disconnect = element(doc, "button", "pair-button", "Disconnect");
			disconnect.type = "button";
			disconnect.setAttribute(
				"aria-label",
				`Disconnect ${session.agentIdentity} ${session.sessionId.slice(0, 8)}`,
			);
			disconnect.addEventListener("click", () => {
				disconnect.disabled = true;
				void (async () => {
					try {
						const reply = await runtime.sendMessage?.({
							type: MSG.sessionDisconnect,
							sessionId: session.sessionId,
						});
						if (!isPairingSuccessReply(reply)) throw new Error("disconnect failed");
						await refresh();
					} catch {
						status.textContent = "Could not disconnect this session. Try again.";
						disconnect.disabled = false;
					}
				})();
			});
			row.append(label, disconnect);
			sessionList.append(row);
		}
		sessionList.hidden = sessions.length === 0;
	}

	function showConnected(): void {
		if (
			sessions.some(
				(session) => session.sessionId === awaitingSessionId && session.connected,
			)
		) {
			awaitingSessionId = undefined;
		}
		if (awaitingSessionId === undefined) clearConfirmationTimer();
		root.hidden = false;
		heading.textContent = "Paired";
		const count = sessions.filter((session) => session.connected).length;
		copy.textContent =
			count > 0
				? `${count} connected session${count === 1 ? "" : "s"}`
				: "Connected to the daemon";
		reveal.textContent = "Pair another session";
		reveal.hidden = false;
		form.hidden = true;
		status.textContent = awaitingSessionId === undefined
			? "Paired — connection confirmed"
			: "Code accepted — waiting for the daemon to confirm the new session.";
		renderSessions();
	}

	function showUnavailable(): void {
		root.hidden = false;
		heading.textContent = "Not paired";
		copy.textContent = START_DAEMON;
		renderSessions();
		reveal.hidden = true;
		form.hidden = true;
		status.textContent = "";
	}

	function showReady(): void {
		root.hidden = false;
		heading.textContent = "Not paired";
		reveal.textContent = "Pair";
		copy.textContent = ASK_FOR_CODE;
		renderSessions();
		status.textContent = "";
		input.disabled = false;
		submit.disabled = false;
		if (options.variant === "entry") {
			reveal.hidden = false;
			form.hidden = true;
		} else {
			reveal.hidden = true;
			form.hidden = false;
		}
	}

	async function refresh(): Promise<void> {
		const version = ++refreshVersion;
		let connectionReply: unknown;
		try {
			connectionReply = await runtime.sendMessage?.({
				type: MSG.connectionRequest,
			});
		} catch {}
		if (version !== refreshVersion || destroyed) return;
		applySessions(connectionReply);
		connected = isConnectedReply(connectionReply);
		if (connected) {
			showConnected();
			return;
		}
		port = await findPort();
		if (version !== refreshVersion) return;
		if (port === undefined) showUnavailable();
		else showReady();
		if (sessions.length > 0) {
			status.textContent = "Disconnected — waiting for the daemon to confirm the connection.";
		}
	}

	function applySessions(value: unknown): void {
		if (typeof value !== "object" || value === null) return;
		const items = (value as Record<string, unknown>).sessions;
		if (!Array.isArray(items)) return;
		sessions = items.filter(
			(item): item is PairingSession =>
				typeof item === "object" &&
				item !== null &&
				typeof item.sessionId === "string" &&
				typeof item.agentIdentity === "string" &&
				typeof item.connected === "boolean",
		);
	}

	function setConnected(nextConnected: boolean): void {
		connected = nextConnected;
		refreshVersion += 1;
		void refresh();
	}

	function onRuntimeMessage(message: unknown): void {
		if (typeof message !== "object" || message === null) return;
		const payload = message as Record<string, unknown>;
		if (payload.type !== MSG.connection) return;
		applySessions(payload);
		connected = isConnectedReply(payload);
		refreshVersion += 1;
		if (connected) showConnected();
		else void refresh();
	}

	input.addEventListener("input", () => {
		input.value = input.value.replace(/\D/g, "").slice(0, 6);
		status.textContent = "";
	});
	reveal.addEventListener("click", () => {
		if (port === undefined) {
			void findPort().then((value) => {
				port = value;
			});
		}
		reveal.hidden = true;
		form.hidden = false;
		input.disabled = false;
		submit.disabled = false;
		input.value = "";
		input.focus();
	});
	form.addEventListener("submit", (event) => {
		event.preventDefault();
		if (pending) return;
		void (async () => {
			if (!/^\d{6}$/.test(input.value)) {
				status.textContent = "Enter a 6 digit code.";
				return;
			}
			if (port === undefined) {
				showUnavailable();
				return;
			}
			pending = true;
			input.disabled = true;
			submit.disabled = true;
			form.setAttribute("aria-busy", "true");
			status.textContent = "";
			let paired = false;
			try {
				const response = await fetchPair(
					`http://127.0.0.1:${port}${CHAT_PAIR_PATH}`,
					{
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ code: input.value }),
					},
				);
				if (!response.ok) {
					status.textContent = await errorMessage(response);
					return;
				}
				const bootstrap: PairResponse = validatePairResponse(
					await response.json(),
				);
				awaitingSessionId = bootstrap.sessionId;
				const reply = await runtime.sendMessage?.({
					type: MSG.markerCaptured,
					bootstrap,
				});
				if (!isPairingSuccessReply(reply)) {
					awaitingSessionId = undefined;
					status.textContent = CONNECTION_FAILED;
					return;
				}
				paired = true;
				if (awaitingSessionId !== undefined) {
					status.textContent = "Code accepted — waiting for the daemon to confirm the connection.";
					clearConfirmationTimer();
					confirmationTimer = doc.defaultView?.setTimeout(() => {
						if (awaitingSessionId === undefined || destroyed) return;
						status.textContent = "Connection not confirmed. Check that the daemon is running, or disconnect this session and pair again.";
						input.disabled = false;
						submit.disabled = false;
					}, 10_000);
				}
			} catch {
				awaitingSessionId = undefined;
				showUnavailable();
			} finally {
				pending = false;
				form.removeAttribute("aria-busy");
				input.disabled = paired;
				submit.disabled = paired;
			}
		})();
	});

	runtime.onMessage?.addListener(onRuntimeMessage);
	const ready = refresh();
	return {
		ready,
		setConnected,
		setCurrentSession(sessionId) {
			selectedSessionId = sessionId;
			renderSessions();
		},
		destroy() {
			destroyed = true;
			clearConfirmationTimer();
			refreshVersion += 1;
			runtime.onMessage?.removeListener?.(onRuntimeMessage);
		},
	};
}
