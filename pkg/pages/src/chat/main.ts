import {
	type ChatFrame,
	type CommandEntry,
	OVERWATCH_SESSION_ID,
	type SessionBootstrap,
	validatePageChatFrame,
} from "@dg/common";
import { MSG } from "../chat-messages";
import { SESSION_ENDED_TEXT } from "../local";
import { isTextEntryFocused } from "../dom-focus";
import {
	attachCommandAutocomplete,
	type CommandAutocomplete,
} from "./chat-autocomplete";
import {
	createChatCanvas,
	isNodeInView,
	loadNodePositions,
	type Point,
	saveNodePosition,
	trackPointerDrag,
} from "./chat-canvas";
import type {
	ChatClient,
	ChatConnectionState,
	ConnectionListener,
	SendUserMessageOptions,
	SendUserMessageResult,
} from "./chat-client";
import {
	type ChatNode,
	createChatNode,
	groupSessionsByWorkset,
	presenceLabel,
	statusLabel,
	type WorksetGroup,
} from "./chat-node";
import type { ChatSessionEntry } from "./chat-sessions";
import { createChatSessions } from "./chat-sessions";
import type { ChatHistoryItem } from "./chat-transcript";
import { redactSecrets } from "./chat-connection";
import type { LocalAttachResult } from "../local";
import { createVimNav } from "../vim-nav";
import { createIcon, type IconName } from "./icons";
import {
	memoryStorage,
	type PageRuntime,
	type PositionArea,
	positionAreaFor,
} from "../runtime";

type MotionQuery = {
	readonly matches: boolean;
	addEventListener(type: "change", listener: () => void): void;
};

type RelayRuntime = Required<Pick<PageRuntime, "onMessage" | "sendMessage">>;

export type ChatPageController = {
	dropSession(sessionId: string): void;
};

export type ChatPageOptions = {
	root?: HTMLElement;
	matchMedia?: (query: string) => MotionQuery;
	createClient?: () => ChatClient;
	loadBootstraps?: () => Promise<SessionBootstrap[]>;
	runtime?: Partial<PageRuntime>;
	assetOrigin?: string;
	positionArea?: PositionArea;
	pruneStalePositions?: boolean;
	attachSession?: (
		sessionId: string,
		held: SessionBootstrap[],
	) => Promise<LocalAttachResult>;
	onHeldAdopted?: (bootstrap: SessionBootstrap) => void;
	onHeldEnded?: (bootstrap: SessionBootstrap) => void;
	onController?: (controller: ChatPageController) => void;
};

function isConnectionState(value: unknown): value is ChatConnectionState {
	return (
		value === "connected" ||
		value === "reconnecting" ||
		value === "daemon-not-running"
	);
}

type PillState = ChatConnectionState | "not-paired" | "connecting";

const NOT_PAIRED_HINT = "Not paired";

function connectionStatusLabel(state: PillState, detail?: string): string {
	const label = {
		"not-paired": NOT_PAIRED_HINT,
		connecting: "Connecting…",
		reconnecting: "Reconnecting to daemon…",
		"daemon-not-running": "Daemon unreachable",
		connected: "",
	}[state];
	return detail && state !== "not-paired" && state !== "connected"
		? `${label} ${detail}`
		: label;
}

function isChatHistoryItem(value: unknown): value is ChatHistoryItem {
	if (typeof value !== "object" || value === null) return false;
	const item = value as Record<string, unknown>;
	return (
		typeof item.seq === "number" &&
		typeof item.id === "string" &&
		(item.role === "user" || item.role === "agent") &&
		typeof item.body === "string" &&
		typeof item.createdAt === "string" &&
		(item.attachmentId === undefined || typeof item.attachmentId === "string")
	);
}

type SendResult = SendUserMessageResult;

type PageChatClient = ChatClient & {
	sendCommandInvocation(
		sessionId: string,
		commandLabel: string,
		params?: Record<string, unknown>,
	): Promise<SendResult>;
};

