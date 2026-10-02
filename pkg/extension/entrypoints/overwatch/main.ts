import {
	type ChatFrame,
	type OverwatchAction,
	type OverwatchBoard,
	type OverwatchLane,
	validateChatFrame,
} from "@dg/common";
import { browser } from "wxt/browser";
import { MSG } from "@/lib/chat-messages";
import { patchKeyedList } from "@/lib/dom-keyed-list";
import {
	connectOverwatchApi,
	formatCountdown,
	formatLaunchDate,
	formatUpdatedAt,
	needYouCount,
	type OverwatchApi,
	overwatchPort,
	stageCells,
} from "@/lib/features/overwatch";
import "../options/style.css";
import "./style.css";

type RuntimeListener = (message: unknown) => void;

type OverwatchRuntime = {
	onMessage: {
		addListener(listener: RuntimeListener): void;
		removeListener?(listener: RuntimeListener): void;
	};
};

export type RenderOverwatchOptions = {
	root: HTMLElement;
	runtime?: OverwatchRuntime;
	connect?: (knownPort?: number) => Promise<OverwatchApi | undefined>;
	now?: () => Date;
	schedule?: (callback: () => void, milliseconds: number) => number;
	cancel?: (handle: number) => void;
};

export type OverwatchPageHandle = {
	ready: Promise<void>;
	refresh(): Promise<void>;
	stop(): void;
};

type ActionRefs = {
	chat: string;
	trigger: HTMLButtonElement;
	menu: HTMLElement;
	replyForm: HTMLElement;
	replyNote: HTMLTextAreaElement;
	rejectForm: HTMLElement;
	rejectNote: HTMLTextAreaElement;
	status: HTMLElement;
	error: HTMLElement;
};

type LaneRefs = {
	name: HTMLElement;
	task: HTMLElement;
	cells: HTMLElement[];
	mr: HTMLElement;
	eta: HTMLElement;
	next: HTMLElement;
	updated: HTMLElement;
	actions: ActionRefs;
	link: HTMLAnchorElement;
	noLink: HTMLElement;
};

type BackgroundRefs = {
	name: HTMLElement;
	task: HTMLElement;
	stage: HTMLElement;
	eta: HTMLElement;
	next: HTMLElement;
	updated: HTMLElement;
	actions: ActionRefs;
};

function relayFrame(message: unknown): ChatFrame | undefined {
	if (typeof message !== "object" || message === null) return undefined;
	const payload = message as Record<string, unknown>;
	if (payload.type !== MSG.overwatchState) return undefined;
	try {
		return validateChatFrame(payload.frame);
	} catch {
		return undefined;
	}
}

