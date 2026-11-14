import { describe, expect, it } from "bun:test";
import { mailbox, PW_EXT_MAILBOX_ERROR } from "@/lib/background/tab-guards";

describe("mailbox", () => {
	it.each([
		["https://mail.proton.me/u/0/inbox", true],
		["https://outlook.live.com/mail/0/", true],
		["https://outlook.office.com/mail/", true],
		["https://outlook.office365.com/mail/", true],
		["https://outlook.cloud.microsoft/mail/", true],
		["https://outlook.com/", false],
		["https://outlook.live.com.evil.example/mail/", false],
		["https://app.example.test/", false],
		["not a url", false],
		[undefined, false],
	])("gives %p the answer %p", (url, expected) => {
		expect(mailbox(url)).toBe(expected);
	});
});

describe("PW_EXT_MAILBOX_ERROR", () => {
	it("names both mailboxes and where each one is handled", () => {
		expect(PW_EXT_MAILBOX_ERROR).toBe(
			"pw --ext does not read or change a signed-in mailbox tab. Proton Mail: use dg-skills inbox. Outlook: use its dg_ tools (pw --ext tools).",
		);
	});
});