function createRelayChatClient(runtime: RelayRuntime): PageChatClient {
	const knownSessions = new Set<string>();
	const listeners = new Set<(frame: ChatFrame) => void>();
	const connectionListeners = new Set<ConnectionListener>();
	let connectionState: ChatConnectionState = "daemon-not-running";

	runtime.onMessage.addListener((message) => {
		if (
			typeof message === "object" &&
			message !== null &&
			(message as Record<string, unknown>).type === MSG.connection
		) {
			const { state, detail } = message as Record<string, unknown>;
			if (!isConnectionState(state)) return;
			connectionState = state;
			for (const listener of connectionListeners) {
				listener(state, typeof detail === "string" ? detail : undefined);
			}
			return;
		}
		if (
			typeof message !== "object" ||
			message === null ||
			(message as Record<string, unknown>).type !== MSG.frame
		) {
			return;
		}
		let frame: ChatFrame;
		try {
			frame = validatePageChatFrame((message as Record<string, unknown>).frame);
		} catch {
			return;
		}
		if (frame.type === "session-list") {
			for (const summary of frame.sessions)
				knownSessions.add(summary.sessionId);
		} else if (frame.type === "session-pending") {
			knownSessions.add(frame.newSession.sessionId);
		} else if (frame.type === "session-closed" || frame.type === "session-disconnected") {
			knownSessions.delete(frame.sessionId);
		}
		if (frame.type !== "session-closed" && frame.type !== "session-disconnected") {
			connectionState = "connected";
		}
		for (const listener of listeners) listener(frame);
	});

	function sendAndWait(message: unknown): Promise<SendResult> {
		return runtime
			.sendMessage(message)
			.then((response): SendResult => {
				if (
					typeof response === "object" &&
					response !== null &&
					(response as Record<string, unknown>).ok === false
				) {
					const error = (response as Record<string, unknown>).error;
					return {
						ok: false,
						error:
							typeof error === "string"
								? error
								: "the daemon rejected this request",
					};
				}
				connectionState = "connected";
				return { ok: true };
			})
			.catch((error): SendResult => {
				connectionState = "daemon-not-running";
				return {
					ok: false,
					error: error instanceof Error ? error.message : String(error),
				};
			});
	}

	function send(message: unknown): void {
		void sendAndWait(message);
	}

	function buildUserMessage(
		sessionId: string,
		body: string,
		messageId: string,
		opts: SendUserMessageOptions,
	): Record<string, unknown> {
		return {
			type: MSG.userMessage,
			sessionId,
			body,
			messageId,
			...(opts.subagentName ? { subagentName: opts.subagentName } : {}),
		};
	}

	function connect(bootstrap: SessionBootstrap): void {
		knownSessions.add(bootstrap.sessionId);
		void runtime
			.sendMessage({ type: MSG.clientConnect, bootstrap })
			.then((response) => {
				if (typeof response !== "object" || response === null) return;
				const state = (response as Record<string, unknown>).state;
				if (isConnectionState(state)) connectionState = state;
			})
			.catch(() => {
				connectionState = "daemon-not-running";
			});
	}

	return {
		connect,

		addSession(bootstrap): void {
			if (!knownSessions.has(bootstrap.sessionId)) connect(bootstrap);
		},

		onFrame(listener): void {
			listeners.add(listener);
		},

		onConnectionChange(listener): void {
			connectionListeners.add(listener);
		},

		sendUserMessage(
			sessionId: string,
			body: string,
			opts: SendUserMessageOptions = {},
		): string {
			if (!knownSessions.has(sessionId)) {
				throw new Error(
					`Session ${sessionId} is not available in this chat page`,
				);
			}
			const messageId = opts.messageId ?? crypto.randomUUID();
			send(buildUserMessage(sessionId, body, messageId, opts));
			return messageId;
		},

		sendUserMessageAndWait(
			sessionId: string,
			body: string,
			opts: SendUserMessageOptions = {},
		): Promise<SendResult> {
			if (!knownSessions.has(sessionId)) {
				return Promise.resolve({
					ok: false,
					error: `Session ${sessionId} is not available in this chat page`,
				});
			}
			const messageId = opts.messageId ?? crypto.randomUUID();
			return sendAndWait(buildUserMessage(sessionId, body, messageId, opts));
		},

		getConnectionState(): ChatConnectionState {
			return connectionState;
		},

		disconnectSession(sessionId: string): Promise<void> {
			return sendAndWait({ type: MSG.sessionDisconnect, sessionId }).then((reply) => {
				if (!reply.ok) throw new Error(reply.error);
				knownSessions.delete(sessionId);
			});
		},

		closeSession(sessionId: string): void {
			if (!knownSessions.has(sessionId)) {
				throw new Error(
					`Session ${sessionId} is not available in this chat page`,
				);
			}
			send({ type: MSG.sessionClose, sessionId });
		},

		forgetSession(sessionId: string): void {
			knownSessions.delete(sessionId);
		},

		retryNow(): void {
			send({ type: MSG.connectionRetry });
		},

		sendCommandInvocation(
			sessionId: string,
			commandLabel: string,
			params: Record<string, unknown> = {},
		): Promise<SendResult> {
			if (!knownSessions.has(sessionId)) {
				return Promise.resolve({
					ok: false,
					error: `Session ${sessionId} is not available in this chat page`,
				});
			}
			return sendAndWait({
				type: MSG.commandInvocation,
				sessionId,
				commandLabel,
				params,
			});
		},
	};
}

function dispatchCommandThroughClient(
	client: ChatClient,
	sessionId: string,
	commandLabel: string,
): Promise<SendResult> {
	if (client.sendCommandInvocation) {
		return client.sendCommandInvocation(sessionId, commandLabel);
	}
	return Promise.resolve({
		ok: false,
		error: "this chat page cannot dispatch commands",
	});
}

function sendAndWaitForAccept(
	client: ChatClient,
	sessionId: string,
	body: string,
	messageId: string,
): Promise<SendResult> {
	return client.sendUserMessageAndWait(sessionId, body, { messageId });
}

function iconControl<K extends "button" | "a">(
	doc: Document,
	tag: K,
	action: string,
	icon: IconName,
	label: string,
): HTMLElementTagNameMap[K] {
	const node = element(doc, tag, "chat-icon-button");
	node.dataset.action = action;
	node.setAttribute("aria-label", label);
	node.title = label;
	if (tag === "button") node.setAttribute("type", "button");
	node.append(createIcon(doc, icon));
	return node;
}

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

function formatGroupCount(group: WorksetGroup): string {
	if (!group.workset) {
		const count = group.sessions.length;
		return `${count} ${count === 1 ? "chat" : "chats"}`;
	}
	const count = group.sessions.filter((entry) => entry.role === "agent").length;
	return `${count} ${count === 1 ? "slice" : "slices"}`;
}

