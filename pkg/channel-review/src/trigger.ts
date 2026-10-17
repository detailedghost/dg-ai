import type { CrCode } from "./errors";
import { RUNNER_NAMES, type RunnerName } from "./runners/types";
import { canonicalPrPath } from "./state";
import type { PrHost } from "./verdict/types";

export type HelpTopic = "overview" | "review" | "address" | "emoji";

export type TriggerResult =
	| { kind: "ignore" }
	| { kind: "help"; topic: HelpTopic }
	| {
			kind: "error";
			code: Extract<
				CrCode,
				"CR-101" | "CR-102" | "CR-103" | "CR-104" | "CR-105" | "CR-108"
			>;
	  }
	| { kind: "emoji"; slot?: string }
	| { kind: "address"; url: string; number: number; host: PrHost; noCi: boolean }
	| {
			kind: "run";
			url: string;
			number: number;
			host: PrHost;
			spice?: number;
			comment: boolean;
			stacked: boolean;
			fun: boolean;
			agent?: RunnerName;
			model?: string;
	  };

export type ReadinessResult =
	| { kind: "ignore"; reason: "no-phrase" | "no-link" }
	| { kind: "rereview"; url: string; quote?: string };

const ENTITIES: Record<string, string> = {
	"&nbsp;": " ",
	"&lt;": "<",
	"&gt;": ">",
	"&quot;": '"',
	"&#39;": "'",
	"&amp;": "&",
};

