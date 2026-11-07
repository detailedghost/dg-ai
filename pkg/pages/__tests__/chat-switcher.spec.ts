import { describe, expect, test } from "bun:test";
import {
	CHAT_PROTOCOL_VERSION,
	OVERWATCH_SESSION_ID,
	type SessionBootstrap,
} from "@dg/common";
import { presenceLabel } from "../src/chat/chat-node";
import { SESSION_ENDED_TEXT } from "../src/local";
import { click } from "./utils/dom-events";
import {
	bootChat,
	type FetchCall,
	installPage,
	type Net,
	pageFragment,
	settle,
} from "./utils/chat-page-harness";

const PORT = 47823;
const HELD_KEY = "dg_local_bootstraps";
const NOT_ATTACHED_TITLE = "Agent not attached";
const NOT_DELIVERED_TEXT =
	"The daemon did not confirm this message. Check that the agent is running.";
const EMPTY_STATE_TEXT =
	"Run dg-agent start --open to open this page for an agent.";
const ACK_TIMEOUT_MS = 5000;

function bootstrapOf(letter: string): SessionBootstrap {
	return {
		port: PORT,
		sessionId: `${letter.repeat(8)}-0000-4000-8000-000000000000`,
		token: `tok-${letter}`,
		agentIdentity: `claude-${letter}`,
	};
}

const A = bootstrapOf("a");
const B = bootstrapOf("b");
const C = bootstrapOf("c");

type Listed = {
	bootstrap: SessionBootstrap;
	presence?: string;
	role?: string;
};

function listed(
	bootstrap: SessionBootstrap,
	presence = "cli",
	role = "agent",
): Listed {
	return { bootstrap, presence, role };
}

function sessionList(...entries: Listed[]) {
	return {
		type: "session-list",
		sessionId: entries[0]?.bootstrap.sessionId ?? A.sessionId,
		sessions: entries.map(({ bootstrap, presence, role }) => ({
			sessionId: bootstrap.sessionId,
			agentIdentity: bootstrap.agentIdentity,
			role: role ?? "agent",
			...(presence === undefined ? {} : { presence }),
		})),
	};
}

function header(bootstrap: SessionBootstrap, presence: string): string {
	return `Talking to ${bootstrap.agentIdentity} · ${bootstrap.sessionId.slice(0, 8)} · ${presenceLabel(presence as never)}`;
}

function held(...bootstraps: SessionBootstrap[]): Record<string, string> {
	return { [HELD_KEY]: JSON.stringify(bootstraps) };
}

function chatHref(bootstrap?: SessionBootstrap): string {
	return `http://127.0.0.1:${PORT}/chat${bootstrap ? `#${pageFragment(bootstrap)}` : ""}`;
}

function attachBody(bootstrap: SessionBootstrap): Response {
	return Response.json({
		sessions: [
			{
				port: bootstrap.port,
				sessionId: bootstrap.sessionId,
				token: bootstrap.token,
				agentIdentity: bootstrap.agentIdentity,
			},
		],
	});
}

function attachCalls(net: Net): FetchCall[] {
	return net.fetches.filter((call) => call.url.endsWith("/attach"));
}

function bearerOf(call: FetchCall): string | null {
	return new Headers(call.init?.headers).get("authorization");
}

function bodyOf(call: FetchCall): unknown {
	return JSON.parse(String(call.init?.body));
}

function pageText(net: Net): string {
	return net.win.document.body.textContent ?? "";
}

function entry(net: Net, bootstrap: SessionBootstrap): HTMLElement | null {
	return net.win.document.querySelector(
		`.chat-rail [data-session-id="${bootstrap.sessionId}"]`,
	) as unknown as HTMLElement | null;
}

function requireEntry(net: Net, bootstrap: SessionBootstrap): HTMLElement {
	const found = entry(net, bootstrap);
	if (!found) throw new Error(`no switcher entry for ${bootstrap.sessionId}`);
	return found;
}

function isDisabled(element: HTMLElement): boolean {
	return (
		element.hasAttribute("disabled") ||
		element.getAttribute("aria-disabled") === "true"
	);
}

async function choose(net: Net, bootstrap: SessionBootstrap): Promise<void> {
	click(requireEntry(net, bootstrap));
	await settle();
}

