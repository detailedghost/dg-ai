import { escapeHtml, NIT_LADDER, SPICE_DEFAULT, VERDICT_LIMITS } from "@dg/common";
import type { ReactionState } from "./reactions";
import { EFFORT_LEVELS, RUNNER_NAMES } from "./runners/types";
import type { HelpTopic } from "./trigger";

type Row = readonly [string, string];

const COMMANDS: readonly Row[] = [
	["$review &lt;PR link&gt;", "run a review"],
	["$thrash &lt;PR link&gt;", "same as $review"],
	[
		"$address &lt;PR link&gt;",
		"fix the review comments and failing CI, then push",
	],
	["$emoji &lt;slot&gt;", "set the custom emoji for a reaction slot"],
	["$help", "show this message"],
];

const EMOJI_SLOTS: readonly [ReactionState, string][] = [
	["pending", "the request was seen"],
	["inProgress", "work is running (also <code>progress</code>)"],
	["approved", "approved or addressed"],
	["changesRequested", "changes requested"],
	["comment", "comments only"],
	["failure", "it failed"],
];

export const EMOJI_WAIT_MINUTES = 5;

const REVIEW_FLAGS: readonly Row[] = [
	["~spice 1-5", "how strict the review is"],
	[
		"~model &lt;name&gt;",
		"pick a model for this review: <code>opus</code>, <code>sonnet</code>, <code>haiku</code>, or a full model ID such as a Bedrock ID",
	],
	[`~effort ${EFFORT_LEVELS.join("|")}`, "how hard Claude thinks (Claude only)"],
	["~comment", "post comments only, never approve or request changes"],
	[
		`~agent ${RUNNER_NAMES.join("|")}`,
		"pick the reviewer (codex, copilot, and grok are experimental)",
	],
	["~stacked", "also review the PRs stacked on this one"],
	["~fun", "add a GIF or emoji to the result"],
];

const TIER_NAMES = { critical: "💀 critical", high: "🔥 high", medium: "⚠️ medium", low: "🧹 low", nit: "🔬 nit" } as const;

function spiceLevel([level, limits]: [string, (typeof VERDICT_LIMITS)[number]]): string {
	const fails = Object.entries(limits)
		.map(([tier, limit]) => {
			const name = TIER_NAMES[tier as keyof typeof TIER_NAMES];
			return limit === 0 ? `any ${name}` : `more than ${limit} ${name}`;
		})
		.join(", ");
	const nits = NIT_LADDER[Number(level)] ?? 0;
	const posted = nits === 0 ? "posts no nits" : Number.isFinite(nits) ? `posts up to ${nits} nits` : "posts every nit";
	const fallback = Number(level) === SPICE_DEFAULT ? " (default)" : "";
	return `<li><code>${level}</code>${fallback}: requests changes on ${fails}; ${posted}</li>`;
}

const SPICE_LEVELS = `<p><b>Spice levels</b> set how hard the review looks and how many findings fail it. The tone never changes.</p><ul>${Object.entries(VERDICT_LIMITS).map(spiceLevel).join("")}</ul>`;

const ADDRESS_FLAGS: readonly Row[] = [
	["~no-ci", "fix review comments only, skip failing CI checks"],
];

const REVIEW_REACTIONS: readonly [ReactionState, string][] = [
	["pending", "the request was seen"],
	["inProgress", "the review is running"],
	["approved", "approved"],
	["changesRequested", "changes requested"],
	["comment", "comments only"],
	["failure", "the review failed; the reply gives the reason"],
];

const ADDRESS_REACTIONS: readonly [ReactionState, string][] = [
	["pending", "the request was seen"],
	["inProgress", "/address is running"],
	["approved", "addressed and ready for re-review"],
	["failure", "it failed; the reply gives the reason"],
];

const NAMED_GLYPHS: Record<string, string> = { speechbubble: "\u{1F4AC}" };

const LINKS =
	"<p>Links must be on github.com, gitlab.com, or a host in config.</p>";

