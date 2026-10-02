import { describe, expect, test } from "bun:test";
import { packetForMessage } from "../src/classifier/packets";
import { hashId } from "../src/privacy/hash";
import type {
	ProtonFolder,
	ProtonMessageSummary,
} from "../src/protonmail/types";

const folders: ProtonFolder[] = [
	{ id: "inbox", name: "Inbox", type: "system" },
	{ id: "receipts", name: "Receipts", type: "folder" },
];

describe("privacy redaction", () => {
	test("hashes ids consistently", () => {
		expect(hashId("message-1")).toBe(hashId("message-1"));
		expect(hashId("message-1")).not.toBe(hashId("message-2"));
	});

	test("redacts packet text before classifier export", () => {
		const message: ProtonMessageSummary = {
			id: "message-1",
			from: "Jane Person <jane@example.com>",
			subject: "Receipt for account 123456789",
			snippet: "Call me at 555-111-2222 or jane@example.com",
			folderId: "inbox",
			folderName: "Inbox",
		};

		const packet = packetForMessage(message, folders, 160);
		const serialized = JSON.stringify(packet);
		expect(serialized).not.toContain("jane@example.com");
		expect(serialized).not.toContain("555-111-2222");
		expect(serialized).not.toContain("123456789");
		expect(packet.fromDomain).toBe("example.com");
	});
});