function sentFrames(net: Net): Record<string, unknown>[] {
	return (net.sockets[0]?.sent ?? []).map((raw) => JSON.parse(raw));
}

async function openPage(
	href: string,
	options: Parameters<typeof installPage>[1] = {},
): Promise<Net> {
	const net = installPage(href, options);
	await bootChat(net);
	return net;
}

async function openConnected(
	net: Net,
	...entries: Listed[]
): Promise<void> {
	net.sockets[0]?.handle.fire("open");
	net.sockets[0]?.handle.receive(sessionList(...entries));
	await settle();
}

function userRows(net: Net): HTMLElement[] {
	return [
		...net.win.document.querySelectorAll(".chat-transcript__message--user"),
	] as unknown as HTMLElement[];
}

async function submit(net: Net, body: string): Promise<void> {
	const input = net.win.document.querySelector(
		".chat-composer__input",
	) as unknown as HTMLInputElement;
	input.value = body;
	input.dispatchEvent(
		new net.win.KeyboardEvent("keydown", { key: "Enter" }) as unknown as Event,
	);
	await settle();
}

describe("chat page session switcher listing", () => {
	test("lists every agent session with identity, short id and presence, held or not", async () => {
		const net = await openPage(chatHref(A), { sessionStorage: held(A) });

		await openConnected(net, listed(A), listed(B), listed(C, "idle"));

		for (const [bootstrap, presence] of [
			[A, "cli"],
			[B, "cli"],
			[C, "idle"],
		] as const) {
			const text = requireEntry(net, bootstrap).textContent ?? "";
			expect(text).toContain(bootstrap.agentIdentity);
			expect(text).toContain(bootstrap.sessionId.slice(0, 8));
			expect(text).toContain(presenceLabel(presence));
		}
	});

	test("hides the overwatch pseudo-session and non-agent roles", async () => {
		const overwatch = { ...A, sessionId: OVERWATCH_SESSION_ID };
		const orchestrator = bootstrapOf("d");
		const net = await openPage(chatHref(A), { sessionStorage: held(A) });

		await openConnected(
			net,
			listed(A),
			listed(overwatch),
			listed(orchestrator, "cli", "orchestrator"),
		);

		expect(entry(net, A)).not.toBeNull();
		expect(entry(net, overwatch)).toBeNull();
		expect(entry(net, orchestrator)).toBeNull();
	});

	test("renders an unheld entry whose presence is not cli disabled with the title, and keeps unheld cli selectable", async () => {
		const net = await openPage(chatHref(A), { sessionStorage: held(A) });

		await openConnected(
			net,
			listed(A),
			listed(B, "gone"),
			listed(C, "cli"),
		);

		const gone = requireEntry(net, B);
		expect(isDisabled(gone)).toBe(true);
		expect(gone.getAttribute("title")).toBe(NOT_ATTACHED_TITLE);
		expect(isDisabled(requireEntry(net, C))).toBe(false);
	});

	test("keeps a held entry selectable at any presence", async () => {
		const net = await openPage(chatHref(A), { sessionStorage: held(A) });

		await openConnected(net, listed(A, "gone"));

		expect(isDisabled(requireEntry(net, A))).toBe(false);
	});

	test("shows a new agent from the next session-list without a reload or a poll, and enables a disabled entry when it attaches", async () => {
		const net = await openPage(chatHref(A), { sessionStorage: held(A) });
		await openConnected(net, listed(A));
		expect(entry(net, B)).toBeNull();

		net.sockets[0]?.handle.receive(sessionList(listed(A), listed(B, "idle")));
		await settle();
		expect(isDisabled(requireEntry(net, B))).toBe(true);

		net.sockets[0]?.handle.receive(sessionList(listed(A), listed(B, "cli")));
		await settle();

		expect(isDisabled(requireEntry(net, B))).toBe(false);
		expect(
			net.fetches.filter((call) => !call.url.endsWith("/healthz")),
		).toHaveLength(0);
	});
});

describe("chat page header", () => {
	test("names the agent, the short session id and the presence label, and follows every session-list", async () => {
		const net = await openPage(chatHref(A), { sessionStorage: held(A) });

		await openConnected(net, listed(A, "cli"));
		expect(pageText(net)).toContain(header(A, "cli"));

		net.sockets[0]?.handle.receive(sessionList(listed(A, "gone")));
		await settle();

		expect(pageText(net)).toContain(header(A, "gone"));
		expect(pageText(net)).not.toContain(header(A, "cli"));
	});
});

