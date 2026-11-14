import { describe, expect, it } from "bun:test";
import { mailbox } from "@/lib/background/tab-guards";

describe("mailbox", () => {
	it.each([
		["https://mail.proton.me/u/0/inbox", true],
		["https://outlook.live.com/mail/0/", false],
		["https://outlook.office.com/mail/", false],
		["https://outlook.office365.com/mail/", false],
		["https://outlook.cloud.microsoft/mail/", false],
		["https://app.example.test/", false],
		["not a url", false],
		[undefined, false],
	])("gives %p the answer %p", (url, expected) => {
		expect(mailbox(url)).toBe(expected);
	});
});
