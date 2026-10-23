import { describe, expect, test } from "bun:test";
import { stripQuotedHistory } from "../quote-strip";

describe("stripQuotedHistory", () => {
	test("leaves a message with no quote markers unchanged and reports removed:false", () => {
		const text = "Thanks for the update.\n\nSee you Friday.";
		expect(stripQuotedHistory(text)).toEqual({ text, removed: false });
	});

	test("cuts at a single-line 'On ... wrote:' marker", () => {
		const text = [
			"Sounds good to me.",
			"",
			"On Mon, Jan 5, 2026 at 10:00 AM Jane Person <jane@example.test> wrote:",
			"> Original question here.",
		].join("\n");
		expect(stripQuotedHistory(text)).toEqual({
			text: "Sounds good to me.",
			removed: true,
		});
	});

	test("joins up to two wrapped lines before matching the 'wrote:' marker", () => {
		const text = [
			"Confirmed.",
			"",
			"On Mon, Jan 5, 2026 at 10:00 AM Jane Person",
			"<jane@example.test>",
			"wrote:",
			"> Quoted body.",
		].join("\n");
		expect(stripQuotedHistory(text)).toEqual({
			text: "Confirmed.",
			removed: true,
		});
	});

	test("cuts at an Outlook-style 'Original Message' separator", () => {
		const text = [
			"Approved.",
			"-----Original Message-----",
			"From: Jane Person <jane@example.test>",
			"Sent: Monday, January 5, 2026 10:00 AM",
			"To: Billing <billing@example.test>",
		].join("\n");
		expect(stripQuotedHistory(text)).toEqual({ text: "Approved.", removed: true });
	});

	test("cuts at a long underscore separator", () => {
		const text = ["Noted.", "__________________________________"].join("\n");
		expect(stripQuotedHistory(text)).toEqual({ text: "Noted.", removed: true });
	});

	test("cuts at a From: header followed by a Sent/To/Date header within three lines", () => {
		const text = [
			"See below.",
			"From: Jane Person <jane@example.test>",
			"Subject: Receipt",
			"Sent: Monday, January 5, 2026 10:00 AM",
			"Hello,",
		].join("\n");
		expect(stripQuotedHistory(text)).toEqual({ text: "See below.", removed: true });
	});

	test("does not cut a bare From: line with no header within three lines", () => {
		const text = ["From: a place far away, greetings."].join("\n");
		expect(stripQuotedHistory(text)).toEqual({ text, removed: false });
	});

	test("drops a trailing block of lines that start with '>' with no marker present", () => {
		const text = ["My reply.", "> their first line", "> their second line"].join("\n");
		expect(stripQuotedHistory(text)).toEqual({ text: "My reply.", removed: true });
	});

	test("trims trailing blank lines after a cut", () => {
		const text = [
			"Reply text.",
			"",
			"",
			"On Mon, Jan 5, 2026 at 10:00 AM wrote:",
			"quoted",
		].join("\n");
		expect(stripQuotedHistory(text)).toEqual({ text: "Reply text.", removed: true });
	});
});