describe("chat page switching", () => {
	test("selecting a held entry switches the thread without a request, a new socket or a new handshake", async () => {
		const net = await openPage(chatHref(B), { sessionStorage: held(A, B) });
		await openConnected(net, listed(A), listed(B));
		const handshakes = sentFrames(net).length;

		await choose(net, A);

		expect(pageText(net)).toContain(header(A, "cli"));
		expect(attachCalls(net)).toHaveLength(0);
		expect(net.sockets).toHaveLength(1);
		expect(sentFrames(net)).toHaveLength(handshakes);
	});

	test("selecting an unheld cli entry posts attach with the selected bearer, adopts the bootstrap on the open socket and selects it", async () => {
		const net = await openPage(chatHref(A), {
			sessionStorage: held(A),
			respond: () => Promise.resolve(attachBody(B)),
		});
		await openConnected(net, listed(A), listed(B));

		await choose(net, B);

		const [call] = attachCalls(net);
		expect(call?.init?.method).toBe("POST");
		expect(bearerOf(call as FetchCall)).toBe(`Bearer ${A.token}`);
		expect(bodyOf(call as FetchCall)).toEqual({
			intent: "attach",
			sessionId: B.sessionId,
		});
		const frames = sentFrames(net);
		for (const type of ["connect", "history-request"]) {
			expect(
				frames.filter((frame) => frame.type === type && frame.sessionId === B.sessionId),
			).toEqual([
				expect.objectContaining({ token: B.token, protocolVersion: CHAT_PROTOCOL_VERSION }),
			]);
		}
		expect(net.sockets).toHaveLength(1);
		expect(pageText(net)).toContain(header(B, "cli"));
		expect(pageText(net)).not.toContain(B.token);
	});

	test("a 404 on click shows an inline error on the rail and keeps the selection and the socket handshake untouched", async () => {
		const net = await openPage(chatHref(A), {
			sessionStorage: held(A),
			respond: () =>
				Promise.resolve(new Response("That session is not active.", { status: 404 })),
		});
		await openConnected(net, listed(A), listed(B));

		await choose(net, B);

		expect(net.win.document.querySelector(".chat-rail [role='alert']")).not.toBeNull();
		expect(pageText(net)).toContain(header(A, "cli"));
		expect(sentFrames(net).some((frame) => frame.sessionId === B.sessionId)).toBe(false);
	});

	test("with A closed and B held, switching to C uses B's bearer", async () => {
		const net = await openPage(chatHref(A), {
			sessionStorage: held(A, B),
			respond: () => Promise.resolve(attachBody(C)),
		});
		await openConnected(net, listed(A), listed(B), listed(C));
		net.sockets[0]?.handle.receive({ type: "session-closed", sessionId: A.sessionId });
		net.sockets[0]?.handle.receive(sessionList(listed(B), listed(C)));
		await settle();

		await choose(net, C);

		const [call] = attachCalls(net);
		expect(bearerOf(call as FetchCall)).toBe(`Bearer ${B.token}`);
		expect(pageText(net)).toContain(header(C, "cli"));
	});

	test("a refused bearer is retried once with the next held token", async () => {
		const respond = (call: FetchCall) =>
			Promise.resolve(
				bearerOf(call) === `Bearer ${A.token}`
					? new Response("refused", { status: 403 })
					: attachBody(C),
			);
		const net = await openPage(chatHref(A), { sessionStorage: held(A, B), respond });
		await openConnected(net, listed(A), listed(B), listed(C));

		await choose(net, C);

		expect(attachCalls(net).map(bearerOf)).toEqual([
			`Bearer ${A.token}`,
			`Bearer ${B.token}`,
		]);
		expect(pageText(net)).toContain(header(C, "cli"));
	});

	test("with no live token left the page shows the session ended text", async () => {
		const net = await openPage(chatHref(A), {
			sessionStorage: held(A),
			respond: () => Promise.resolve(new Response("refused", { status: 403 })),
		});
		await openConnected(net, listed(A), listed(B));

		await choose(net, B);

		expect(pageText(net)).toContain(SESSION_ENDED_TEXT);
		expect(sentFrames(net).some((frame) => frame.sessionId === B.sessionId)).toBe(false);
	});
});

