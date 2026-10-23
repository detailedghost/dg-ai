import { describe, expect, test } from "bun:test";
import { composeMimeMessage, parseMimeMessage } from "../mime";

const CRLF = "\r\n";

function mime(lines: string[]): string {
	return lines.join(CRLF);
}

describe("parseMimeMessage", () => {
	test("a multipart/alternative message yields the text/plain part", async () => {
		const source = mime([
			"From: Alice <alice@example.test>",
			"To: Bob <bob@example.test>",
			"Subject: Multipart test",
			'Content-Type: multipart/alternative; boundary="BOUND1"',
			"",
			"--BOUND1",
			"Content-Type: text/plain; charset=utf-8",
			"",
			"Plain body text.",
			"--BOUND1",
			"Content-Type: text/html; charset=utf-8",
			"",
			"<p>HTML body text.</p>",
			"--BOUND1--",
			"",
		]);
		const parsed = await parseMimeMessage(source);
		expect(parsed.text.trim()).toBe("Plain body text.");
		expect(parsed.from).toBe("Alice <alice@example.test>");
		expect(parsed.to).toEqual(["Bob <bob@example.test>"]);
	});

	test("an HTML-only message falls back to htmlToText output", async () => {
		const source = mime([
			"From: alice@example.test",
			"To: bob@example.test",
			"Subject: HTML only",
			"Content-Type: text/html; charset=utf-8",
			"",
			"<p>Only HTML <b>here</b>.</p>",
			"",
		]);
		const parsed = await parseMimeMessage(source);
		expect(parsed.text).not.toContain("<");
		expect(parsed.text).toContain("Only HTML here.");
	});

	test("two attachments and one inline image yield three entries with isInline set correctly", async () => {
		const source = mime([
			"From: alice@example.test",
			"To: bob@example.test",
			"Subject: Attachments",
			'Content-Type: multipart/mixed; boundary="OUTER"',
			"",
			"--OUTER",
			'Content-Type: multipart/related; boundary="INNER"',
			"",
			"--INNER",
			"Content-Type: text/plain; charset=utf-8",
			"",
			"Message with an inline image.",
			"--INNER",
			"Content-Type: image/png",
			"Content-Disposition: inline",
			"Content-ID: <img1@example.test>",
			"Content-Transfer-Encoding: base64",
			"",
			"iVBORw0KGgo=",
			"--INNER--",
			"--OUTER",
			"Content-Type: application/pdf",
			'Content-Disposition: attachment; filename="doc1.pdf"',
			"Content-Transfer-Encoding: base64",
			"",
			"JVBERi0xLjQK",
			"--OUTER",
			"Content-Type: text/plain",
			'Content-Disposition: attachment; filename="notes.txt"',
			"Content-Transfer-Encoding: base64",
			"",
			"aGVsbG8=",
			"--OUTER--",
			"",
		]);
		const parsed = await parseMimeMessage(source);
		expect(parsed.text.trim()).toBe("Message with an inline image.");
		expect(parsed.attachments).toHaveLength(3);
		const byName = new Map(parsed.attachments.map((attachment) => [attachment.name, attachment]));
		expect(byName.get("doc1.pdf")?.isInline).toBe(false);
		expect(byName.get("notes.txt")?.isInline).toBe(false);
		const inline = parsed.attachments.find((attachment) => attachment.isInline);
		expect(inline?.contentType).toBe("image/png");
	});

	test("carries messageId and references through for reply threading", async () => {
		const source = mime([
			"From: alice@example.test",
			"To: bob@example.test",
			"Subject: Threaded",
			"Message-ID: <original@example.test>",
			"References: <root@example.test>",
			"Content-Type: text/plain; charset=utf-8",
			"",
			"Body.",
			"",
		]);
		const parsed = await parseMimeMessage(source);
		expect(parsed.messageId).toBe("<original@example.test>");
		expect(parsed.references).toBe("<root@example.test>");
	});
});

describe("composeMimeMessage", () => {
	test("builds the headers a draft needs", async () => {
		const built = await composeMimeMessage({
			from: "me@example.test",
			to: ["dest@example.test"],
			cc: [],
			subject: "Draft subject",
			text: "Draft body.",
		});
		const text = built.toString("utf8");
		expect(text).toContain("From: me@example.test");
		expect(text).toContain("To: dest@example.test");
		expect(text).toContain("Subject: Draft subject");
		expect(text).toContain("Message-ID:");
		expect(text).toContain("Date:");
		expect(text).toContain("MIME-Version: 1.0");
		expect(text).toContain("Content-Type: text/plain; charset=utf-8");
		expect(text).toContain("Draft body.");
	});

	test("carries inReplyTo and references for a reply", async () => {
		const built = await composeMimeMessage({
			from: "me@example.test",
			to: ["dest@example.test"],
			cc: ["cc@example.test"],
			subject: "Re: Draft subject",
			text: "Reply body.",
			inReplyTo: "<original@example.test>",
			references: "<root@example.test> <original@example.test>",
		});
		const text = built.toString("utf8");
		expect(text).toContain("In-Reply-To: <original@example.test>");
		expect(text).toContain("References: <root@example.test> <original@example.test>");
		expect(text).toContain("Cc: cc@example.test");
	});
});