const URL_PATTERN = /https?:\/\/[^\s<>"')\]]+/gi;
const PR_HOSTS: readonly PrHost[] = ["github", "gitlab"];
const DEFAULT_HOSTS: Record<PrHost, string> = {
	github: "github.com",
	gitlab: "gitlab.com",
};

export type PrHosts = Record<PrHost, readonly string[]>;

type PrTarget = { url: string; host: PrHost; number: number };
type PrLink = { kind: "pr"; target: PrTarget } | { kind: "rejected" };

function plainText(html: string): string {
	return html
		.replace(/<at\b[^>]*>.*?<\/at>/gis, " ")
		.replace(/<a\b[^>]*?\bhref=(["'])(.*?)\1[^>]*>/gis, " $2 ")
		.replace(/<[^>]*>/g, " ")
		.replace(/&(?:nbsp|lt|gt|quot|#39|amp);/g, (entity) => ENTITIES[entity] ?? entity);
}

function inspectLink(raw: string, hosts: PrHosts): PrLink | undefined {
	const cleaned = raw.replace(/[.,;:!?]+$/, "");
	if (!URL.canParse(cleaned)) return undefined;
	const link = new URL(cleaned);
	const shaped = PR_HOSTS.flatMap((host) => {
		const path = canonicalPrPath(host, link.pathname);
		return path ? [{ host, path }] : [];
	});
	if (shaped.length === 0) return undefined;
	const trusted =
		link.protocol === "https:" && link.username === "" && link.password === "";
	const found = trusted
		? shaped.find(({ host }) =>
				[DEFAULT_HOSTS[host], ...hosts[host]].includes(link.host),
			)
		: undefined;
	return found
		? {
				kind: "pr",
				target: {
					url: `https://${link.host}${found.path}`,
					host: found.host,
					number: Number(found.path.slice(found.path.lastIndexOf("/") + 1)),
				},
			}
		: { kind: "rejected" };
}

export function parsePrUrl(raw: string, hosts: PrHosts): PrTarget | undefined {
	const link = inspectLink(raw, hosts);
	return link?.kind === "pr" ? link.target : undefined;
}

function links(text: string, hosts: PrHosts): PrLink[] {
	return (text.match(URL_PATTERN) ?? []).flatMap(
		(raw) => inspectLink(raw, hosts) ?? [],
	);
}

function prUrls(text: string, hosts: PrHosts): PrTarget[] {
	return links(text, hosts).flatMap((link) => (link.kind === "pr" ? link.target : []));
}

function valueAfter(tokens: string[], flag: string): string | undefined {
	const index = tokens.indexOf(flag);
	return index === -1 ? undefined : tokens[index + 1];
}

export function parseTrigger(
	html: string,
	{ ownerToken, hosts }: { ownerToken: string; hosts: PrHosts },
): TriggerResult {
	const text = plainText(html.replace(QUOTE, " "));
	const tokens = text.toLowerCase().split(/\s+/).filter(Boolean);
	if (!tokens.includes(ownerToken.toLowerCase())) return { kind: "ignore" };
	const review = tokens.includes("$review") || tokens.includes("$thrash");
	const address = tokens.includes("$address");
	const emoji = tokens.includes("$emoji");
	if (tokens.includes("$help")) {
		const topic = address ? "address" : review ? "review" : emoji ? "emoji" : "overview";
		return { kind: "help", topic };
	}
	if (emoji && !review && !address) {
		const slot = valueAfter(tokens, "$emoji");
		return slot === undefined ? { kind: "emoji" } : { kind: "emoji", slot };
	}
	if (!review && !address) return { kind: "ignore" };
	if (review && address) return { kind: "error", code: "CR-105" };

	const found = links(text, hosts);
	const target = found.find((link) => link.kind === "pr")?.target;
	if (!target) {
		return { kind: "error", code: found.length > 0 ? "CR-104" : "CR-101" };
	}
	if (address) {
		return {
			kind: "address",
			...target,
			noCi: tokens.includes("~no-ci"),
		};
	}

	let spice: number | undefined;
	if (tokens.includes("~spice")) {
		const value = valueAfter(tokens, "~spice");
		if (value === undefined || !/^[1-5]$/.test(value)) {
			return { kind: "error", code: "CR-102" };
		}
		spice = Number(value);
	}

	let agent: RunnerName | undefined;
	if (tokens.includes("~agent")) {
		const value = valueAfter(tokens, "~agent");
		agent = RUNNER_NAMES.find((name) => name === value);
		if (!agent) return { kind: "error", code: "CR-103" };
	}
	const modelIndex = tokens.indexOf("~model");
	const model =
		modelIndex === -1
			? undefined
			: text.split(/\s+/).filter(Boolean)[modelIndex + 1];
	if (
		tokens.includes("~model") &&
		(model === undefined || !/^[a-z0-9][a-z0-9._:/-]{0,127}$/i.test(model))
	) {
		return { kind: "error", code: "CR-108" };
	}

	return {
		kind: "run",
		...target,
		...(spice === undefined ? {} : { spice }),
		comment: tokens.includes("~comment"),
		stacked: tokens.includes("~stacked"),
		fun: tokens.includes("~fun"),
		...(agent === undefined ? {} : { agent }),
		...(model === undefined ? {} : { model }),
	};
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const QUOTE = /<blockquote\b([^>]*)>.*?<\/blockquote>/gis;

type ReplyQuote = { html: string; messageId?: string };

function replyQuote(html: string): ReplyQuote | undefined {
	for (const [quote = "", attributes = ""] of html.matchAll(QUOTE)) {
		if (!/\bitemtype=(["'])http:\/\/schema\.skype\.com\/Reply\1/i.test(attributes)) {
			continue;
		}
		const messageId = attributes.match(/\bitemid=(["'])(.*?)\1/is)?.[2];
		return messageId ? { html: quote, messageId } : { html: quote };
	}
	return undefined;
}

export function parseReadiness(
	html: string,
	{
		phrases,
		blockedMessages,
		hosts,
	}: {
		phrases: string[];
		blockedMessages: Record<string, string>;
		hosts: PrHosts;
	},
): ReadinessResult {
	const text = plainText(html.replace(QUOTE, " "));
	const prose = text.replace(URL_PATTERN, " ");
	const matches = phrases.some((phrase) =>
		new RegExp(`(?<!\\w)${escapeRegExp(phrase)}(?!\\w)`, "i").test(prose),
	);
	if (!matches) return { kind: "ignore", reason: "no-phrase" };

	const quote = replyQuote(html);
	const url =
		prUrls(text, hosts)[0]?.url ??
		(quote?.messageId === undefined ? undefined : blockedMessages[quote.messageId]) ??
		(quote === undefined ? undefined : prUrls(plainText(quote.html), hosts)[0]?.url);
	if (!url) return { kind: "ignore", reason: "no-link" };
	return quote ? { kind: "rereview", url, quote: quote.html } : { kind: "rereview", url };
}
