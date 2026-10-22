import { escapeHtml } from "@dg/common";
import type { CrCode } from "./errors";
import type { ReactionState } from "./reactions";
import type { Verdict } from "./verdict/types";

export type StackRow = {
	number: number;
	url: string;
	outcome: Exclude<Verdict, "none"> | { code: CrCode };
};

export const VERDICT_LABELS = {
	approved: { emoji: "✅", word: "approved" },
	changes_requested: { emoji: "🚧", word: "changes requested" },
	commented: { emoji: "💬", word: "commented" },
} as const;

type ReactionOutcome = Extract<
	ReactionState,
	"approved" | "changesRequested" | "comment" | "failure"
>;

const SEVERITY: Record<ReactionOutcome, number> = {
	approved: 0,
	comment: 1,
	changesRequested: 2,
	failure: 3,
};

export function outcomeOf(outcome: StackRow["outcome"]): ReactionOutcome {
	if (typeof outcome !== "string") return "failure";
	if (outcome === "changes_requested") return "changesRequested";
	return outcome === "commented" ? "comment" : "approved";
}

export function aggregateOutcome(rows: StackRow[]): ReactionOutcome {
	return rows
		.map((row) => outcomeOf(row.outcome))
		.reduce<ReactionOutcome>(
			(worst, next) => (SEVERITY[next] > SEVERITY[worst] ? next : worst),
			"approved",
		);
}

function repoLabel(url: string, number: number): string {
	const path = URL.canParse(url) ? new URL(url).pathname : "";
	const repo = path.split(/\/(?:-\/)?(?:pull|merge_requests)\//)[0]?.split("/").filter(Boolean).at(-1);
	return `${repo ?? ""}#${number}`;
}

export function formatStackSummary(rows: StackRow[]): string {
	const header = `Stacked review: ${rows.length} PR${rows.length === 1 ? "" : "s"}`;
	const items = rows.map(({ outcome, number, url }) => {
		const link = `<a href="${escapeHtml(url)}">${escapeHtml(repoLabel(url, number))}</a>`;
		const verdict =
			typeof outcome === "string"
				? `${VERDICT_LABELS[outcome].emoji} ${VERDICT_LABELS[outcome].word}`
				: `⚠️ ${outcome.code}`;
		return `<li>${link}: ${verdict}</li>`;
	});
	return `<p>${header}</p><ul>${items.join("")}</ul>`;
}
