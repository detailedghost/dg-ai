import { describe, expect, test } from "bun:test";
import { REACTION_DEFAULTS } from "../src/config";
import { helpText } from "../src/help";

const overview = () =>
	helpText("Review Bot", "!owner", ["ready"], REACTION_DEFAULTS);
const review = () =>
	helpText("Review Bot", "!owner", ["ready"], REACTION_DEFAULTS, "review");
const address = (allowAnySender = false) =>
	helpText(
		"Review Bot",
		"!owner",
		["ready"],
		REACTION_DEFAULTS,
		"address",
		allowAnySender,
	);

describe("helpText overview", () => {
	test("lists every command on one line and points at the per-command help", () => {
		const html = overview();
		expect(html).toContain(
			"<p><b>Commands</b></p><ul><li><code>$review &lt;PR link&gt;</code>",
		);
		expect(html).toContain(
			"<li><code>$address &lt;PR link&gt;</code>: fix the review comments and failing CI, then push</li>",
		);
		expect(html).toContain(
			"<li><code>$emoji &lt;slot&gt;</code>: set the custom emoji for a reaction slot</li>",
		);
		expect(html).toContain(
			"<code>$help $review</code>, <code>$help $address</code>, or <code>$help $emoji</code>",
		);
		expect(html).not.toContain("~spice");
		expect(html).not.toContain("<b>Reactions</b>");
	});

	test("escapes the owner token", () => {
		const html = helpText(
			"Review Bot",
			"<b>&me",
			["ready"],
			REACTION_DEFAULTS,
		);
		expect(html).toContain("<code>&lt;b&gt;&amp;me</code>");
		expect(html).not.toContain("<b>&me");
	});

	test("names the bot it was given", () => {
		const html = helpText("Review Bot", "!owner", ["ready"], REACTION_DEFAULTS);
		expect(html).toContain("Mention <b>@Review Bot</b> in every message");
		expect(html).not.toContain("Beta");
	});
});

describe("helpText review", () => {
	test("lists the review flags with an example", () => {
		const html = review();
		expect(html).toContain(
			"<p><b>Flags</b></p><ul><li><code>~spice 1-5</code>",
		);
		expect(html).toContain(
			"<code>@Review Bot !owner $review &lt;PR link&gt; ~spice 3</code>",
		);
		expect(html).not.toContain("~no-ci");
	});

	test("escapes the ready words", () => {
		const html = helpText(
			"Review Bot",
			"!owner",
			["fixed <now>"],
			REACTION_DEFAULTS,
			"review",
		);
		expect(html).toContain("<code>fixed &lt;now&gt;</code>");
	});

	test("lists each review reaction emoji with its meaning", () => {
		const html = review();
		expect(html).toContain("<li>\u{1F440} the request was seen</li>");
		expect(html).toContain("<li>\u{23F1} the review is running</li>");
		expect(html).toContain("<li>\u{2705} approved</li>");
		expect(html).toContain("<li>\u{1F6A7} changes requested</li>");
		expect(html).toContain("<li>\u{1F4AC} comments only</li>");
		expect(html).toContain(
			"<li>\u{26A0} the review failed; the reply gives the reason</li>",
		);
	});

	test("shows a custom reaction id that is not a code point as code", () => {
		const html = helpText(
			"Review Bot",
			"!owner",
			["ready"],
			{ ...REACTION_DEFAULTS, inProgress: "partyparrot" },
			"review",
		);
		expect(html).toContain(
			"<li><code>partyparrot</code> the review is running</li>",
		);
	});

	test("shows a captured custom reaction id as its escaped name in colons", () => {
		const html = helpText(
			"Review Bot",
			"!owner",
			["ready"],
			{
				...REACTION_DEFAULTS,
				inProgress: "<load>;0-cus-d20-0123456789abcdef0123456789abcdef",
			},
			"review",
		);
		expect(html).toContain(
			"<li>:&lt;load&gt;: the review is running</li>",
		);
		expect(html).not.toContain("<emoji");
		expect(html).not.toContain("0-cus-d20");
	});

	test("shows a custom reaction id from another region the same way", () => {
		const html = helpText(
			"Review Bot",
			"!owner",
			["ready"],
			{
				...REACTION_DEFAULTS,
				approved: "party-blob;0-wus-d8-0123456789abcdef0123456789abcdef",
			},
			"address",
		);
		expect(html).toContain(
			"<li>:party-blob: addressed and ready for re-review</li>",
		);
	});
});

describe("helpText address", () => {
	test("says what $address does, its flags, and the re-review reply", () => {
		const html = address();
		expect(html).toContain(
			"<b>$address</b> runs /address on a fresh clone of the PR branch",
		);
		expect(html).toContain("Ready for re-review.");
		expect(html).toContain(
			"<li><code>~no-ci</code>: fix review comments only, skip failing CI checks</li>",
		);
		expect(html).toContain(
			"<code>@Review Bot !owner $address &lt;PR link&gt; ~no-ci</code>",
		);
		expect(html).not.toContain("~spice");
	});

	test("lists each address reaction emoji with its meaning", () => {
		const html = address();
		expect(html).toContain("<li>\u{1F440} the request was seen</li>");
		expect(html).toContain("<li>\u{23F1} /address is running</li>");
		expect(html).toContain(
			"<li>\u{2705} addressed and ready for re-review</li>",
		);
		expect(html).toContain(
			"<li>\u{26A0} it failed; the reply gives the reason</li>",
		);
		expect(html).not.toContain("changes requested");
	});

	test("names the sender limit only while the allowlist is on", () => {
		expect(address()).toContain("Only allowed senders can run it.");
		expect(address(true)).not.toContain("Only allowed senders");
	});
});

describe("helpText emoji", () => {
	const emoji = (allowAnySender = false) =>
		helpText(
			"Review Bot",
			"!owner",
			["ready"],
			{ ...REACTION_DEFAULTS, approved: "party;0-wus-d4-0123456789abcdef0123456789abcdef" },
			"emoji",
			allowAnySender,
		);

	test("explains the flow with an example", () => {
		const html = emoji();
		expect(html).toContain("react to that reply with a custom emoji within 5 minutes");
		expect(html).toContain("<code>@Review Bot !owner $emoji approved</code>");
	});

	test("lists every slot with its current emoji", () => {
		const html = emoji();
		for (const slot of Object.keys(REACTION_DEFAULTS))
			expect(html).toContain(`<li><code>${slot}</code> `);
		expect(html).toContain("<li><code>approved</code> :party:: approved or addressed</li>");
		expect(html).toContain("(also <code>progress</code>)");
	});

	test("names the sender limit only while the allowlist is on", () => {
		expect(emoji()).toContain("Only allowed senders can run it.");
		expect(emoji(true)).not.toContain("Only allowed senders");
	});
});
