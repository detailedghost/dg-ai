import { describe, expect, it } from "bun:test";
import {
	ANNOUNCE_FIRST_INSTRUCTION,
	DEFAULT_ON_MESSAGE_TIMEOUT_SECONDS,
	nextOnMessageRetryDelayMs,
	onMessagePayload,
	parseOnMessageTimeoutSeconds,
	PHONE_SAFETY_REF,
	pushFrame,
} from "../../src/phone/push";

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
		const payload = onMessagePayload({ id: "m1", ts: 100, from: "npub1them", text: "hi" }, "line");

		expect(JSON.parse(payload)).toEqual({ id: "m1", ts: 100, from: "npub1them", handle: "+line", text: "hi" });
	});

	it("includes call only when the message carries it", () => {
		const payload = onMessagePayload({ id: "m2", ts: 200, from: "npub1them", text: "hi", call: true }, "line");

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

describe("parseOnMessageTimeoutSeconds", () => {
	it("defaults when no value is given and passes through a valid one", () => {
		expect(parseOnMessageTimeoutSeconds(undefined)).toBe(DEFAULT_ON_MESSAGE_TIMEOUT_SECONDS);
		expect(parseOnMessageTimeoutSeconds("45")).toBe(45);
	});

	it("rejects a non-positive or non-numeric value", () => {
		expect(() => parseOnMessageTimeoutSeconds("0")).toThrow('--on-message-timeout must be a positive number of seconds, got "0"');
		expect(() => parseOnMessageTimeoutSeconds("nope")).toThrow(
			'--on-message-timeout must be a positive number of seconds, got "nope"',
		);
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
