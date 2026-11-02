import { describe, expect, test } from "bun:test";
import { autoCommentChar, isAiCoauthor, stripAiCoauthors } from "../src/ai-coauthors";

const subject = "feat(scope): add thing";

describe("stripAiCoauthors", () => {
	test.each([
		["Claude", "Claude Sonnet 5.5 <noreply@anthropic.com>"],
		["Claude Opus", "Claude Opus 5.5 <noreply@anthropic.com>"],
		["Dependabot bot address", "Some Tool <49699333+dependabot[bot]@users.noreply.github.com>"],
		["Name only", "Claude"],
		["Codex", "Codex <noreply@openai.com>"],
		["Grok", "Grok <noreply@x.ai>"],
		["Copilot bot", "Copilot <175728472+Copilot@users.noreply.github.com>"],
		["Copilot agent bot", "copilot-swe-agent[bot] <198982749+Copilot@users.noreply.github.com>"],
		["Gemini", "Gemini <noreply@google.com>"],
		["GPT", "ChatGPT <noreply@openai.com>"],
		["Cursor agent", "Cursor Agent <cursoragent@cursor.com>"],
	])("removes the %s trailer and the blank line before it", (_name, who) => {
		expect(stripAiCoauthors(`${subject}\n\nBody.\n\nCo-Authored-By: ${who}\n`)).toBe(
			`${subject}\n\nBody.\n`,
		);
	});

	test("keeps a human co-author trailer", () => {
		const message = `${subject}\n\nCo-Authored-By: Sam Human <sam@example.com>\n`;
		expect(stripAiCoauthors(message)).toBe(message);
	});

	test("keeps human and other trailers around an AI trailer", () => {
		const message = [
			subject,
			"",
			"Body.",
			"",
			"Signed-off-by: Dev <dev@example.com>",
			"Co-Authored-By: Claude <noreply@anthropic.com>",
			"Co-authored-by: Sam Human <sam@example.com>",
			"Co-Authored-By: Codex <noreply@openai.com>",
			"Fixes: #12",
			"",
		].join("\n");
		expect(stripAiCoauthors(message)).toBe(
			[
				subject,
				"",
				"Body.",
				"",
				"Signed-off-by: Dev <dev@example.com>",
				"Co-authored-by: Sam Human <sam@example.com>",
				"Fixes: #12",
				"",
			].join("\n"),
		);
	});

	test("drops continuation lines with an AI trailer and keeps those of other trailers", () => {
		const message = [
			subject,
			"",
			"Co-Authored-By: Codex",
			" <noreply@openai.com>",
			"Reviewed-by: Sam",
			" <sam@example.com>",
			"",
		].join("\n");
		expect(stripAiCoauthors(message)).toBe(
			[subject, "", "Reviewed-by: Sam", " <sam@example.com>", ""].join("\n"),
		);
	});

	test("matches a trailer written without a space after the colon", () => {
		expect(
			stripAiCoauthors(
				`${subject}\n\nCo-Authored-By:Claude <noreply@anthropic.com>\nReviewed-by:Sam\n`,
			),
		).toBe(`${subject}\n\nReviewed-by:Sam\n`);
	});

	test("finds the trailer block above the verbose diff after the scissors line", () => {
		const verbose =
			"# ------------------------ >8 ------------------------\n# Do not modify or remove the line above.\ndiff --git a/a.txt b/a.txt\n+added line\n";
		expect(
			stripAiCoauthors(
				`${subject}\n\nBody.\n\nCo-Authored-By: Claude <noreply@anthropic.com>\n${verbose}`,
			),
		).toBe(`${subject}\n\nBody.\n${verbose}`);
	});

	test("strips from a message with CRLF line endings and keeps them", () => {
		expect(
			stripAiCoauthors(
				`${subject}\r\n\r\nBody.\r\n\r\nCo-Authored-By: Claude <noreply@anthropic.com>\r\nReviewed-by: Sam\r\n`,
			),
		).toBe(`${subject}\r\n\r\nBody.\r\n\r\nReviewed-by: Sam\r\n`);
	});

	test("finds the scissors line in a CRLF message", () => {
		const verbose = "# ------------------------ >8 ------------------------\r\ndiff --git a/x b/x\r\n";
		expect(
			stripAiCoauthors(
				`${subject}\r\n\r\nBody.\r\n\r\nCo-Authored-By: Claude <noreply@anthropic.com>\r\n${verbose}`,
			),
		).toBe(`${subject}\r\n\r\nBody.\r\n${verbose}`);
	});

	test("keeps a folded human trailer in a CRLF message", () => {
		const message = `${subject}\r\n\r\nCo-Authored-By: Claude\r\n Martin <claude.martin@gmail.com>\r\n`;
		expect(stripAiCoauthors(message)).toBe(message);
	});

	test("strips an AI trailer next to a BREAKING CHANGE footer and keeps the footer", () => {
		expect(
			stripAiCoauthors(
				`feat!: replace API\n\nBREAKING CHANGE: remove the old API\nCo-Authored-By: Claude <noreply@anthropic.com>\n`,
			),
		).toBe(`feat!: replace API\n\nBREAKING CHANGE: remove the old API\n`);
	});

	test("strips an AI trailer around a comment line and keeps the comment and human trailer", () => {
		expect(
			stripAiCoauthors(
				`${subject}\n\nCo-Authored-By: Claude <noreply@anthropic.com>\n# editor note\nCo-Authored-By: Sam <sam@example.com>\n`,
			),
		).toBe(`${subject}\n\n# editor note\nCo-Authored-By: Sam <sam@example.com>\n`);
	});

	test("keeps a folded human trailer split by a comment line", () => {
		const message = `${subject}\n\nCo-Authored-By: Claude\n# editor note\n Martin <claude.martin@gmail.com>\n`;
		expect(stripAiCoauthors(message)).toBe(message);
	});

	test("returns a message without trailers unchanged", () => {
		const message = `${subject}\n\nBody paragraph one.\n\nBody paragraph two.\n`;
		expect(stripAiCoauthors(message)).toBe(message);
	});

	test.each(["co-authored-by", "CO-AUTHORED-BY", "Co-Authored-By"])(
		"matches the %s key case-insensitively",
		(key) => {
			expect(
				stripAiCoauthors(`${subject}\n\n${key}: CLAUDE <noreply@ANTHROPIC.com>\n`),
			).toBe(`${subject}\n`);
		},
	);

	test("does not touch AI words in the subject or body", () => {
		const message = `${subject} with claude and copilot\n\nCo-Authored-By: Claude and Codex wrote this body line.\nMore text.\n`;
		expect(stripAiCoauthors(message)).toBe(message);
	});

	test("does not touch a trailer that sits in the subject paragraph", () => {
		const message = "Co-Authored-By: Claude <noreply@anthropic.com>\n";
		expect(stripAiCoauthors(message)).toBe(message);
	});

	test("keeps a message without a final newline free of one", () => {
		expect(
			stripAiCoauthors(`${subject}\n\nCo-Authored-By: Claude <noreply@anthropic.com>`),
		).toBe(subject);
	});

	test("keeps git comment lines after the message", () => {
		const comments = "# Please enter the commit message.\n#\n# On branch main\n";
		expect(
			stripAiCoauthors(
				`${subject}\n\nBody.\n\nCo-Authored-By: Claude <noreply@anthropic.com>\n\n${comments}`,
			),
		).toBe(`${subject}\n\nBody.\n\n${comments}`);
	});

	test("honors a custom comment character", () => {
		const comments = "; Please enter the commit message.\n; On branch main\n";
		expect(
			stripAiCoauthors(
				`${subject}\n\nCo-Authored-By: Claude <noreply@anthropic.com>\n\n${comments}`,
				";",
			),
		).toBe(`${subject}\n\n${comments}`);
	});

	test("keeps an empty message empty", () => {
		expect(stripAiCoauthors("")).toBe("");
	});
});

