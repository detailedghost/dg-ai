import { allowedPage, mailbox } from "@/lib/background/tab-guards";
import type { GroupColor } from "@/lib/config";
import { videoRecordingSupported } from "@/lib/features/demo-recorder";
import {
	type AgentTabView,
	BLOCKED_TAB_ERROR,
	MSG,
	PRIVATE_TAB_ERROR,
	type PairingRun,
	type PairingSession,
	type RecordDemoReply,
	type WebMcpGrantView,
} from "@dg/pages/chat-messages";
import { browser } from "wxt/browser";
import { button, element } from "./dom";
import { parseWebMcpGrants, webMcpGrantRow } from "./webmcp-grants";

const TICK_MS = 2000;
const LOGO_PIXELS = "44";
const BACKGROUND_UNREACHABLE =
	"DeeGee is not responding. Close and reopen this popup.";
const DAEMON_DOWN = "Daemon not running. Run dg-agent start.";
const DAEMON_CHANGED = "The daemon changed";
const DAEMON_CHANGED_HELP =
	"A different daemon is running. Trust it to keep using this browser with it.";
const NO_TOUR = "Open a page with a DeeGee video tour first.";
const NO_ACTIVE_TAB = "No active tab found. Open a page and try again.";
const ADD_TAB = "Add this tab";
const SELECT_TAB = "Select this tab";
const NO_SHORTCUT =
	"No keyboard shortcut is assigned to DeeGee. Assign one in your browser's extension shortcuts.";

const FEATURE_LABELS: Readonly<Record<string, string>> = {
	"pw-ext": "pw --ext",
	proto: "Prototype",
	inbox: "Inbox",
};

const PILLS = {
	working: { label: "Working", variant: "busy" },
	connected: { label: "Connected", variant: "on" },
	idle: { label: "Idle", variant: "" },
} as const;

const GROUP_SWATCH: Readonly<Record<GroupColor, string>> = {
	grey: "gc-grey",
	blue: "gc-blue",
	red: "gc-red",
	yellow: "gc-yellow",
	green: "gc-green",
	pink: "gc-pink",
	purple: "gc-purple",
	cyan: "gc-cyan",
	orange: "gc-orange",
};

const HOSTLESS_PROTOCOLS: ReadonlySet<string> = new Set([
	"about:",
	"chrome:",
	"chrome-extension:",
]);

const PRESENCES: readonly string[] = ["cli", "gone", "idle"];

type PopupRuntime = {
	onMessage: {
		addListener(listener: (message: unknown) => void): void;
		removeListener(listener: (message: unknown) => void): void;
	};
	openOptionsPage(): Promise<void>;
	sendMessage(message: unknown): Promise<unknown>;
};

export type PopupDeps = {
	runtime: PopupRuntime;
	findPort(): Promise<number | undefined>;
	now(): number;
	queryActiveTab?(): Promise<
		Array<{ id?: number; url?: string; incognito?: boolean }>
	>;
};

type GroupView = { color: GroupColor; tabs: AgentTabView[] };

export type PopupHandle = { ready: Promise<void>; destroy(): void };

type CardView = {
	session: PairingSession;
	wrapper: HTMLElement;
	card: HTMLElement;
	name: HTMLElement;
	shortId: HTMLElement;
	swatch: HTMLElement;
	colorName: HTMLElement;
	pill: HTMLElement;
	menu: HTMLButtonElement;
	unpair: HTMLButtonElement;
	tree?: HTMLElement;
	error?: HTMLElement;
};

type PairedView = {
	section: HTMLElement;
	count: HTMLElement;
	list: HTMLElement;
	cards: Map<string, CardView>;
	banner?: HTMLElement;
};

type OpenMenu = { trigger: HTMLButtonElement; panel: HTMLElement };

type DriveView = {
	row: HTMLElement;
	name: HTMLElement;
	tabs: HTMLElement;
	stop: HTMLButtonElement;
	status?: HTMLElement;
	error?: HTMLElement;
};