export function renderOverwatchPage(
	options: RenderOverwatchOptions,
): OverwatchPageHandle {
	const {
		root,
		connect = connectOverwatchApi,
		now = () => new Date(),
		schedule = (callback, milliseconds) =>
			setInterval(callback, milliseconds) as never,
		cancel = (handle) => clearInterval(handle),
	} = options;
	const runtime =
		options.runtime ?? (browser.runtime as unknown as OverwatchRuntime);
	const doc = root.ownerDocument;
	let board: OverwatchBoard = { lanes: [], merges: [] };
	let api: OverwatchApi | undefined;
	let lastPort: number | undefined;
	let revision = 0;

	const laneRefs = new WeakMap<HTMLElement, LaneRefs>();
	const backgroundRefs = new WeakMap<HTMLElement, BackgroundRefs>();

	function element<K extends keyof HTMLElementTagNameMap>(
		tag: K,
		className?: string,
		text?: string,
	): HTMLElementTagNameMap[K] {
		const node = doc.createElement(tag);
		if (className) node.className = className;
		if (text !== undefined) node.textContent = text;
		return node;
	}

	function actionButton(label: string): HTMLButtonElement {
		const node = element("button", "overwatch__button", label);
		node.type = "button";
		return node;
	}

	const page = element("div", "overwatch");
	const top = element("header", "overwatch__top");
	const countdown = element("strong", "overwatch__countdown");
	const need = element("span", "overwatch__need");
	const connection = element(
		"div",
		"chat-rail__connection overwatch__connection",
	);
	connection.setAttribute("role", "status");
	connection.dataset.connection = "daemon-not-running";
	connection.textContent = "Daemon unreachable";
	connection.hidden = true;
	top.append(countdown, need);
	const dates = element("div", "overwatch__dates");
	const axis = element("div", "overwatch__axis");
	for (const label of ["Chat", "Review", "CI", "E2E", "Merge"]) {
		axis.append(element("span", undefined, label));
	}
	const lanes = element("main", "overwatch__lanes");
	const empty = element(
		"section",
		"overwatch__empty",
		"No launch lanes are reporting yet.",
	);
	empty.setAttribute("role", "status");
	const asks = element("div", "overwatch__asks");
	const footer = element("footer", "overwatch__footer");
	const backgroundPanel = element("section", "overwatch__foot");
	backgroundPanel.append(element("h2", undefined, "Background"));
	const backgroundList = element("div", "overwatch__background");
	const backgroundEmpty = element(
		"p",
		"overwatch__foot-empty",
		"No background agents reporting.",
	);
	backgroundPanel.append(backgroundList, backgroundEmpty);
	const mergePanel = element("section", "overwatch__foot");
	mergePanel.append(element("h2", undefined, "Merged today"));
	const merges = element("div", "overwatch__merges");
	const mergesEmpty = element(
		"p",
		"overwatch__foot-empty",
		"No merges reported today.",
	);
	mergePanel.append(merges, mergesEmpty);
	footer.append(backgroundPanel, mergePanel);
	const toast = element("div", "overwatch__toast");
	toast.setAttribute("role", "alert");
	toast.hidden = true;
	page.append(
		top,
		connection,
		dates,
		axis,
		lanes,
		empty,
		asks,
		footer,
		toast,
	);
	root.replaceChildren(page);

	function showToast(message: string): void {
		toast.textContent = message;
		toast.hidden = false;
	}

	async function ensureApi(): Promise<OverwatchApi | undefined> {
		if (api) return api;
		api = await connect(lastPort);
		if (api) lastPort = overwatchPort(api);
		return api;
	}

	async function sendAction(
		refs: ActionRefs,
		action: OverwatchAction["action"],
		note?: string,
	): Promise<void> {
		refs.status.hidden = true;
		refs.error.hidden = true;
		toast.hidden = true;
		const daemon = await ensureApi();
		if (!daemon) {
			showToast("Daemon unreachable");
			return;
		}
		const payload: OverwatchAction = {
			chat: refs.chat,
			action,
			...(note ? { note } : {}),
		};
		const result = await daemon.sendAction(payload);
		if (!result.ok) {
			showToast(result.error);
			return;
		}
		refs.status.textContent = "Sent";
		refs.status.hidden = false;
		refs.menu.hidden = true;
		refs.trigger.setAttribute("aria-expanded", "false");
		refs.replyForm.hidden = true;
		refs.rejectForm.hidden = true;
	}

	function buildActionControls(chat: string): {
		container: HTMLElement;
		refs: ActionRefs;
	} {
		const container = element("div", "overwatch__actions");
		const trigger = actionButton("Actions");
		trigger.setAttribute("aria-label", `Actions for ${chat}`);
		trigger.setAttribute("aria-expanded", "false");
		const menu = element("div", "overwatch__menu");
		menu.setAttribute("role", "menu");
		menu.hidden = true;
		const reply = actionButton("Reply");
		const approve = actionButton("Approve");
		const reject = actionButton("Reject");
		reply.setAttribute("role", "menuitem");
		approve.setAttribute("role", "menuitem");
		reject.setAttribute("role", "menuitem");
		menu.append(reply, approve, reject);

		const replyForm = element("div", "overwatch__action-form");
		replyForm.hidden = true;
		const replyNote = element("textarea");
		replyNote.setAttribute("aria-label", `Reply to ${chat}`);
		replyNote.maxLength = 2_000;
		const sendReply = actionButton("Send");
		replyForm.append(replyNote, sendReply);

		const rejectForm = element("div", "overwatch__action-form");
		rejectForm.hidden = true;
		const rejectNote = element("textarea");
		rejectNote.setAttribute("aria-label", `Rejection note for ${chat}`);
		rejectNote.maxLength = 2_000;
		const sendReject = actionButton("Send rejection");
		rejectForm.append(rejectNote, sendReject);

		const status = element("span", "overwatch__action-status");
		status.setAttribute("role", "status");
		status.hidden = true;
		const error = element("span", "overwatch__action-error");
		error.setAttribute("role", "alert");
		error.hidden = true;
		const refs: ActionRefs = {
			chat,
			trigger,
			menu,
			replyForm,
			replyNote,
			rejectForm,
			rejectNote,
			status,
			error,
		};

		trigger.addEventListener("click", () => {
			menu.hidden = !menu.hidden;
			trigger.setAttribute("aria-expanded", String(!menu.hidden));
		});
		reply.addEventListener("click", () => {
			replyForm.hidden = false;
			rejectForm.hidden = true;
			replyNote.focus();
		});
		approve.addEventListener("click", () => {
			void sendAction(refs, "approve");
		});
		reject.addEventListener("click", () => {
			rejectForm.hidden = false;
			replyForm.hidden = true;
			rejectNote.focus();
		});
		sendReply.addEventListener("click", () => {
			const note = replyNote.value.trim();
			if (!note) {
				error.textContent = "A reply is required.";
				error.hidden = false;
				return;
			}
			void sendAction(refs, "reply", note);
		});
		sendReject.addEventListener("click", () => {
			const note = rejectNote.value.trim();
			if (!note) {
				error.textContent = "A rejection note is required.";
				error.hidden = false;
				return;
			}
			void sendAction(refs, "reject", note);
		});

		container.append(trigger, menu, replyForm, rejectForm, status, error);
		return { container, refs };
	}

	function createLane(lane: OverwatchLane): HTMLElement {
		const article = element("article", "overwatch__lane");
		const who = element("div", "overwatch__who");
		const name = element("strong");
		const task = element("small");
		who.append(name, task);
		const cells = ["Review", "CI", "E2E", "Merge"].map((label) => {
			const cell = element("div", "overwatch__cell");
			cell.dataset.stage = label;
			return cell;
		});
		const detail = element("div", "overwatch__detail");
		const stats = element("div", "overwatch__stats");
		const mr = element("span");
		const eta = element("span");
		const next = element("strong", "overwatch__next");
		const updated = element("span", "overwatch__updated");
		stats.append(mr, eta, next, updated);
		const actionControls = buildActionControls(lane.chat);
		const link = element("a", "overwatch__open", "Open chat");
		link.target = "_blank";
		link.rel = "noopener noreferrer";
		const noLink = element("span", "overwatch__no-link", "No link");
		actionControls.container.append(link, noLink);
		detail.append(stats, actionControls.container);
		article.append(who, ...cells, detail);
		laneRefs.set(article, {
			name,
			task,
			cells,
			mr,
			eta,
			next,
			updated,
			actions: actionControls.refs,
			link,
			noLink,
		});
		return article;
	}

	function updateLane(article: HTMLElement, lane: OverwatchLane): void {
		const refs = laneRefs.get(article);
		if (!refs) return;
		article.className = lane.next
			? "overwatch__lane overwatch__lane--wait"
			: "overwatch__lane";
		refs.name.textContent = lane.chat;
		refs.task.textContent = lane.task;
		refs.actions.chat = lane.chat;
		refs.actions.trigger.setAttribute("aria-label", `Actions for ${lane.chat}`);
		stageCells(lane.stage).forEach((cell, index) => {
			const target = refs.cells[index];
			if (!target) return;
			target.className = `overwatch__cell overwatch__cell--${cell.state}`;
			target.textContent = cell.label;
		});
		refs.mr.textContent = lane.mr ? `MR ${lane.mr}` : "NO MR";
		refs.eta.textContent = lane.eta ? `ETA ${lane.eta}` : "ETA not set";
		refs.next.textContent = lane.next ? `NEXT: YOU ${lane.next}` : "";
		refs.next.hidden = !lane.next;
		refs.updated.textContent = formatUpdatedAt(lane.updatedAt, now());
		refs.link.hidden = !lane.url;
		refs.noLink.hidden = Boolean(lane.url);
		if (lane.url) refs.link.href = lane.url;
		else refs.link.removeAttribute("href");
	}

	function createBackground(lane: OverwatchLane): HTMLElement {
		const item = element("article", "overwatch__background-lane");
		const name = element("strong");
		const task = element("p");
		const facts = element("div", "overwatch__background-facts");
		const stage = element("span");
		const eta = element("span");
		facts.append(stage, eta);
		const next = element("p", "overwatch__next");
		const updated = element("span", "overwatch__updated");
		const actionControls = buildActionControls(lane.chat);
		item.append(
			name,
			task,
			facts,
			next,
			updated,
			actionControls.container,
		);
		backgroundRefs.set(item, {
			name,
			task,
			stage,
			eta,
			next,
			updated,
			actions: actionControls.refs,
		});
		return item;
	}

	function updateBackground(item: HTMLElement, lane: OverwatchLane): void {
		const refs = backgroundRefs.get(item);
		if (!refs) return;
		refs.name.textContent = lane.chat;
		refs.task.textContent = lane.task;
		refs.stage.textContent = lane.stage.toUpperCase();
		refs.eta.textContent = lane.eta ? `ETA ${lane.eta}` : "ETA not set";
		refs.next.textContent = lane.next ? `NEXT: YOU ${lane.next}` : "";
		refs.next.hidden = !lane.next;
		refs.updated.textContent = formatUpdatedAt(lane.updatedAt, now());
		refs.actions.chat = lane.chat;
		refs.actions.trigger.setAttribute("aria-label", `Actions for ${lane.chat}`);
	}

	function paint(): void {
		const at = now();
		countdown.textContent = board.goLive
			? `${formatCountdown(board.goLive, at)} TO GO LIVE`
			: "GO LIVE NOT SET";
		need.textContent = `${needYouCount(board.lanes)} NEED YOU`;
		dates.textContent = `GO OR NO GO ${formatLaunchDate(board.goNoGo)} · GO LIVE ${formatLaunchDate(board.goLive)}`;

		const chatLanes = board.lanes.filter((lane) => lane.kind === "chat");
		const backgroundLanes = board.lanes.filter(
			(lane) => lane.kind === "background",
		);
		patchKeyedList(lanes, chatLanes, {
			key: (lane) => lane.chat,
			create: createLane,
			update: updateLane,
		});
		patchKeyedList(backgroundList, backgroundLanes, {
			key: (lane) => lane.chat,
			create: createBackground,
			update: updateBackground,
		});
		empty.hidden = board.lanes.length > 0;
		backgroundEmpty.hidden = backgroundLanes.length > 0;

		const backgroundAsks = backgroundLanes
			.map((lane) => lane.next)
			.filter((next): next is string => Boolean(next));
		asks.hidden = backgroundAsks.length === 0;
		asks.textContent = `ALSO NEED YOU: ${backgroundAsks.join(" + ")}`;

		merges.replaceChildren(
			...board.merges.map((merge) =>
				element("span", undefined, `${merge.mr} ${merge.title}`),
			),
		);
		mergesEmpty.hidden = board.merges.length > 0;
	}

	function setOffline(offline: boolean): void {
		connection.hidden = !offline;
		connection.textContent = offline ? "Daemon unreachable" : "";
	}

	function acceptBoard(next: OverwatchBoard): void {
		board = next;
		revision += 1;
		setOffline(false);
		paint();
	}

	function onMessage(message: unknown): void {
		const frame = relayFrame(message);
		if (frame?.type === "overwatch-state") acceptBoard(frame.board);
	}

	async function refresh(): Promise<void> {
		const startedAt = revision;
		const daemon = await ensureApi();
		if (!daemon) {
			setOffline(true);
			paint();
			return;
		}
		try {
			const next = await daemon.getBoard();
			if (revision === startedAt) acceptBoard(next);
		} catch {
			api = undefined;
			setOffline(true);
			paint();
		}
	}

	runtime.onMessage.addListener(onMessage);
	paint();
	const ready = refresh();
	const timer = schedule(paint, 1_000);

	return {
		ready,
		refresh,
		stop() {
			cancel(timer);
			runtime.onMessage.removeListener?.(onMessage);
		},
	};
}

if (typeof document !== "undefined") {
	const root = document.querySelector<HTMLElement>("#app");
	if (root) {
		void renderOverwatchPage({ root }).ready.catch((error) => {
			console.error("[dg-overwatch] could not render the board:", error);
		});
	}
}
