import { describe, expect, it } from "bun:test";
import {
	CHAT_FRAME_RULES,
	PAGE_CHAT_FRAME_RULES,
	PW_EXT_WIRE,
	relayFrameTypes,
	validateChatFrame,
	validatePageChatFrame,
} from "../src/index";

const PW_EXT_TYPES = new Set(relayFrameTypes([PW_EXT_WIRE], "all"));

const without = (types: Iterable<string>, removed: ReadonlySet<string>) =>
	[...types].filter((type) => !removed.has(type)).sort();

describe("page chat frame rules", () => {
	it("hold the full frame types minus exactly the pw-ext frame types", () => {
		expect(PW_EXT_TYPES.size).toBeGreaterThan(0);
		expect([...PAGE_CHAT_FRAME_RULES.frameTypes].sort()).toEqual(without(CHAT_FRAME_RULES.frameTypes, PW_EXT_TYPES));
		for (const type of PW_EXT_TYPES) expect(CHAT_FRAME_RULES.frameTypes.has(type)).toBe(true);
	});

	it("hold the full inbound types minus exactly the pw-ext frame types", () => {
		expect([...PAGE_CHAT_FRAME_RULES.inboundTypes].sort()).toEqual(
			without(CHAT_FRAME_RULES.inboundTypes, PW_EXT_TYPES),
		);
	});

	it("share each relay validator with the full rules and lack only the pw-ext ones", () => {
		expect([...PAGE_CHAT_FRAME_RULES.relayValidators.keys()].sort()).toEqual(
			without(CHAT_FRAME_RULES.relayValidators.keys(), PW_EXT_TYPES),
		);
		for (const [type, validate] of PAGE_CHAT_FRAME_RULES.relayValidators)
			expect(validate).toBe(CHAT_FRAME_RULES.relayValidators.get(type)!);
	});

	it("reject a frame type that neither validator knows", () => {
		const frame = { type: "not-a-real-type", sessionId: "s1", protocolVersion: 1 };
		expect(() => validatePageChatFrame(frame)).toThrow();
		expect(() => validateChatFrame(frame)).toThrow();
	});
});