function setText(node: HTMLElement, text: string): void {
	if (node.textContent !== text) node.textContent = text;
}

function parseRuns(value: unknown): PairingRun[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap((item) => {
		const run = (item ?? {}) as Partial<PairingRun>;
		return typeof run.sessionId === "string" &&
			typeof run.requestId === "string" &&
			typeof run.feature === "string" &&
			typeof run.startedAt === "number"
			? [
					{
						sessionId: run.sessionId,
						requestId: run.requestId,
						feature: run.feature,
						startedAt: run.startedAt,
					},
				]
			: [];
	});
}

function parseSessions(reply: unknown): PairingSession[] {
	const list = (reply as { sessions?: unknown } | undefined)?.sessions;
	if (!Array.isArray(list)) return [];
	return list.flatMap((item) => {
		const fields = (item ?? {}) as Record<string, unknown>;
		if (
			typeof fields.sessionId !== "string" ||
			typeof fields.agentIdentity !== "string" ||
			typeof fields.connected !== "boolean"
		)
			return [];
		return [
			{
				sessionId: fields.sessionId,
				agentIdentity: fields.agentIdentity,
				connected: fields.connected,
				presence: PRESENCES.includes(fields.presence as string)
					? (fields.presence as PairingSession["presence"])
					: undefined,
				runs: parseRuns(fields.runs),
			},
		];
	});
}

function parseTabs(value: unknown): AgentTabView[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap((item) => {
		const tab = (item ?? {}) as Partial<AgentTabView>;
		return typeof tab.tabId === "number"
			? [
					{
						tabId: tab.tabId,
						title: typeof tab.title === "string" ? tab.title : "",
						url: typeof tab.url === "string" ? tab.url : "",
						selected: tab.selected === true,
						active: tab.active === true,
					},
				]
			: [];
	});
}


function parseGroups(reply: unknown): Map<string, GroupView> | undefined {
	const list = (reply as { groups?: unknown } | undefined)?.groups;
	if (!Array.isArray(list)) return undefined;
	const groups = new Map<string, GroupView>();
	for (const item of list) {
		const fields = (item ?? {}) as Record<string, unknown>;
		if (typeof fields.sessionId !== "string") continue;
		groups.set(fields.sessionId, {
			color:
				typeof fields.color === "string" &&
				Object.hasOwn(GROUP_SWATCH, fields.color)
					? (fields.color as GroupColor)
					: "grey",
			tabs: parseTabs(fields.tabs),
		});
	}
	return groups;
}

function parseRecordReply(reply: unknown): RecordDemoReply | undefined {
	const fields = (reply ?? {}) as Record<string, unknown>;
	switch (fields.outcome) {
		case "started":
		case "no-tour":
			return { outcome: fields.outcome };
		case "refused":
			return typeof fields.reason === "string"
				? { outcome: "refused", reason: fields.reason }
				: undefined;
		case "capture-failed":
			return {
				outcome: "capture-failed",
				shortcut: typeof fields.shortcut === "string" ? fields.shortcut : null,
			};
		default:
			return undefined;
	}
}

function pillFor(session: PairingSession): (typeof PILLS)[keyof typeof PILLS] {
	if (session.runs.length > 0) return PILLS.working;
	return session.connected && session.presence === "cli"
		? PILLS.connected
		: PILLS.idle;
}

export function renderAgentItems(
	agent: PairingSession,
	{ doc = document, now = Date.now }: { doc?: Document; now?(): number } = {},
): HTMLLIElement[] {
	return agent.runs.map((run) => {
		const seconds = Math.max(0, Math.floor((now() - run.startedAt) / 1000));
		const label = Object.hasOwn(FEATURE_LABELS, run.feature)
			? FEATURE_LABELS[run.feature]
			: run.feature;
		const row = element(doc, "li", "it run");
		row.append(element(doc, "span", "t", `${label} · ${seconds}s`));
		return row;
	});
}

