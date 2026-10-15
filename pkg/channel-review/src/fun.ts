import {
	fail,
	requireOneOf,
	requireRecord,
	requireString,
} from "@dg/common";
import type { Log } from "./engine";
import shippedPool from "./fun-pool.json";
import type { ReactionState } from "./reactions";
import type { AdaptiveCard } from "./providers/types";

export const FUN_VERDICTS = ["approved", "changes", "comment", "failed"] as const;
export const FUN_KINDS = ["gif", "emoji"] as const;

export type FunVerdict = (typeof FUN_VERDICTS)[number];

export type FunEntry =
	| { verdict: FunVerdict; kind: "gif"; url: string; alt: string }
	| { verdict: FunVerdict; kind: "emoji"; reactionId: string; text: string };

const SHIPPED_COUNT = 50;

function validateEntry(value: unknown, index: number): FunEntry {
	const path = `[${index}]`;
	requireRecord(value, path);
	requireOneOf(value.verdict, `${path}.verdict`, FUN_VERDICTS);
	requireOneOf(value.kind, `${path}.kind`, FUN_KINDS);
	if (value.kind === "gif") {
		requireString(value.url, `${path}.url`, { nonEmpty: true });
		requireString(value.alt, `${path}.alt`, { nonEmpty: true });
		if (!URL.canParse(value.url) || new URL(value.url).protocol !== "https:") {
			fail(`${path}.url must be an https URL`);
		}
		return { verdict: value.verdict, kind: "gif", url: value.url, alt: value.alt };
	}
	requireString(value.reactionId, `${path}.reactionId`, { nonEmpty: true });
	requireString(value.text, `${path}.text`, { nonEmpty: true });
	return {
		verdict: value.verdict,
		kind: "emoji",
		reactionId: value.reactionId,
		text: value.text,
	};
}

export function loadFunPool(override?: unknown): FunEntry[] {
	const source = override === undefined ? shippedPool : override;
	if (!Array.isArray(source)) fail("pool must be an array");
	const pool = source.map(validateEntry);

	const urls = new Set<string>();
	for (const entry of pool) {
		if (entry.kind !== "gif") continue;
		if (urls.has(entry.url)) fail(`duplicate gif url ${entry.url}`);
		urls.add(entry.url);
	}
	for (const verdict of FUN_VERDICTS) {
		for (const kind of FUN_KINDS) {
			if (!pool.some((e) => e.verdict === verdict && e.kind === kind)) {
				fail(`no ${kind} entry for verdict ${verdict}`);
			}
		}
	}
	if (override === undefined && pool.length !== SHIPPED_COUNT) {
		fail(`shipped pool must hold ${SHIPPED_COUNT} entries, found ${pool.length}`);
	}
	return pool;
}

export function filterVerifiedFun(
	pool: FunEntry[],
	reactionIds: string[],
	log: Log,
): FunEntry[] {
	const known = new Set(reactionIds);
	const kept = pool.filter((entry) => {
		if (entry.kind === "gif" || known.has(entry.reactionId)) return true;
		log.info(`fun emoji dropped: reaction id ${entry.reactionId} is unknown`);
		return false;
	});
	for (const verdict of FUN_VERDICTS) {
		const had = pool.some((e) => e.verdict === verdict && e.kind === "emoji");
		const has = kept.some((e) => e.verdict === verdict && e.kind === "emoji");
		if (had && !has) log.warn(`fun pool has no emoji entry left for ${verdict}`);
	}
	return kept;
}

export function pickFun(
	pool: FunEntry[],
	verdict: FunVerdict,
	random: () => number,
): FunEntry | undefined {
	const matching = pool.filter((entry) => entry.verdict === verdict);
	return matching[Math.floor(random() * matching.length)];
}

export function decorateReply({
	text,
	entry,
}: {
	text: string;
	entry: FunEntry;
}): { text: string; card?: AdaptiveCard } {
	if (entry.kind === "emoji") return { text: `${text}\n${entry.text}` };
	return {
		text,
		card: {
			type: "AdaptiveCard",
			version: "1.4",
			body: [{ type: "Image", url: entry.url, altText: entry.alt }],
		},
	};
}

const FUN_BY_OUTCOME: Record<
	Extract<ReactionState, "approved" | "changesRequested" | "comment" | "failure">,
	FunVerdict
> = {
	approved: "approved",
	changesRequested: "changes",
	comment: "comment",
	failure: "failed",
};

export function funVerdictFor(outcome: keyof typeof FUN_BY_OUTCOME): FunVerdict {
	return FUN_BY_OUTCOME[outcome];
}
