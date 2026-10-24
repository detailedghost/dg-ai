import { describe, expect, it } from "bun:test";
import {
	ANNOUNCE_FIRST_INSTRUCTION,
	type ConnectSocket,
	nextOnMessageRetryDelayMs,
	onMessagePayload,
	PHONE_SAFETY_REF,
	pushFrame,
	sendSessionPush,
	type SessionPushTarget,
	type SocketLike,
	sessionPushTarget,
} from "../../src/phone/push";

function fakeSocket(behavior: "ok" | "connect-error" | "write-throws"): {
	connect: ConnectSocket;
	written: string[];
} {
	const written: string[] = [];
	const connect: ConnectSocket = () => {
		const handlers: Record<string, ((...args: unknown[]) => void)[]> = {
			connect: [],
			error: [],
			close: [],
		};
		const fire = (event: string, ...args: unknown[]) => {
			for (const listener of handlers[event] ?? []) listener(...args);
		};
		const socket: SocketLike = {
			on: (event, listener) => {
				(handlers[event] ??= []).push(listener);
			},
			write: (data) => {
				if (behavior === "write-throws") throw new Error("write failed");
				written.push(data);
			},
			end: (data) => {
				if (data !== undefined) written.push(data);
				queueMicrotask(() => fire("close"));
			},
			destroy: () => {},
		};
		queueMicrotask(() => {
			if (behavior === "connect-error") fire("error", new Error("ENOENT"));
			else fire("connect");
		});
		return socket;
	};
	return { connect, written };
}

describe("sessionPushTarget", () => {
	it("reads the socket and token Claude Code exports for this session", () => {
		const target = sessionPushTarget({
			CLAUDE_CODE_MESSAGING_SOCKET: "/run/user/1000/cc-socks/1.sock",
			CLAUDE_CODE_MESSAGING_TOKEN: "abc123",
		});

		expect(target).toEqual({ kind: "session", socket: "/run/user/1000/cc-socks/1.sock", token: "abc123" });
	});

	it("is undefined with no messaging socket, such as a --bare session", () => {
		expect(sessionPushTarget({})).toBeUndefined();
	});

	it("omits the token field when Claude Code did not export one", () => {
		expect(sessionPushTarget({ CLAUDE_CODE_MESSAGING_SOCKET: "/s.sock" })).toEqual({
			kind: "session",
			socket: "/s.sock",
		});
	});
});

describe("pushFrame", () => {
	it("tells the receiving agent to announce the sender before acting, and cites the safety file", () => {
		const frame = pushFrame("peer", "hello there");

		expect(frame).toContain(ANNOUNCE_FIRST_INSTRUCTION);
		expect(frame).toContain(PHONE_SAFETY_REF);
		expect(frame.startsWith("phone: new message from +peer")).toBe(true);
		expect(frame.endsWith("hello there")).toBe(true);
	});

	it("announces a number-card acceptance on its first line when call is set", () => {
		const frame = pushFrame("peer", "hello there", true);

		expect(frame.startsWith("phone: new contact +peer accepted your number card")).toBe(true);
		expect(frame.endsWith("hello there")).toBe(true);
	});
});

describe("onMessagePayload", () => {
	it("carries id, ts, from, handle, and text as JSON for --on-message's stdin", () => {
		const payload = onMessagePayload({ id: "m1", ts: 100, from: "npub1them", text: "hi" }, "+line");

		expect(JSON.parse(payload)).toEqual({ id: "m1", ts: 100, from: "npub1them", handle: "+line", text: "hi" });
	});

	it("includes call only when the message carries it", () => {
		const payload = onMessagePayload({ id: "m2", ts: 200, from: "npub1them", text: "hi", call: true }, "+line");

		expect(JSON.parse(payload)).toEqual({
			id: "m2",
			ts: 200,
			from: "npub1them",
			handle: "+line",
			text: "hi",
			call: true,
		});
	});
});

describe("nextOnMessageRetryDelayMs", () => {
	it("grows with each attempt and caps at the last configured delay", () => {
		const first = nextOnMessageRetryDelayMs(0);
		const second = nextOnMessageRetryDelayMs(1);
		const capped = nextOnMessageRetryDelayMs(1000);

		expect(second).toBeGreaterThan(first);
		expect(capped).toBe(nextOnMessageRetryDelayMs(3));
	});
});

describe("sendSessionPush", () => {
	const target: SessionPushTarget = { kind: "session", socket: "/fake.sock", token: "tok" };

	it("writes an auth line with the session token, then the frame with a trailing newline, and resolves on close", async () => {
		const { connect, written } = fakeSocket("ok");

		await sendSessionPush(target, "the frame text", connect);

		expect(JSON.parse(written[0])).toEqual({ type: "auth", token: "tok" });
		expect(written[1]).toBe("the frame text\n");
	});

	it("omits the auth line when the target carries no token", async () => {
		const { connect, written } = fakeSocket("ok");

		await sendSessionPush({ kind: "session", socket: "/fake.sock" }, "frame", connect);

		expect(written).toEqual(["frame\n"]);
	});

	it("rejects when the socket is gone, so the caller can fall back to voicemail", async () => {
		const { connect } = fakeSocket("connect-error");

		await expect(sendSessionPush(target, "frame", connect)).rejects.toThrow();
	});

	it("rejects when writing to the socket throws", async () => {
		const { connect } = fakeSocket("write-throws");

		await expect(sendSessionPush(target, "frame", connect)).rejects.toThrow();
	});
});