function hostOf(url: string): string {
	try {
		const parsed = new URL(url);
		return HOSTLESS_PROTOCOLS.has(parsed.protocol) ? "" : parsed.host;
	} catch {
		return "";
	}
}

function renderTabItems(
	tabs: readonly AgentTabView[],
	doc: Document,
): HTMLLIElement[] {
	return tabs.map((tab) => {
		const row = element(doc, "li", tab.selected ? "it act" : "it");
		const title = tab.title || "New tab";
		const label = element(doc, "span", "t", title);
		label.setAttribute("title", title);
		row.append(label, element(doc, "span", "mono", hostOf(tab.url)));
		if (tab.selected) row.setAttribute("aria-current", "true");
		return row;
	});
}

export function mountPopup(root: HTMLElement, deps: PopupDeps): PopupHandle {
	const { runtime, findPort, now } = deps;
	const queryActiveTab =
		deps.queryActiveTab ??
		(() => browser.tabs.query({ active: true, currentWindow: true }));
	const doc = root.ownerDocument;
	let destroyed = false;
	let readVersion = 0;
	let openMenu: OpenMenu | undefined;
	let empty: { reachable: boolean } | undefined;
	let paired: PairedView | undefined;
	let changed: HTMLElement | undefined;
	let recordNote: HTMLElement | undefined;
	let groups = new Map<string, GroupView>();
	let sessions: PairingSession[] = [];
	let adopting = 0;
	let ticking = false;
	const driveViews = new Map<string, DriveView>();
	const stopped = new Set<string>();
	let webmcpGrants: WebMcpGrantView[] = [];
	let webmcpShown = "[]";

	const sub = element(doc, "div", "sub");
	const title = element(doc, "div", "grow");
	title.append(element(doc, "h1", "neon-title", "DeeGee"), sub);
	const logo = element(doc, "img", "logo");
	logo.setAttribute("src", "/icon/48.png");
	logo.setAttribute("width", LOGO_PIXELS);
	logo.setAttribute("height", LOGO_PIXELS);
	logo.setAttribute("alt", "DeeGee ghost logo");
	const menuHost = element(doc, "div", "menu-host");
	const header = element(doc, "div", "row head");
	const body = element(doc, "div", "body");
	const driving = element(doc, "section", "driving");
	driving.setAttribute("aria-label", "Agents driving tabs");
	const drivingList = element(doc, "div", "agents");
	driving.append(element(doc, "div", "cnt", "Agents driving tabs"), drivingList);
	const webmcp = element(doc, "section", "webmcp");
	webmcp.setAttribute("aria-label", "Web MCP grants");
	const webmcpList = element(doc, "div", "agents");
	const webmcpError = element(doc, "p", "note err");
	webmcpError.setAttribute("role", "status");
	webmcpError.hidden = true;
	const webmcpHead = element(doc, "div", "row");
	const webmcpTitle = element(doc, "div", "cnt grow", "Web MCP grants");
	webmcpHead.append(
		webmcpTitle,
		button(doc, "btn btn-sm btn-danger", "Revoke all", () => void revokeWebMcp({ type: MSG.webmcpRevokeAll })),
	);
	webmcp.append(webmcpHead, webmcpList, webmcpError);

	function closeMenu(returnFocus: boolean): void {
		if (!openMenu) return;
		const { trigger, panel } = openMenu;
		openMenu = undefined;
		panel.remove();
		trigger.setAttribute("aria-expanded", "false");
		if (returnFocus) trigger.focus();
	}

	function menuItem(label: string, run: () => void): HTMLButtonElement {
		const item = button(doc, "btn btn-sm menu-item", label, () => {
			if (item.getAttribute("aria-disabled") === "true") return;
			closeMenu(true);
			run();
		});
		item.setAttribute("role", "menuitem");
		return item;
	}

	function menuTrigger(
		label: string,
		host: HTMLElement,
		items: () => HTMLButtonElement[],
	): HTMLButtonElement {
		const trigger = button(doc, "btn btn-sm menu-btn", "⋯", () => {
			if (openMenu?.trigger === trigger) {
				closeMenu(true);
				return;
			}
			closeMenu(false);
			const panel = element(doc, "div", "menu");
			panel.setAttribute("role", "menu");
			panel.append(...items());
			host.append(panel);
			trigger.setAttribute("aria-expanded", "true");
			openMenu = { trigger, panel };
			(panel.firstElementChild as HTMLElement | null)?.focus();
		});
		trigger.setAttribute("aria-label", label);
		trigger.setAttribute("aria-haspopup", "menu");
		trigger.setAttribute("aria-expanded", "false");
		return trigger;
	}

	function showRecordNote(text: string | undefined): void {
		if (text === undefined) {
			recordNote?.remove();
			recordNote = undefined;
			return;
		}
		if (!recordNote) {
			recordNote = element(doc, "p", "note");
			recordNote.setAttribute("role", "status");
			header.after(recordNote);
		}
		setText(recordNote, text);
	}

	async function recordDemo(): Promise<void> {
		showRecordNote(undefined);
		const [tab] = await queryActiveTab().catch(() => []);
		if (destroyed) return;
		if (tab?.id === undefined) {
			showRecordNote(NO_ACTIVE_TAB);
			return;
		}
		const reply = parseRecordReply(
			await runtime
				.sendMessage({ type: MSG.recordDemo, tabId: tab.id })
				.catch(() => undefined),
		);
		if (destroyed) return;
		switch (reply?.outcome) {
			case "started":
				doc.defaultView?.close();
				break;
			case "no-tour":
				showRecordNote(NO_TOUR);
				break;
			case "refused":
				showRecordNote(reply.reason);
				break;
			case "capture-failed":
				showRecordNote(
					reply.shortcut === null
						? NO_SHORTCUT
						: `Press ${reply.shortcut} on the page to start recording.`,
				);
				break;
			default:
				showRecordNote(BACKGROUND_UNREACHABLE);
		}
	}

	menuHost.append(
		menuTrigger("Menu", menuHost, () => [
			menuItem("Settings", () => void runtime.openOptionsPage()),
			...(videoRecordingSupported()
				? [menuItem("Record demo", () => void recordDemo())]
				: []),
		]),
	);
	header.append(logo, title, menuHost);
	root.replaceChildren(header, body);

	function showCardError(view: CardView, text: string | undefined): void {
		if (text === undefined) {
			view.error?.remove();
			view.error = undefined;
			return;
		}
		if (!view.error) {
			view.error = element(doc, "p", "note err");
			view.error.setAttribute("role", "status");
			view.card.append(view.error);
		}
		setText(view.error, text);
	}

	async function readAgents(): Promise<void> {
		const version = ++readVersion;
		const [reply, tabsReply, grantsReply] = await Promise.all([
			runtime.sendMessage({ type: MSG.connectionRequest }).catch(() => undefined),
			runtime.sendMessage({ type: MSG.agentTabsRequest }).catch(() => undefined),
			runtime.sendMessage({ type: MSG.webmcpGrantsRequest }).catch(() => undefined),
		]);
		if (destroyed || version !== readVersion) return;
		groups = parseGroups(tabsReply) ?? groups;
		webmcpGrants = parseWebMcpGrants(grantsReply);
		if ((reply as { daemonChanged?: unknown } | undefined)?.daemonChanged === true) {
			showDriving();
			showDaemonChanged();
			return;
		}
		sessions = parseSessions(reply);
		showDriving();
		const daemonReachable =
			sessions.some((session) => session.connected) ||
			(await findPort()) !== undefined;
		if (destroyed || version !== readVersion) return;
		if (sessions.length === 0) showEmpty(daemonReachable);
		else showPaired(sessions, !daemonReachable);
	}

	function driveLabel(sessionId: string): string {
		const shortId = sessionId.slice(0, 8);
		const identity = sessions.find((session) => session.sessionId === sessionId)?.agentIdentity;
		return identity === undefined ? shortId : `${identity} (${shortId})`;
	}

	function showDriveError(view: DriveView, text: string | undefined): void {
		if (text === undefined) {
			view.error?.remove();
			view.error = undefined;
			return;
		}
		if (!view.error) {
			view.error = element(doc, "p", "note err");
			view.error.setAttribute("role", "status");
			view.row.append(view.error);
		}
		setText(view.error, text);
	}

	async function stopSession(sessionId: string, view: DriveView): Promise<void> {
		view.stop.disabled = true;
		showDriveError(view, undefined);
		const reply = (await runtime
			.sendMessage({ type: MSG.pwExtStop, sessionId })
			.catch(() => undefined)) as { ok?: unknown; error?: unknown } | undefined;
		if (destroyed) return;
		view.stop.disabled = false;
		const error = replyError(reply);
		if (error === undefined) stopped.add(sessionId);
		showDriveError(view, error);
		await readAgents();
	}

	function createDriveView(sessionId: string): DriveView {
		const row = element(doc, "div", "drive");
		const name = element(doc, "b");
		const tabs = element(doc, "div", "mono tabs");
		const identity = element(doc, "div", "grow");
		identity.append(name, tabs);
		const line = element(doc, "div", "row");
		const view: DriveView = {
			row,
			name,
			tabs,
			stop: button(doc, "btn btn-sm btn-danger", "Stop", () => {
				void stopSession(sessionId, view);
			}),
		};
		line.append(identity, view.stop);
		row.append(line);
		return view;
	}

	function updateDriveView(view: DriveView, sessionId: string, count: number): void {
		const label = driveLabel(sessionId);
		setText(view.name, label);
		view.stop.setAttribute("aria-label", `Stop ${label}`);
		const isStopped = count === 0;
		setText(view.tabs, isStopped ? "" : `${count} tab${count === 1 ? "" : "s"}`);
		view.tabs.hidden = isStopped;
		if (!isStopped) {
			view.status?.replaceWith(view.stop);
			view.status = undefined;
			return;
		}
		if (!view.status) {
			view.status = element(doc, "span", "pill", "Stopped");
			view.status.setAttribute("role", "status");
			view.stop.replaceWith(view.status);
		}
	}

	function showDriving(): void {
		const counts = new Map<string, number>();
		for (const [sessionId, group] of groups) {
			if (group.tabs.length === 0) continue;
			counts.set(sessionId, group.tabs.length);
			stopped.delete(sessionId);
		}
		for (const sessionId of stopped) counts.set(sessionId, 0);
		for (const [sessionId, view] of driveViews) {
			if (counts.has(sessionId)) continue;
			view.row.remove();
			driveViews.delete(sessionId);
		}
		[...counts].forEach(([sessionId, count], index) => {
			let view = driveViews.get(sessionId);
			if (!view) {
				view = createDriveView(sessionId);
				driveViews.set(sessionId, view);
			}
			updateDriveView(view, sessionId, count);
			if (drivingList.children[index] !== view.row)
				drivingList.insertBefore(view.row, drivingList.children[index] ?? null);
		});
		if (counts.size === 0) driving.remove();
		else if (!driving.isConnected) header.after(driving);
		showWebMcp();
	}

	async function revokeWebMcp(message: { type: string; grant?: WebMcpGrantView }): Promise<void> {
		const reply = (await runtime.sendMessage(message).catch(() => undefined)) as
			| { ok?: unknown; error?: unknown }
			| undefined;
		if (destroyed) return;
		const error = replyError(reply);
		webmcpError.hidden = error === undefined;
		setText(webmcpError, error ?? "");
		await readAgents();
	}

	function webMcpRow(grant: WebMcpGrantView): HTMLElement {
		return webMcpGrantRow(doc, grant, {
			sessionLabel: driveLabel,
			onRevoke: (picked) => revokeWebMcp({ type: MSG.webmcpRevoke, grant: picked }),
		});
	}

	function showWebMcp(): void {
		const shown = JSON.stringify([webmcpGrants, sessions.map((session) => [session.sessionId, session.agentIdentity])]);
		if (shown !== webmcpShown) {
			webmcpShown = shown;
			webmcpList.replaceChildren(...webmcpGrants.map(webMcpRow));
		}
		if (webmcpGrants.length === 0) webmcp.remove();
		else if (!webmcp.isConnected) (driving.isConnected ? driving : header).after(webmcp);
	}

	async function unpair(view: CardView): Promise<void> {
		view.unpair.disabled = true;
		const reply = (await runtime
			.sendMessage({
				type: MSG.sessionDisconnect,
				sessionId: view.session.sessionId,
			})
			.catch(() => undefined)) as { ok?: unknown } | undefined;
		if (destroyed) return;
		showCardError(
			view,
			reply?.ok === true ? undefined : "Could not unpair this agent. Try again.",
		);
		view.unpair.disabled = false;
		await readAgents();
	}

	function replyError(
		reply: { ok?: unknown; error?: unknown } | undefined,
	): string | undefined {
		if (reply?.ok === true) return undefined;
		return typeof reply?.error === "string" ? reply.error : BACKGROUND_UNREACHABLE;
	}

	async function openChat(view: CardView): Promise<void> {
		const reply = (await runtime
			.sendMessage({ type: MSG.openChat, sessionId: view.session.sessionId })
			.catch(() => undefined)) as { ok?: unknown; error?: unknown } | undefined;
		if (destroyed) return;
		showCardError(view, replyError(reply));
	}

	async function adoptTab(view: CardView, tabId: number): Promise<void> {
		adopting += 1;
		const reply = (await runtime
			.sendMessage({
				type: MSG.agentTabAdopt,
				sessionId: view.session.sessionId,
				agentIdentity: view.session.agentIdentity,
				tabId,
			})
			.catch(() => undefined)) as { ok?: unknown; error?: unknown } | undefined;
		adopting -= 1;
		if (destroyed) return;
		showCardError(view, replyError(reply));
		await readAgents();
	}

	function adoptState(
		session: PairingSession,
		tab: { id?: number; url?: string; incognito?: boolean } | undefined,
	): { label: string; tabId?: number; reason?: string } {
		const tabId = tab?.id;
		if (tabId === undefined) return { label: ADD_TAB, reason: NO_ACTIVE_TAB };
		if (tab?.incognito) return { label: ADD_TAB, reason: PRIVATE_TAB_ERROR };
		if (!allowedPage(tab?.url) || mailbox(tab?.url))
			return { label: ADD_TAB, reason: BLOCKED_TAB_ERROR };
		const holds = (sessionId: string) =>
			groups.get(sessionId)?.tabs.some((other) => other.tabId === tabId);
		if (holds(session.sessionId)) return { label: SELECT_TAB, tabId };
		const owner = sessions.find(
			(other) => other.sessionId !== session.sessionId && holds(other.sessionId),
		);
		return owner && owner.runs.length > 0
			? { label: ADD_TAB, reason: `${owner.agentIdentity} is using this tab` }
			: { label: ADD_TAB, tabId };
	}

	function adoptItem(view: CardView): HTMLButtonElement {
		let target: number | undefined;
		const item = menuItem(ADD_TAB, () => {
			if (target !== undefined) void adoptTab(view, target);
		});
		item.setAttribute("aria-disabled", "true");
		void queryActiveTab()
			.catch(() => [])
			.then(([tab]) => {
				if (destroyed) return;
				const { label, reason, tabId } = adoptState(view.session, tab);
				target = tabId;
				if (tabId === undefined) item.setAttribute("aria-disabled", "true");
				else item.removeAttribute("aria-disabled");
				item.replaceChildren(
					...(reason ? [label, " ", element(doc, "span", "why", reason)] : [label]),
				);
				if (reason) item.setAttribute("title", reason);
			});
		return item;
	}

	function createCard(session: PairingSession): CardView {
		const wrapper = element(doc, "div", "agent");
		const card = element(doc, "div", "ag");
		const name = element(doc, "b");
		const shortId = element(doc, "div", "mono");
		const swatch = element(doc, "span", "swatch");
		swatch.setAttribute("aria-hidden", "true");
		const colorName = element(doc, "span", "sr");
		const identity = element(doc, "div", "grow");
		identity.append(name, colorName, shortId);
		const pill = element(doc, "span", "pill");
		const menuAnchor = element(doc, "div", "menu-host");
		const row = element(doc, "div", "row");
		const view: CardView = {
			session,
			wrapper,
			card,
			name,
			shortId,
			swatch,
			colorName,
			pill,
			menu: menuTrigger(`Menu for ${session.agentIdentity}`, menuAnchor, () => [
				menuItem("Open chat", () => void openChat(view)),
				adoptItem(view),
			]),
			unpair: button(doc, "btn btn-sm btn-danger", "Unpair", () => {
				void unpair(view);
			}),
		};
		menuAnchor.append(view.menu);
		row.append(swatch, identity, pill, menuAnchor, view.unpair);
		card.append(row);
		wrapper.append(card);
		return view;
	}

	function updateCard(view: CardView, session: PairingSession): void {
		view.session = session;
		setText(view.name, session.agentIdentity);
		setText(view.shortId, session.sessionId.slice(0, 8));
		const { label, variant } = pillFor(session);
		view.pill.className = variant ? `pill ${variant}` : "pill";
		setText(view.pill, label);
		view.menu.setAttribute("aria-label", `Menu for ${session.agentIdentity}`);
		view.unpair.setAttribute("aria-label", `Unpair ${session.agentIdentity}`);
		const group = groups.get(session.sessionId);
		view.swatch.hidden = group === undefined;
		if (group) {
			view.swatch.className = `swatch ${GROUP_SWATCH[group.color]}`;
			setText(view.colorName, `, ${group.color} group`);
		} else {
			setText(view.colorName, "");
		}
		const rows = [
			...renderTabItems(group?.tabs ?? [], doc),
			...renderAgentItems(session, { doc, now }),
		];
		view.card.classList.toggle("nokids", rows.length === 0);
		if (rows.length === 0) {
			view.tree?.remove();
			view.tree = undefined;
			return;
		}
		if (!view.tree) {
			view.tree = element(doc, "ul", "tree");
			view.wrapper.append(view.tree);
		}
		view.tree.setAttribute("aria-label", `Items for ${session.agentIdentity}`);
		view.tree.replaceChildren(...rows);
	}

	function createPaired(): PairedView {
		const section = element(doc, "div", "paired");
		const count = element(doc, "div", "cnt");
		const list = element(doc, "div", "agents");
		section.append(count, list);
		const view: PairedView = {
			section,
			count,
			list,
			cards: new Map(),
		};
		return view;
	}

	function showBanner(view: PairedView, visible: boolean): void {
		if (!visible) {
			view.banner?.remove();
			view.banner = undefined;
			return;
		}
		if (view.banner) return;
		const banner = element(doc, "p", "note");
		banner.setAttribute("role", "status");
		banner.append(
			element(doc, "span", "", DAEMON_DOWN),
			doc.createTextNode(" "),
			button(doc, "link", "Retry", () => {
				void runtime
					.sendMessage({ type: MSG.connectionRetry })
					.catch(() => undefined)
					.then(() => readAgents());
			}),
		);
		view.count.after(banner);
		view.banner = banner;
	}

	function showPaired(sessions: PairingSession[], daemonDown: boolean): void {
		if (!paired) {
			changed = undefined;
			empty = undefined;
			paired = createPaired();
			body.replaceChildren(paired.section);
			setText(sub, "pairing");
		}
		const view = paired;
		setText(
			view.count,
			`${sessions.length} agent${sessions.length === 1 ? "" : "s"} connected to this browser`,
		);
		showBanner(view, daemonDown);
		const wanted = new Set(sessions.map((session) => session.sessionId));
		for (const [id, card] of view.cards) {
			if (wanted.has(id)) continue;
			if (openMenu && card.wrapper.contains(openMenu.panel)) closeMenu(false);
			card.wrapper.remove();
			view.cards.delete(id);
		}
		sessions.forEach((session, index) => {
			let card = view.cards.get(session.sessionId);
			if (!card) {
				card = createCard(session);
				view.cards.set(session.sessionId, card);
			}
			updateCard(card, session);
			if (view.list.children[index] !== card.wrapper) {
				view.list.insertBefore(card.wrapper, view.list.children[index] ?? null);
			}
		});
	}

	async function trustDaemon(error: HTMLElement, trust: HTMLButtonElement): Promise<void> {
		trust.disabled = true;
		const reply = (await runtime
			.sendMessage({ type: MSG.trustDaemon })
			.catch(() => undefined)) as { ok?: unknown; error?: unknown } | undefined;
		if (destroyed) return;
		setText(error, replyError(reply) ?? "");
		trust.disabled = false;
		await readAgents();
	}

	function showDaemonChanged(): void {
		if (changed) return;
		empty = undefined;
		if (paired) {
			if (openMenu && paired.section.contains(openMenu.panel)) closeMenu(false);
			paired = undefined;
		}
		const section = element(doc, "div", "changed");
		const error = element(doc, "p", "note err");
		error.setAttribute("role", "status");
		const trust = button(doc, "btn", "Trust this daemon", () => {
			void trustDaemon(error, trust);
		});
		section.append(
			element(doc, "h2", "", DAEMON_CHANGED),
			element(doc, "p", "", DAEMON_CHANGED_HELP),
			trust,
			error,
		);
		changed = section;
		body.replaceChildren(section);
		setText(sub, "daemon changed");
	}

	function showEmpty(daemonReachable: boolean): void {
		changed = undefined;
		if (empty?.reachable === daemonReachable) return;
		if (paired) {
			if (openMenu && paired.section.contains(openMenu.panel)) closeMenu(false);
			paired = undefined;
		}
		const section = element(doc, "div", "empty");
		const note = element(doc, "p", "note");
		note.setAttribute("role", "status");
		if (daemonReachable) {
			note.append("Start an agent with ", element(doc, "code", "", "dg-agent start"), ".");
		} else {
			note.textContent = DAEMON_DOWN;
		}
		section.append(note);
		empty = { reachable: daemonReachable };
		body.replaceChildren(section);
		setText(sub, daemonReachable ? "no agents" : "daemon down");
	}

	function tick(): void {
		if (destroyed || doc.hidden || adopting > 0 || ticking) return;
		ticking = true;
		void readAgents().finally(() => {
			ticking = false;
		});
	}

	function onRuntimeMessage(message: unknown): void {
		if ((message as { type?: unknown } | null)?.type === MSG.connection) {
			void readAgents();
		}
	}

	function onKeyDown(event: KeyboardEvent): void {
		if (event.key === "Escape") closeMenu(true);
	}

	function onPointerDown(event: Event): void {
		if (!openMenu) return;
		const target = event.target as Node | null;
		if (
			target &&
			(openMenu.panel.contains(target) || openMenu.trigger.contains(target))
		)
			return;
		closeMenu(false);
	}

	runtime.onMessage.addListener(onRuntimeMessage);
	doc.addEventListener("keydown", onKeyDown);
	doc.addEventListener("pointerdown", onPointerDown);
	const timer = setInterval(tick, TICK_MS);

	return {
		ready: readAgents(),
		destroy() {
			destroyed = true;
			clearInterval(timer);
			runtime.onMessage.removeListener(onRuntimeMessage);
			doc.removeEventListener("keydown", onKeyDown);
			doc.removeEventListener("pointerdown", onPointerDown);
		},
	};
}
