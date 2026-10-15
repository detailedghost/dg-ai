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

export function formatStackSummary(rows: StackRow[]): string {
	const header = `Stacked review: ${rows.length} PR${rows.length === 1 ? "" : "s"}`;
	const lines = rows.map(({ outcome, number, url }) =>
		typeof outcome === "string"
			? `${VERDICT_LABELS[outcome].emoji} #${number} ${url}`
			: `⚠️ ${outcome.code} #${number} ${url}`,
	);
	return [header, ...lines].join("\n");
}
