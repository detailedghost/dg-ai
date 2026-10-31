import { describe, expect, it } from "bun:test";
import type { MessageRow } from "../../src/phone/db";
import { selectInbox } from "../../src/phone/inbox";

function row(overrides: Partial<MessageRow>): MessageRow {
	return {
		id: "id",
		direction: "in",
		ts: 1,
		sender: "npub1mary",
		contact: "npub1mary",
		text: "hi",
		call: 0,
		read_at: null,
		attempts: 0,
		...overrides,
	};
}

describe("selectInbox", () => {
	it("keeps both directions and both read states, newest limited, oldest first", () => {
		const rows = [
			row({ id: "new", ts: 3, direction: "out", read_at: 9 }),
			row({ id: "mid", ts: 2, direction: "in" }),
			row({ id: "old", ts: 1, direction: "in", read_at: 4 }),
		];

		expect(selectInbox(rows, 2).map((item) => item.id)).toEqual(["mid", "new"]);
	});

	it("matches the npub on sender or contact, and the accept or new-contact notice, and nothing else", () => {
		const peer = { npub: "npub1mary", handle: "maria" };
		const rows = [
			row({ id: "by-sender", contact: "default", sender: "npub1mary" }),
			row({ id: "by-contact", contact: "npub1mary", sender: "npub1us" }),
			row({ id: "old-handle", contact: "mary", sender: "npub1mary" }),
			row({ id: "accepted", sender: "phone", contact: "phone", text: "accepted +maria" }),
			row({ id: "introduced", sender: "phone", contact: "phone", text: "new contact +maria" }),
			row({ id: "other-notice", sender: "phone", contact: "phone", text: "accepted +other" }),
			row({ id: "forged", sender: "npub1other", contact: "npub1other", text: "accepted +maria" }),
			row({ id: "other", sender: "npub1other", contact: "default", text: "nope" }),
			row({ id: "weird", direction: "side" as MessageRow["direction"], sender: "npub1mary", contact: "npub1mary" }),
		];

		expect(selectInbox(rows, 20, peer).map((item) => item.id)).toEqual([
			"introduced",
			"accepted",
			"old-handle",
			"by-contact",
			"by-sender",
		]);
	});
});