describe("isAiCoauthor", () => {
	test("flags AI identities and keeps human ones", () => {
		expect(isAiCoauthor("Claude <noreply@anthropic.com>")).toBe(true);
		expect(isAiCoauthor("Sam Human <sam@example.com>")).toBe(false);
		expect(isAiCoauthor("Claude Martin <claude.martin@gmail.com>")).toBe(false);
		expect(isAiCoauthor("Gemini Smith <gemini.smith@example.com>")).toBe(false);
		expect(isAiCoauthor("Claude Martin <noreply@example.com>")).toBe(true);
		expect(isAiCoauthor("Copilot <175728472+Copilot@users.noreply.github.com>")).toBe(true);
	});

	test("keeps a human whose name or email holds an AI word", () => {
		const message = `${subject}\n\nCo-Authored-By: Claude Martin <claude.martin@gmail.com>\n`;
		expect(stripAiCoauthors(message)).toBe(message);
	});
});

describe("autoCommentChar", () => {
	const template = (char: string) =>
		`${char} Bitte geben Sie eine Commit-Beschreibung ein.\n${char}\n${char} Auf Branch main\n`;

	test("picks # when no line starts with a candidate", () => {
		expect(autoCommentChar(`${subject}\n\nBody.\n`)).toBe("#");
	});

	test("picks # from a template in any language", () => {
		expect(autoCommentChar(`${subject}\n\nBody.\n\n${template("#")}`)).toBe("#");
	});

	test("picks ; when the message has a line starting with # and the template is not English", () => {
		const message = `${subject}\n\n# heading\n\nBody.\n\n${template(";")}`;
		expect(autoCommentChar(message)).toBe(";");
	});

	test("picks @ when the message uses # and ; and the template is not English", () => {
		const message = `${subject}\n\n# one\n; two\n\n${template("@")}`;
		expect(autoCommentChar(message)).toBe("@");
	});

	test("takes the character from a scissors line", () => {
		const scissors = `@ ${"-".repeat(24)} >8 ${"-".repeat(24)}`;
		const message = `${subject}\n\n# heading\n; note\n\n${scissors}\n@@ -1 +1 @@\n`;
		expect(autoCommentChar(message)).toBe("@");
	});

	test("stripAiCoauthors keeps a # body line when the comment character is ;", () => {
		const message = `${subject}\n\n# heading\n\nCo-Authored-By: Claude <noreply@anthropic.com>\n\n${template(";")}`;
		expect(stripAiCoauthors(message, autoCommentChar(message))).toBe(
			`${subject}\n\n# heading\n\n${template(";")}`,
		);
	});
});