export async function renderChatPage(
	options: ChatPageOptions = {},
): Promise<void> {
	const root = options.root ?? document.getElementById("app") ?? document.body;
	const doc = root.ownerDocument;
	const matchMedia =
		options.matchMedia ??
		((query: string) =>
			(
				doc.defaultView as unknown as { matchMedia(query: string): MotionQuery }
			).matchMedia(query));
	const runtime = options.runtime ?? {};
	const { sendMessage, onMessage } = runtime;
	const client = (
		options.createClient ??
		(() => {
			if (!sendMessage || !onMessage) {
				throw new Error("the chat page needs a relay runtime or a createClient");
			}
			return createRelayChatClient({ sendMessage, onMessage });
		})
	)();
	const bootstraps = await (options.loadBootstraps ?? (async () => []))();
	const positionArea =
		options.positionArea ??
		positionAreaFor(runtime.storage ?? memoryStorage());
	const sessions = createChatSessions();
	const nodes = new Map<string, ChatNode>();
	const autocompletes = new Map<string, CommandAutocomplete>();
	const manifests = new Map<string, CommandEntry[]>();
	const canvasPositions = new Map<string, Point>();
	const bootstrapBySession = new Map(
		bootstraps.map((bootstrap) => [bootstrap.sessionId, bootstrap]),
	);
	const trackHeld = options.attachSession !== undefined;
	const attaching = new Set<string>();
	const railErrors = new Map<string, string>();
	let order = bootstraps.map((bootstrap) => bootstrap.sessionId);
	let selectedSessionId: string | undefined = order[0];
	let tokenRejected = false;
	let connectionDetail: string | undefined;
	let moving: { sessionId: string; originalOrder: string[] } | undefined;
	let activeDrag: { sessionId: string; cancel(): void } | undefined;

	root.className = "chat-page";
	root.dataset.theme = "dark";
	root.replaceChildren();

	const connectionStatus = element(doc, "div", "chat-rail__connection");
	connectionStatus.setAttribute("role", "status");
	connectionStatus.hidden = true;

	const rail = element(doc, "aside", "chat-rail");
	rail.setAttribute("aria-label", "Chat sessions");
	const railHeader = element(doc, "header", "chat-rail__header");
	const brand = element(doc, "h1", "chat-rail__brand", "DeeGee");
	const railActions = element(doc, "div", "chat-rail__actions");
	railActions.setAttribute("role", "toolbar");
	railActions.setAttribute("aria-label", "Sidebar actions");
	const canvasButton = iconControl(
		doc,
		"button",
		"toggle-canvas",
		"canvas",
		"Canvas view",
	);
	canvasButton.setAttribute("aria-pressed", "false");
	const overflowButton = iconControl(
		doc,
		"button",
		"toggle-overflow",
		"more",
		"More actions",
	);
	overflowButton.setAttribute("aria-expanded", "false");
	overflowButton.setAttribute("aria-controls", "chat-rail-overflow-menu");
	const overflowMenu = element(doc, "div", "chat-rail__overflow-menu");
	overflowMenu.id = "chat-rail-overflow-menu";
	overflowMenu.hidden = true;
	overflowMenu.setAttribute("role", "group");
	overflowMenu.setAttribute("aria-label", "More actions");
	const vimToggle = iconControl(
		doc,
		"button",
		"vim-toggle",
		"vim",
		"Vim navigation",
	);
	vimToggle.setAttribute("aria-pressed", "false");
	const themeButton = iconControl(doc, "button", "theme", "sun", "Theme");
	const settingsLink = iconControl(
		doc,
		"a",
		"settings",
		"settings",
		"Settings",
	);
	settingsLink.href = "/options.html#/settings";
	const overflowItems: Array<readonly [HTMLElement, string]> = [
		[vimToggle, "Vim navigation"],
		[themeButton, "Theme"],
	];
	if (sendMessage) overflowItems.push([settingsLink, "Settings"]);
	for (const [control, label] of overflowItems) {
		control.classList.add("chat-rail__overflow-item");
		control.append(element(doc, "span", "chat-rail__overflow-label", label));
	}
	overflowMenu.append(...overflowItems.map(([control]) => control));
	railActions.append(canvasButton, overflowButton, overflowMenu);
	railHeader.append(brand, railActions, connectionStatus);
	const vimFilterInput = element(doc, "input", "chat-vimfilter");
	vimFilterInput.type = "text";
	vimFilterInput.hidden = true;
	const vimCheat = element(
		doc,
		"div",
		"chat-vimcheat",
		"VIM  j/k move  gg/G ends  Enter select  x close  \\n new  / filter  ? this  Esc exit",
	);
	vimCheat.hidden = true;
	const railSections = element(doc, "nav", "chat-rail__sections");
	railSections.setAttribute("aria-label", "Sessions by workset");
	rail.append(railHeader, vimFilterInput, vimCheat, railSections);

	const thread = element(doc, "main", "chat-thread");
	const threadHeader = element(doc, "header", "chat-thread__header");
	const breadcrumb = element(doc, "div", "chat-thread__breadcrumb");
	const threadHeading = element(doc, "h2", "chat-thread__heading", "Chat");
	threadHeader.append(breadcrumb, threadHeading);
	const threadError = element(doc, "div", "chat-thread__error");
	threadError.setAttribute("role", "alert");
	threadError.hidden = true;
	const threadNodes = element(doc, "div", "chat-thread__nodes");
	thread.append(threadHeader, threadError, threadNodes);

	const moveStatus = element(doc, "div", "chat-move-status");
	moveStatus.setAttribute("role", "status");
	root.append(rail, thread, moveStatus);
	root.dataset.view = "rail";

	let canvas: ReturnType<typeof createChatCanvas> | undefined;
	let canvasContainer: HTMLElement | undefined;

	function zoomCanvas(deltaY: number): void {
		canvas?.zoomBy(deltaY);
	}

	function mountCanvas(): void {
		if (canvasContainer) return;
		const view = doc.defaultView as unknown as {
			innerWidth?: number;
			innerHeight?: number;
		};
		canvasContainer = element(doc, "section", "chat-canvas");
		canvasContainer.setAttribute("aria-label", "Session canvas");
		canvasContainer.dataset.motion = root.dataset.motion ?? "full";

		root.appendChild(canvasContainer);
		canvas = createChatCanvas(canvasContainer, {
			viewport: {
				scale: 1,
				pan: { x: 0, y: 0 },
				width: view.innerWidth ?? 1280,
				height: view.innerHeight ?? 800,
			},
		});

		const canvasChrome = canvas.chromeElement;
		const zoomOut = element(doc, "button", "chat-button", "Zoom out");
		zoomOut.type = "button";
		zoomOut.dataset.action = "zoom-out";
		zoomOut.addEventListener("click", () => zoomCanvas(120));
		const zoomIn = element(doc, "button", "chat-button", "Zoom in");
		zoomIn.type = "button";
		zoomIn.dataset.action = "zoom-in";
		zoomIn.addEventListener("click", () => zoomCanvas(-120));
		const canvasConnection = element(doc, "div", "chat-canvas__connection");
		canvasConnection.dataset.canvasConnection = "";
		canvasConnection.setAttribute("role", "status");
		canvasChrome.append(canvasConnection, zoomOut, zoomIn);
		updateConnectionStatus();
	}

	const CANVAS_SLOT = { x: 40, y: 40, dx: 360, dy: 320, perRow: 3 };

	function defaultCanvasSlot(index: number): Point {
		return {
			x: CANVAS_SLOT.x + (index % CANVAS_SLOT.perRow) * CANVAS_SLOT.dx,
			y:
				CANVAS_SLOT.y + Math.floor(index / CANVAS_SLOT.perRow) * CANVAS_SLOT.dy,
		};
	}

	function placeNode(sessionId: string, nodeElement: HTMLElement): void {
		const position = canvasPositions.get(sessionId);
		if (!position) return;
		nodeElement.style.position = "absolute";
		nodeElement.style.left = `${position.x}px`;
		nodeElement.style.top = `${position.y}px`;
	}

	function clearNodePlacement(nodeElement: HTMLElement): void {
		nodeElement.style.position = "";
		nodeElement.style.left = "";
		nodeElement.style.top = "";
	}

	function panFocusedNodeIntoView(sessionId: string): void {
		const position = canvasPositions.get(sessionId);
		const element = nodes.get(sessionId)?.element;
		if (!canvas || !position || !element) return;
		const view = canvas.viewport();
		const rect = {
			x: position.x,
			y: position.y,
			width: element.offsetWidth,
			height: element.offsetHeight,
		};
		if (isNodeInView(rect, view)) return;
		canvas.panTo({
			x: view.width / 2 - position.x * view.scale,
			y: view.height / 2 - position.y * view.scale,
		});
	}

	function ensureDragHandle(sessionId: string, nodeElement: HTMLElement): void {
		if (nodeElement.querySelector(".chat-node__drag")) return;
		const handle = element(doc, "button", "chat-node__drag", "Move");
		handle.type = "button";
		handle.dataset.action = "drag-node";
		handle.setAttribute("aria-label", "Move this session on the canvas");
		handle.addEventListener("pointerdown", (event) => {
			const pointerEvent = event as PointerEvent;
			if (pointerEvent.button !== 0) return;
			const origin = canvasPositions.get(sessionId);
			if (!origin || !canvas) return;
			const scale = canvas.viewport().scale;
			const start = { x: pointerEvent.clientX, y: pointerEvent.clientY };
			let latest = { ...origin };

			activeDrag?.cancel();
			const drag = trackPointerDrag(doc, pointerEvent.pointerId, {
				onMove(point) {
					latest = {
						x: origin.x + (point.x - start.x) / scale,
						y: origin.y + (point.y - start.y) / scale,
					};
					canvasPositions.set(sessionId, latest);
					placeNode(sessionId, nodeElement);
				},
				onEnd() {
					activeDrag = undefined;
					void saveNodePosition(positionArea, sessionId, latest);
				},
			});
			activeDrag = {
				sessionId,
				cancel: () => {
					drag.cancel();
					activeDrag = undefined;
				},
			};
		});
		nodeElement.prepend(handle);
	}

	function removeDragHandle(nodeElement: HTMLElement): void {
		nodeElement.querySelector(".chat-node__drag")?.remove();
	}

	async function loadCanvasPositions(): Promise<void> {
		const liveIds = sessions.list().map((entry) => entry.sessionId);
		const liveIdSet = new Set(liveIds);
		const stored = await loadNodePositions(positionArea, liveIds, {
			prune: options.pruneStalePositions,
		});
		liveIds.forEach((sessionId, index) => {
			const saved = stored.get(sessionId);
			canvasPositions.set(sessionId, saved ?? defaultCanvasSlot(index));
		});
		for (const sessionId of [...canvasPositions.keys()]) {
			if (!liveIdSet.has(sessionId)) canvasPositions.delete(sessionId);
		}
		syncPage();
	}

	function setCanvasVisible(visible: boolean): void {
		if (visible) mountCanvas();
		root.dataset.view = visible ? "canvas" : "rail";
		canvasButton.setAttribute("aria-pressed", String(visible));
		if (canvasContainer) canvasContainer.hidden = !visible;
		if (visible) void loadCanvasPositions();
		else {
			for (const node of nodes.values()) {
				removeDragHandle(node.element);
				clearNodePlacement(node.element);
			}
			syncPage();
		}
	}

	canvasButton.addEventListener("click", () => {
		setCanvasVisible(root.dataset.view !== "canvas");
	});

	root.addEventListener("focusin", (event) => {
		if (root.dataset.view !== "canvas") return;
		const target = event.target as HTMLElement | null;
		const owner = target?.closest<HTMLElement>(".chat-node");
		const sessionId = owner?.dataset.sessionId;
		if (sessionId) panFocusedNodeIntoView(sessionId);
	});

	const motionQuery = matchMedia("(prefers-reduced-motion: reduce)");
	const syncMotion = () => {
		const motion = motionQuery.matches ? "reduced" : "full";
		root.dataset.motion = motion;
		if (canvasContainer) canvasContainer.dataset.motion = motion;
	};
	syncMotion();
	motionQuery.addEventListener("change", syncMotion);

	function showEmpty(
		kind: "no-session" | "daemon-unreachable",
		title: string,
		body: string,
	): void {
		railSections.replaceChildren();
		threadNodes.replaceChildren();
		breadcrumb.textContent = "DeeGee / chat";
		threadHeading.textContent = title;
		const empty = element(doc, "section", "chat-empty");
		empty.dataset.emptyState = kind;
		empty.append(
			element(doc, "h3", "chat-empty__title", title),
			element(doc, "p", "chat-empty__body", body),
		);
		threadNodes.appendChild(empty);
	}

	function announceMove(message: string): void {
		moveStatus.textContent = message;
	}

	function showError(error: unknown): void {
		const message = error instanceof Error ? error.message : String(error);
		threadError.textContent = redactSecrets(message, [
			...bootstrapBySession.values(),
		].map((bootstrap) => bootstrap.token));
		threadError.hidden = false;
	}

	function isPaired(): boolean {
		return !tokenRejected && (bootstraps.length > 0 || sessions.list().length > 0);
	}

	function isSessionConfirmed(): boolean {
		if (!client.isSessionConfirmed) return true;
		const liveSessionId =
			selectedSessionId && bootstrapBySession.has(selectedSessionId)
				? selectedSessionId
				: [...bootstrapBySession.keys()][0];
		return liveSessionId ? client.isSessionConfirmed(liveSessionId) : false;
	}

	function renderSessionHeader(entry: ChatSessionEntry | undefined): void {
		const identity = entry?.agentIdentity || "agent";
		breadcrumb.textContent = entry
			? `${entry.workset ?? "Loose chats"} / ${identity}`
			: "DeeGee / chat";
		threadHeading.textContent = entry
			? `Talking to ${identity} · ${entry.sessionId.slice(0, 8)} · ${presenceLabel(entry.presence)}`
			: "Chat";
	}

	function pillState(): PillState {
		if (!isPaired()) return "not-paired";
		const connection = client.getConnectionState();
		if (connection === "connected" && !isSessionConfirmed()) return "connecting";
		return connection;
	}

	function updateConnectionStatus(): void {
		const state = pillState();
		connectionStatus.dataset.connection = state;
		connectionStatus.hidden = state === "connected";
		const message = connectionStatusLabel(state, connectionDetail);
		connectionStatus.textContent = message;
		const canvasBanner = canvasContainer?.querySelector<HTMLElement>(
			"[data-canvas-connection]",
		);
		if (canvasBanner) {
			canvasBanner.dataset.connection = state;
			canvasBanner.hidden = state === "connected";
			canvasBanner.textContent = message;
		}
	}

	function isHeld(sessionId: string): boolean {
		return !trackHeld || bootstrapBySession.has(sessionId);
	}

	function isListed(entry: ChatSessionEntry): boolean {
		if (entry.sessionId === OVERWATCH_SESSION_ID) return false;
		return entry.role === "agent" || isHeld(entry.sessionId);
	}

	function isAttachable(entry: ChatSessionEntry): boolean {
		return isHeld(entry.sessionId) || entry.presence === "cli";
	}

	function heldBootstraps(): SessionBootstrap[] {
		const selected = selectedSessionId
			? bootstrapBySession.get(selectedSessionId)
			: undefined;
		const others = [...bootstrapBySession.values()].filter(
			(bootstrap) => bootstrap !== selected,
		);
		return selected ? [selected, ...others] : others;
	}

	function dropHeld(sessionId: string, announce: boolean): void {
		const bootstrap = bootstrapBySession.get(sessionId);
		if (!bootstrap) return;
		bootstrapBySession.delete(sessionId);
		options.onHeldEnded?.(bootstrap);
		if (bootstrapBySession.size === 0) tokenRejected = true;
		else if (announce) railErrors.set(sessionId, SESSION_ENDED_TEXT);
	}

	async function attachEntry(entry: ChatSessionEntry): Promise<void> {
		if (!options.attachSession || attaching.has(entry.sessionId)) return;
		attaching.add(entry.sessionId);
		railErrors.delete(entry.sessionId);
		const result = await options
			.attachSession(entry.sessionId, heldBootstraps())
			.catch((): LocalAttachResult => ({
				status: "failed",
				message: "Could not attach that session.",
				refused: [],
			}));
		attaching.delete(entry.sessionId);
		for (const refused of result.refused) {
			dropHeld(refused.sessionId, false);
		}
		if (result.status === "attached") {
			const { bootstrap } = result;
			bootstrapBySession.set(bootstrap.sessionId, bootstrap);
			tokenRejected = false;
			options.onHeldAdopted?.(bootstrap);
			client.addSession(bootstrap);
			setSelected(bootstrap.sessionId);
			return;
		}
		if (result.status !== "ended") {
			railErrors.set(
				entry.sessionId,
				redactSecrets(
					result.message,
					[...bootstrapBySession.values()].map((held) => held.token),
				),
			);
		}
		syncPage();
	}

	function activate(sessionId: string): void {
		const entry = sessions.get(sessionId);
		if (!entry || !isListed(entry) || !isAttachable(entry)) return;
		if (isHeld(sessionId)) setSelected(sessionId);
		else void attachEntry(entry);
	}

	function setSelected(sessionId: string): void {
		selectedSessionId = sessionId;
		sessions.markSessionRead(sessionId);
		syncPage();
	}

	function armMove(sessionId: string): void {
		moving = { sessionId, originalOrder: [...order] };
		announceMove(
			"Move mode. Use Arrow Up or Arrow Down, Enter to commit, or Escape to cancel.",
		);
		for (const row of root.querySelectorAll<HTMLElement>(".chat-rail__row")) {
			row.dataset.moving = String(row.dataset.sessionId === sessionId);
		}
	}

	function finishMove(canceled: boolean): void {
		if (!moving) return;
		if (canceled) order = moving.originalOrder;
		announceMove(canceled ? "Move canceled." : "Position saved.");
		moving = undefined;
		syncPage();
	}

	function swapSessions(first: string, second: string): void {
		const firstIndex = order.indexOf(first);
		const secondIndex = order.indexOf(second);
		if (firstIndex < 0 || secondIndex < 0) return;
		[order[firstIndex], order[secondIndex]] = [
			order[secondIndex] as string,
			order[firstIndex] as string,
		];
	}

	function moveWithArrow(direction: -1 | 1): void {
		if (!moving) return;
		const current = sessions.get(moving.sessionId);
		if (!current) return;
		const siblings = order.filter((sessionId) => {
			const entry = sessions.get(sessionId);
			return entry?.workset === current.workset && entry?.role === current.role;
		});
		const index = siblings.indexOf(current.sessionId);
		const target = siblings[index + direction];
		if (!target) return;
		swapSessions(current.sessionId, target);
		announceMove(
			`${current.agentIdentity} moved to position ${index + direction + 1} of ${siblings.length}.`,
		);
		syncPage();
	}

	function ensureNode(sessionId: string): ChatNode | undefined {
		const entry = sessions.get(sessionId);
		if (!entry) return undefined;
		const existing = nodes.get(sessionId);
		if (existing) {
			existing.render(entry);
			return existing;
		}
		const bootstrap = bootstrapBySession.get(sessionId);
		const node = createChatNode(entry, {
			document: doc,
			port: bootstrap?.port,
			assetOrigin: options.assetOrigin,
			onSubmit: (body) => {
				const messageId = crypto.randomUUID();
				node.transcript.appendUserMessage(body, messageId);
				void sendAndWaitForAccept(client, sessionId, body, messageId).then(
					(result) => {
						if (result.ok) {
							node.transcript.setDelivery(messageId, "delivered");
							return;
						}
						node.transcript.setDelivery(messageId, "not-delivered");
						if (result.reason !== "timeout") showError(result.error);
					},
				);
			},
			onClose: () => {
				try {
					client.closeSession(sessionId);
				} catch (error) {
					showError(error);
				}
			},
			onMove: () => {
				if (moving?.sessionId === sessionId) finishMove(false);
				else armMove(sessionId);
			},
		});
		node.element.addEventListener("click", (event) => {
			if (!moving || moving.sessionId === sessionId) return;
			if (event.target !== node.element) return;
			swapSessions(moving.sessionId, sessionId);
			finishMove(false);
		});
		autocompletes.set(
			sessionId,
			attachCommandAutocomplete(node.composer.inputElement, {
				getCommands: () => manifests.get(sessionId) ?? [],
				onDispatch: (commandLabel) => {
					void dispatchCommandThroughClient(
						client,
						sessionId,
						commandLabel,
					).then((result) => {
						if (!result.ok) showError(result.error);
					});
				},
			}),
		);
		nodes.set(sessionId, node);
		return node;
	}

	function syncPage(): void {
		const entries = sessions.list();
		const liveIds = new Set(entries.map((entry) => entry.sessionId));
		order = order.filter((sessionId) => liveIds.has(sessionId));
		const orderedIds = new Set(order);
		for (const entry of entries) {
			if (orderedIds.has(entry.sessionId)) continue;
			order.push(entry.sessionId);
			orderedIds.add(entry.sessionId);
		}
		for (const [sessionId, node] of nodes) {
			if (liveIds.has(sessionId) && isHeld(sessionId)) continue;
			if (moving?.sessionId === sessionId) {
				moving = undefined;
				announceMove("Move canceled — the session closed.");
			}
			if (activeDrag?.sessionId === sessionId) activeDrag.cancel();
			autocompletes.get(sessionId)?.destroy();
			autocompletes.delete(sessionId);
			manifests.delete(sessionId);
			canvasPositions.delete(sessionId);
			bootstrapBySession.delete(sessionId);
			removeDragHandle(node.element);
			node.destroy();
			nodes.delete(sessionId);
		}

		const orderedEntries = order
			.map((sessionId) => sessions.get(sessionId))
			.filter((entry): entry is ChatSessionEntry => entry !== undefined)
			.filter(isListed);
		const groups = groupSessionsByWorkset(orderedEntries);
		if (
			!selectedSessionId ||
			!liveIds.has(selectedSessionId) ||
			!isHeld(selectedSessionId)
		) {
			selectedSessionId = orderedEntries.find((entry) =>
				isHeld(entry.sessionId),
			)?.sessionId;
		}

		const activeElement = doc.activeElement as HTMLElement | null;
		const focusedRailRow =
			activeElement?.closest<HTMLElement>(".chat-rail__row") ?? null;
		const refocusSessionId = focusedRailRow?.dataset.sessionId;

		railSections.replaceChildren();
		for (const empty of threadNodes.querySelectorAll(".chat-empty")) {
			empty.remove();
		}
		for (const group of groups) {
			const section = element(doc, "section", "chat-rail__section");
			const label = group.workset ?? "loose chats";
			const header = element(doc, "h2", "chat-rail__section-header", label);
			header.appendChild(
				element(
					doc,
					"span",
					"chat-rail__section-count",
					formatGroupCount(group),
				),
			);
			section.appendChild(header);

			for (const entry of group.sessions) {
				const row = element(doc, "div", "chat-rail__row");
				row.dataset.sessionId = entry.sessionId;
				row.dataset.role = entry.role;
				row.dataset.active = String(entry.sessionId === selectedSessionId);
				if (moving?.sessionId === entry.sessionId) row.dataset.moving = "true";
				row.hidden = !vimFilterMatches(entry);
				const held = isHeld(entry.sessionId);
				const unavailable = !isAttachable(entry);
				row.dataset.held = String(held);
				if (unavailable) {
					row.setAttribute("aria-disabled", "true");
					row.title = "Agent not attached";
				}

				const focus = element(doc, "button", "chat-rail__focus");
				focus.type = "button";
				focus.disabled = unavailable;
				focus.append(
					element(
						doc,
						"span",
						"chat-rail__identity",
						entry.agentIdentity || "agent",
					),
					element(
						doc,
						"span",
						"chat-rail__meta",
						`${entry.sessionId.slice(0, 8)} · ${presenceLabel(entry.presence)}`,
					),
				);
				const status = element(
					doc,
					"span",
					"chat-rail__status",
					statusLabel(entry.status),
				);
				status.dataset.status = entry.status;
				focus.appendChild(status);
				row.addEventListener("click", () => {
					if (moving && moving.sessionId !== entry.sessionId) {
						swapSessions(moving.sessionId, entry.sessionId);
						finishMove(false);
						return;
					}
					activate(entry.sessionId);
				});

				row.append(focus);
				const railError = railErrors.get(entry.sessionId);
				if (railError) {
					const error = element(
						doc,
						"p",
						"chat-rail__entry-error",
						railError,
					);
					error.setAttribute("role", "alert");
					row.append(error);
				}
				section.appendChild(row);

				const node = held ? ensureNode(entry.sessionId) : undefined;
				if (node) {
					const onCanvas =
						root.dataset.view === "canvas" && canvas !== undefined;
					const focused = entry.sessionId === selectedSessionId;
					node.element.hidden = onCanvas ? false : !focused;
					node.setActive(onCanvas || focused);
					const transcript = node.element.querySelector(".chat-transcript");
					if (onCanvas || focused)
						transcript?.setAttribute("aria-live", "polite");
					else transcript?.removeAttribute("aria-live");
					if (onCanvas && canvas) {
						ensureDragHandle(entry.sessionId, node.element);
						placeNode(entry.sessionId, node.element);
						canvas.boardElement.appendChild(node.element);
					} else {
						threadNodes.appendChild(node.element);
					}
				}
			}
			railSections.appendChild(section);
		}

		if (
			activeElement &&
			activeElement !== doc.body &&
			doc.contains(activeElement)
		) {
			activeElement.focus();
		} else if (refocusSessionId) {
			for (const row of railSections.querySelectorAll<HTMLElement>(
				".chat-rail__row",
			)) {
				if (row.dataset.sessionId !== refocusSessionId) continue;
				row.querySelector<HTMLElement>(".chat-rail__focus")?.focus();
				break;
			}
		}

		const selected = selectedSessionId
			? sessions.get(selectedSessionId)
			: undefined;
		renderSessionHeader(selected);
		updateConnectionStatus();
		paintVimCursor();
	}

	let vimCursorId: string | undefined;
	let vimFilterQuery = "";

	function vimFilterMatches(entry: ChatSessionEntry): boolean {
		if (!vimFilterQuery) return true;
		const query = vimFilterQuery.toLowerCase();
		return (
			entry.agentIdentity.toLowerCase().includes(query) ||
			(entry.workset ?? "").toLowerCase().includes(query)
		);
	}

	function vimRowIds(): string[] {
		const orderedEntries = order
			.map((sessionId) => sessions.get(sessionId))
			.filter((entry): entry is ChatSessionEntry => entry !== undefined);
		return groupSessionsByWorkset(orderedEntries).flatMap((group) =>
			group.sessions.filter(vimFilterMatches).map((entry) => entry.sessionId),
		);
	}

	function findRailRow(sessionId: string | undefined): HTMLElement | undefined {
		if (!sessionId) return undefined;
		for (const row of railSections.querySelectorAll<HTMLElement>(
			".chat-rail__row",
		)) {
			if (row.dataset.sessionId === sessionId) return row;
		}
		return undefined;
	}

	function paintVimCursor(): void {
		const active = vim.isActive();
		for (const row of railSections.querySelectorAll<HTMLElement>(
			".chat-rail__row",
		)) {
			row.dataset.vimCursor = String(
				active && row.dataset.sessionId === vimCursorId,
			);
		}
	}

	function closeSessionById(sessionId: string): void {
		try {
			client.closeSession(sessionId);
		} catch (error) {
			showError(error);
		}
	}

	const vim = createVimNav({
		order: ["sessions"],
		lists: {
			sessions: {
				rowIds: vimRowIds,
				select: (id) => activate(id),
				actions: {
					x: (id) => closeSessionById(id),
				},
			},
		},
		onCursorChange: (_list, id) => {
			vimCursorId = id;
			paintVimCursor();
			findRailRow(id)?.scrollIntoView?.({ block: "nearest" });
		},
		onOpenFilter: () => {
			vimFilterInput.hidden = false;
			vimFilterInput.value = vimFilterQuery;
			vimFilterInput.focus();
		},
		onModeChange: (isActive, message) => {
			vimToggle.setAttribute("aria-pressed", String(isActive));
			announceMove(message);
			if (!isActive) {
				vimFilterInput.hidden = true;
				paintVimCursor();
			}
		},
		onCheatSheet: (open) => {
			vimCheat.hidden = !open;
		},
		isTextInputFocused: () => isTextEntryFocused(doc),
	});

	function syncThemeButton(): void {
		const light = root.dataset.theme === "light";
		const label = `Theme: ${light ? "light" : "dark"}`;
		themeButton.setAttribute("aria-label", label);
		themeButton.title = label;
		themeButton.replaceChildren(
			createIcon(doc, light ? "sun" : "moon"),
			element(doc, "span", "chat-rail__overflow-label", label),
		);
	}

	function setOverflowOpen(open: boolean): void {
		overflowMenu.hidden = !open;
		overflowButton.setAttribute("aria-expanded", String(open));
	}

	overflowButton.addEventListener("click", () => {
		setOverflowOpen(overflowMenu.hidden === true);
	});
	overflowMenu.addEventListener("keydown", (event) => {
		if (event.key !== "Escape") return;
		setOverflowOpen(false);
		overflowButton.focus();
	});

	themeButton.addEventListener("click", () => {
		root.dataset.theme = root.dataset.theme === "light" ? "dark" : "light";
		syncThemeButton();
		setOverflowOpen(false);
	});
	syncThemeButton();

	vimToggle.addEventListener("click", () => {
		if (vim.isActive()) vim.disable();
		else vim.enable();
		setOverflowOpen(false);
	});

	vimFilterInput.addEventListener("input", () => {
		vimFilterQuery = vimFilterInput.value;
		syncPage();
	});
	vimFilterInput.addEventListener("keydown", (event) => {
		if (event.key === "Escape") {
			event.preventDefault();
			vimFilterQuery = "";
			vimFilterInput.value = "";
			vimFilterInput.hidden = true;
			syncPage();
		} else if (event.key === "Enter") {
			event.preventDefault();
			vimFilterInput.hidden = true;
		}
	});

	doc.addEventListener("keydown", (event) => {
		if (moving) {
			if (isTextEntryFocused(doc)) return;
			if (event.key === "ArrowUp" || event.key === "ArrowDown") {
				event.preventDefault();
				moveWithArrow(event.key === "ArrowUp" ? -1 : 1);
				return;
			}
			if (event.key === "Enter") {
				event.preventDefault();
				finishMove(false);
				return;
			}
			if (event.key === "Escape") {
				event.preventDefault();
				finishMove(true);
			}
			return;
		}
		vim.handleKeydown(event);
	});

	client.onFrame((frame) => {
		sessions.applyFrame(frame);
		if (frame.type === "session-closed") dropHeld(frame.sessionId, true);
		if (frame.type === "session-list") {
			for (const sessionId of railErrors.keys()) {
				if (!sessions.get(sessionId)) railErrors.delete(sessionId);
			}
		}
		if (frame.type === "session-pending") {
			const requester = bootstrapBySession.get(frame.sessionId);
			if (requester) {
				const adopted = {
					...requester,
					sessionId: frame.newSession.sessionId,
					token: frame.newSession.token,
				};
				bootstrapBySession.set(adopted.sessionId, adopted);
				options.onHeldAdopted?.(adopted);
			}
		}
		const node = nodes.get(frame.sessionId);
		switch (frame.type) {
			case "agent-message":
				void node?.transcript.appendAgentMessage(
					frame,
					bootstrapBySession.get(frame.sessionId)?.token ?? "",
				);
				break;
			case "ack":
				node?.transcript.setDelivery(frame.messageId, "delivered");
				break;
			case "command-result":
				node?.transcript.appendCommandResult(frame);
				break;
			case "manifest-publish":
				manifests.set(frame.sessionId, frame.commands);
				break;
			case "history-response":
				void node?.transcript.applyHistory(
					frame.messages.filter(isChatHistoryItem),
					frame.sessionId,
					bootstrapBySession.get(frame.sessionId)?.token ?? "",
				);
				break;
			case "progress":
				node?.transcript.updateProgress(frame.state);
				break;
			case "error":
				showError(frame.message);
				if (frame.code === "invalid-session") {
					dropHeld(frame.sessionId, true);
					updateConnectionStatus();
				}
				break;
		}
		if (
			frame.type === "session-list" ||
			frame.type === "session-pending" ||
			frame.type === "session-closed" ||
			frame.type === "session-disconnected" ||
			frame.type === "progress" ||
			frame.type === "agent-message"
		) {
			syncPage();
		}
	});

	client.onConnectionChange((_state, detail) => {
		connectionDetail = detail;
		updateConnectionStatus();
	});

	options.onController?.({
		dropSession(sessionId) {
			dropHeld(sessionId, false);
			syncPage();
			updateConnectionStatus();
		},
	});
	for (const bootstrap of bootstraps) client.connect(bootstrap);
	if (bootstraps.length === 0) {
		showEmpty(
			"no-session",
			"No sessions yet",
			"Run dg-agent start --open to open this page for an agent.",
		);
		updateConnectionStatus();
	} else {
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
		updateConnectionStatus();
		if (
			sessions.list().length === 0 &&
			client.getConnectionState() !== "connected"
		) {
			showEmpty(
				"daemon-unreachable",
				"Daemon unreachable",
				"A session is registered.",
			);
		}
	}
}