function glyph(reactionId: string): string {
	const named = NAMED_GLYPHS[reactionId];
	if (named) return named;
	const match = /^((?:[0-9a-f]{4,6}-)*[0-9a-f]{4,6})_/.exec(reactionId);
	if (!match?.[1]) {
		const [name = "", region] = reactionId.split(";");
		if (region === undefined) return `<code>${escapeHtml(reactionId)}</code>`;
		return `:${escapeHtml(name)}:`;
	}
	return String.fromCodePoint(
		...match[1].split("-").map((hex) => Number.parseInt(hex, 16)),
	);
}

function list(rows: readonly Row[]): string {
	const items = rows.map(
		([token, text]) => `<li><code>${token}</code>: ${text}</li>`,
	);
	return `<ul>${items.join("")}</ul>`;
}

function reactionList(
	bot: string,
	meanings: readonly [ReactionState, string][],
	reactions: Record<ReactionState, string>,
): string {
	const items = meanings.map(
		([state, meaning]) => `<li>${glyph(reactions[state])} ${meaning}</li>`,
	);
	return `<p><b>Reactions</b> on your message</p><ul>${items.join("")}</ul>`;
}

export function helpText(
	botName: string,
	ownerToken: string,
	phrases: readonly string[],
	reactions: Record<ReactionState, string>,
	topic: HelpTopic = "overview",
	allowAnySender = false,
	defaultModel?: string,
): string {
	const bot = escapeHtml(botName);
	const owner = escapeHtml(ownerToken);
	const example = (command: string) =>
		`<p><b>Example:</b> <code>@${bot} ${owner} ${command}</code></p>`;

	if (topic === "review") {
		const words = phrases
			.map((phrase) => `<code>${escapeHtml(phrase)}</code>`)
			.join(", ");
		return [
			"<p><b>$review</b> and <b>$thrash</b> run a review of the PR.</p>",
			example("$review &lt;PR link&gt; ~spice 3"),
			`<p><b>Flags</b></p>${list(REVIEW_FLAGS)}`,
			SPICE_LEVELS,
			defaultModel
				? `<p><b>Default model:</b> <code>${escapeHtml(defaultModel)}</code>. Use ~model to pick a different one.</p>`
				: "",
			"<p>When Claude reaches its usage limit, a review retries once with the runner set in <code>runner.fallback</code>, if one is set and ready. A reply to your request tells you about the switch.</p>",
			`<p><b>Re-review:</b> mention @${bot} with a ready word (${words}) and the PR link, or quote-reply to a request. This re-runs the review for any PR, not only blocked ones.</p>`,
			reactionList(bot, REVIEW_REACTIONS, reactions),
			LINKS,
		].join("");
	}

	if (topic === "address") {
		return [
			"<p><b>$address</b> runs /address on a fresh clone of the PR branch. It fixes the review comments and failing CI, commits, pushes, and replies to the review threads.",
			` When it is done, your message gets the addressed reaction, and the PR is ready for re-review. PRs from a fork do not work. Do not put $review or $thrash in the same message.${allowAnySender ? "" : " Only allowed senders can run it."}</p>`,
			example("$address &lt;PR link&gt; ~no-ci"),
			`<p><b>Flags</b></p>${list(ADDRESS_FLAGS)}`,
			reactionList(bot, ADDRESS_REACTIONS, reactions),
			LINKS,
		].join("");
	}

	if (topic === "emoji") {
		const slots = EMOJI_SLOTS.map(
			([state, meaning]) =>
				`<li><code>${state}</code> ${glyph(reactions[state])}: ${meaning}</li>`,
		);
		return [
			`<p><b>$emoji &lt;slot&gt;</b> sets the custom emoji for a reaction slot. ${bot} replies; react to that reply with a custom emoji within ${EMOJI_WAIT_MINUTES} minutes. ${bot} saves it and uses it at once. Built-in emojis do not count.${allowAnySender ? "" : " Only allowed senders can run it."}</p>`,
			example("$emoji approved"),
			`<p><b>Slots</b></p><ul>${slots.join("")}</ul>`,
		].join("");
	}

	return [
		`<p>Mention <b>@${bot}</b> in every message, then write <code>${owner}</code> and a command.</p>`,
		example("$review &lt;PR link&gt;"),
		`<p><b>Commands</b></p>${list(COMMANDS)}`,
		"<p>Send <code>$help $review</code>, <code>$help $address</code>, or <code>$help $emoji</code> for that command's details.</p>",
		LINKS,
	].join("");
}
