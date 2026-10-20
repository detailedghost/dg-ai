import { existsSync, statSync } from "node:fs";
import { flagValue } from "../args";
import { sessionDir } from "../config";
import { die } from "../io";
import {
	awaitingVerdictSince,
	clearAwaitingVerdict,
	readPayload,
	validateSlug,
} from "../session";

export function cmdGet(rest: string[]): void {
	const [rawSlug, section] = rest;
	if (!rawSlug || !section)
		die(
			"usage: dg-skills viz get <slug> <section|--keys> [--require-fresh <sha>]",
		);
	const slug = validateSlug(rawSlug);
	const requireFresh = flagValue(rest, "--require-fresh");
	const payload = readPayload(slug);

	if (section === "--keys") {
		console.log(JSON.stringify(Object.keys(payload).sort(), null, 2));
		return;
	}
	if (!(section in payload)) {
		die(
			`section not found: ${section} (available: ${Object.keys(payload).join(", ")})`,
		);
	}

	if (requireFresh !== undefined) {
		if (section !== "review_result")
			die("--require-fresh only applies to the review_result section");
		const head = (payload.review as { head?: string } | undefined)?.head;
		if (!head || !/^[0-9a-f]{40}$/i.test(head)) {
			die(
				`board defect: rendered head "${head}" is not a resolved commit sha — re-render this board ("dg-skills viz review") to pick up the fix, then re-arm and wait again`,
			);
		}
		if (head !== requireFresh) {
			die(
				`stale verdict: board is rendered for head "${head}", not "${requireFresh}" — re-render and re-arm before trusting this verdict`,
			);
		}
		const responsePath = `${sessionDir(slug)}/response.json`;
		const markedAt = awaitingVerdictSince(slug);
		if (
			!existsSync(responsePath) ||
			markedAt === null ||
			statSync(responsePath).mtimeMs < markedAt
		) {
			die(
				"stale verdict: no submission recorded since this head was rendered — re-arm and wait again",
			);
		}
	}

	console.log(JSON.stringify(payload[section], null, 2));
	if (section === "review_result") clearAwaitingVerdict(slug);
}
