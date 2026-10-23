import { describe, expect, test } from "bun:test";
import { packetForMessage } from "../src/classifier/packets";
import { hashId } from "../src/privacy/hash";
import { assertNoEmailAddress, redactBodyText } from "../src/privacy/redact";
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

	test("redactBodyText keeps newlines and digits while redacting addresses and phone numbers", () => {
		const body = [
			"Hi Jane,",
			"",
			"Call me at 555-111-2222 or reply to jane@example.com.",
			"Order 123456789 shipped.",
		].join("\n");

		const { text, truncated } = redactBodyText(body, 8000);

		expect(text).toContain("\n");
		expect(text).toContain("123456789");
		expect(text).not.toContain("jane@example.com");
		expect(text).not.toContain("555-111-2222");
		expect(truncated).toBe(false);
	});

	test("redactBodyText truncates to maxChars and reports truncated:true", () => {
		const body = "x".repeat(20);
		const { text, truncated } = redactBodyText(body, 10);
		expect(text).toBe("x".repeat(10));
		expect(truncated).toBe(true);
	});

	test.each([
		"Contact Jane Person <jane@example.com> for details.",
		"Reach out via mailto:jane@example.com please.",
		"Billing at BILLING@EXAMPLE.COM is the right address.",
	])("redactBodyText output passes assertNoEmailAddress for %p", (body) => {
		const { text } = redactBodyText(body, 8000);
		expect(() => assertNoEmailAddress(text)).not.toThrow();
	});
});
