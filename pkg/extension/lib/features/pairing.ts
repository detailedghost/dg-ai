import {
	CHAT_PAIR_PATH,
	type PairResponse,
	validatePairResponse,
} from "@dg/common";
import { browser } from "wxt/browser";
import { MSG, type PairingSession } from "@/lib/chat-messages";
import { findDaemonPort } from "@/lib/daemon-port";
import {
	type PublicSession,
	connectionGuidance,
	sessionControls,
	staleSessionIds,
} from "@/lib/features/chat-connection";

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
	onDaemon?(reachable: boolean): void;
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
	let catalog: PublicSession[] = [];

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
	const directions = element(
		doc,
		"p",
		"pair-panel__copy",
		"Attach CLI session connects one that is already open. New session for CLI creates one here; then run dg-agent attach in the terminal.",
	);
	const attachButton = element(doc, "button", "pair-button", "Attach CLI session");
	attachButton.type = "button";
	const launchButton = element(doc, "button", "pair-button", "New session for CLI");
	launchButton.type = "button";
	const clearButton = element(doc, "button", "pair-button", "Clear disconnected");
	clearButton.type = "button";
	const retryButton = element(doc, "button", "pair-button", "Retry");
	retryButton.type = "button";
	const actions = element(doc, "div", "pair-actions");
	actions.append(attachButton, launchButton, clearButton, retryButton);
	const sessionList = element(doc, "ul", "pair-sessions");
	panel.append(heading, copy, reveal, form, directions, actions, status, sessionList);
	root.replaceChildren(panel);

	function clearConfirmationTimer(): void {
		if (confirmationTimer !== undefined)
			doc.defaultView?.clearTimeout(confirmationTimer);
		confirmationTimer = undefined;
	}

	function controls() {
		const held = sessions.map((session) => ({
			sessionId: session.sessionId,
			connected: session.connected,
		}));
		const listed =
			catalog.length > 0
				? catalog
				: sessions.map((session) => ({
						sessionId: session.sessionId,
						agentIdentity: session.agentIdentity,
						presence: session.connected
							? ("cli" as const)
							: ("idle" as const),
					}));
		return sessionControls(listed, held);
	}

	function renderSessions(): void {
		sessionList.replaceChildren();
		const rows = controls();
		clearButton.hidden = staleSessionIds(rows).length === 0;
		for (const session of sessions) {
			const hasSelection = sessions.some((item) => item.sessionId === selectedSessionId);
			const isCurrent = hasSelection ? session.sessionId === selectedSessionId : session.current === true;
			const row = element(doc, "li", isCurrent ? "pair-session pair-session--current" : "pair-session");
			const control = rows.find((item) => item.sessionId === session.sessionId);
			const label = element(
				doc,
				"span",
				"pair-session__label",
				`${isCurrent ? "Current · " : ""}${session.agentIdentity} · ${session.sessionId.slice(0, 8)} · ${session.connected ? "Connected" : "Disconnected"}`,
			);
			if (control?.canConnect) {
				const connect = element(doc, "button", "pair-button", "Connect");
				connect.type = "button";
				connect.setAttribute(
					"aria-label",
					`Connect ${session.agentIdentity} ${session.sessionId.slice(0, 8)}`,
				);
				connect.addEventListener("click", () => {
					void runCommand({
						type: MSG.sessionAttach,
						sessionId: session.sessionId,
						...codePayload(),
					});
				});
				row.append(label, connect);
				sessionList.append(row);
				continue;
			}
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
			if (control?.canStop) {
				const stop = element(doc, "button", "pair-button", "Stop");
				stop.type = "button";
				stop.setAttribute(
					"aria-label",
					`Stop ${session.agentIdentity} ${session.sessionId.slice(0, 8)}`,
				);
				stop.addEventListener("click", () => {
					stop.disabled = true;
					void runCommand({ type: MSG.sessionClose, sessionId: session.sessionId });
				});
				row.append(stop);
			}
			sessionList.append(row);
		}
		for (const control of rows) {
			if (sessions.some((session) => session.sessionId === control.sessionId)) continue;
			const row = element(doc, "li", "pair-session");
			const label = element(
				doc,
				"span",
				"pair-session__label",
				`${control.agentIdentity} · ${control.sessionId.slice(0, 8)} · ${control.presence}`,
			);
			const connect = element(doc, "button", "pair-button", "Connect");
			connect.type = "button";
			connect.addEventListener("click", () => {
				void runCommand({
					type: MSG.sessionAttach,
					sessionId: control.sessionId,
					...codePayload(),
				});
			});
			row.append(label, connect);
			sessionList.append(row);
		}
		sessionList.hidden = sessionList.childElementCount === 0;
	}

	function codePayload(): { code?: string } {
		return /^\d{6}$/.test(input.value) ? { code: input.value } : {};
	}

	async function runCommand(message: unknown): Promise<void> {
		try {
			const reply = await runtime.sendMessage?.(message);
			if (!isPairingSuccessReply(reply)) {
				const error =
					typeof reply === "object" &&
					reply !== null &&
					typeof (reply as { error?: unknown }).error === "string"
						? (reply as { error: string }).error
						: "Could not update the session. Retry, or check that the daemon is running.";
				status.textContent = error;
				return;
			}
			await refresh();
		} catch {
			status.textContent = "Could not reach the extension background. Retry.";
		}
	}

	function showConnected(): void {
		options.onDaemon?.(true);
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
		options.onDaemon?.(false);
		root.hidden = false;
		heading.textContent = "Not paired";
		copy.textContent = START_DAEMON;
		renderSessions();
		reveal.hidden = true;
		form.hidden = true;
		status.textContent = "";
	}

	function showReady(): void {
		options.onDaemon?.(true);
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
		const catalogTask = loadCatalog();
		connected = isConnectedReply(connectionReply);
		if (connected) {
			showConnected();
		} else {
			port = await findPort();
			if (version !== refreshVersion || destroyed) return;
			if (port === undefined) showUnavailable();
			else showReady();
			if (sessions.length > 0) {
				status.textContent =
					"Disconnected — waiting for the daemon to confirm the connection.";
			}
		}
		await catalogTask;
		if (version !== refreshVersion || destroyed) return;
		renderSessions();
		const presences = catalog.flatMap((session) =>
			session.presence ? [session.presence] : [],
		);
		status.textContent = connectionGuidance({
			daemonUp: port !== undefined || connected,
			paired: connected,
			presences,
			heldDisconnected: sessions.some((session) => !session.connected),
		});
	}

	async function loadCatalog(): Promise<void> {
		try {
			const reply = await runtime.sendMessage?.({ type: MSG.sessionCatalog });
			if (typeof reply !== "object" || reply === null) return;
			const items = (reply as { sessions?: unknown }).sessions;
			if (!Array.isArray(items)) return;
			catalog = items.filter(
				(item): item is PublicSession =>
					typeof item === "object" &&
					item !== null &&
					typeof (item as { sessionId?: unknown }).sessionId === "string" &&
					typeof (item as { agentIdentity?: unknown }).agentIdentity === "string",
			);
		} catch {
			catalog = [];
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

	attachButton.addEventListener("click", () => {
		void runCommand({
			type: MSG.sessionAttach,
			all: true,
			...codePayload(),
		});
	});
	launchButton.addEventListener("click", () => {
		void runCommand({
			type: MSG.sessionLaunch,
			...codePayload(),
		});
	});
	clearButton.addEventListener("click", () => {
		void runCommand({ type: MSG.sessionClear });
	});
	retryButton.addEventListener("click", () => {
		void runCommand({ type: MSG.connectionRetry });
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