describe("chat page held set", () => {
	test("a bare /chat shows the empty state, no switcher, no socket and not the session ended text", async () => {
		const net = await openPage(chatHref());

		expect(pageText(net)).toContain(EMPTY_STATE_TEXT);
		expect(pageText(net)).not.toContain(SESSION_ENDED_TEXT);
		expect(net.win.document.querySelector(".chat-rail [data-session-id]")).toBeNull();
		expect(net.sockets).toHaveLength(0);
	});

	test("a /chat#_chatcode= load in a tab that already holds a session holds both and starts the socket with both", async () => {
		const net = await openPage(chatHref(B), { sessionStorage: held(A) });

		net.sockets[0]?.handle.fire("open");
		await settle();

		expect(net.sockets).toHaveLength(1);
		const connects = sentFrames(net)
			.filter((frame) => frame.type === "connect")
			.map((frame) => frame.sessionId);
		expect(connects.sort()).toEqual([A.sessionId, B.sessionId].sort());
		expect(JSON.parse(net.win.sessionStorage.getItem(HELD_KEY) ?? "[]")).toEqual([A, B]);
	});

	test("a /chat#_chatcode= load after a bare /chat starts the socket", async () => {
		await openPage(chatHref());
		const net = await openPage(chatHref(A));

		net.sockets[0]?.handle.fire("open");
		await settle();

		expect(net.sockets).toHaveLength(1);
		expect(sentFrames(net).map((frame) => frame.type)).toContain("connect");
	});

	test("a session that closes while selected shows the session ended text, keeps the other entries and drops it from the stored array", async () => {
		const net = await openPage(chatHref(A), { sessionStorage: held(A, B) });
		await openConnected(net, listed(A), listed(B));
		await choose(net, A);

		net.sockets[0]?.handle.receive({ type: "session-closed", sessionId: A.sessionId });
		net.sockets[0]?.handle.receive(sessionList(listed(A, "gone"), listed(B)));
		await settle();

		expect(entry(net, A)?.textContent).toContain(SESSION_ENDED_TEXT);
		expect(entry(net, B)?.textContent).not.toContain(SESSION_ENDED_TEXT);
		expect(
			JSON.parse(net.win.sessionStorage.getItem(HELD_KEY) ?? "[]").map(
				(stored: SessionBootstrap) => stored.sessionId,
			),
		).toEqual([B.sessionId]);
	});
});

describe("chat page switching mid-flight", () => {
	async function sentInA() {
		const net = await openPage(chatHref(A), { sessionStorage: held(A, B) });
		await openConnected(net, listed(A), listed(B));
		await choose(net, A);
		await submit(net, "hello a");
		const written = sentFrames(net).find((frame) => frame.type === "user-message");
		await choose(net, B);
		return { net, messageId: written?.messageId as string };
	}

	test("an ack that arrives after switching clears A's row and leaves B's thread untouched", async () => {
		const { net, messageId } = await sentInA();
		expect(userRows(net)).toHaveLength(0);

		net.sockets[0]?.handle.receive({
			type: "ack",
			sessionId: A.sessionId,
			messageId,
		});
		await settle();
		expect(userRows(net)).toHaveLength(0);

		await choose(net, A);

		expect(userRows(net)).toHaveLength(1);
		expect(userRows(net)[0]?.dataset.delivery).toBe("delivered");
	});

	test("the ack timer that fires after switching marks A's row not delivered", async () => {
		const { net } = await sentInA();

		net.timeouts.find((timer) => timer.ms === ACK_TIMEOUT_MS)?.callback();
		await settle();
		expect(userRows(net)).toHaveLength(0);

		await choose(net, A);

		expect(userRows(net)[0]?.dataset.delivery).toBe("not-delivered");
		expect(userRows(net)[0]?.textContent).toContain(NOT_DELIVERED_TEXT);
	});

	test("selecting another session never aborts the send already written", async () => {
		const { net } = await sentInA();

		expect(
			sentFrames(net).filter((frame) => frame.type === "user-message"),
		).toHaveLength(1);
	});
});
