// Registry of all board sections in render order.
// To add a section: drop FooSection.astro here, add one line below, add import+map entry in BoardView.astro.

export interface SectionMeta {
	id: string;
	label: string;
	icon: string;
	applies: (payload: Record<string, unknown>) => boolean;
	/** Collapse when in implementation/recap mode (was open only while planning). */
	collapseInImpl?: boolean;
}

const has = (payload: Record<string, unknown>, key: string) =>
	Array.isArray(payload[key]) ? (payload[key] as unknown[]).length > 0 : Boolean(payload[key]);

const hasLinkOfKind = (payload: Record<string, unknown>, kind: string) =>
	[
		...(Array.isArray(payload.references) ? (payload.references as { kind?: string }[]) : []),
		...(Array.isArray(payload.links) ? (payload.links as { kind?: string }[]) : []),
	].some((item) => item.kind === kind);

export const registry: SectionMeta[] = [
	{
		id: "review",
		label: "Code Review",
		icon: "code-bracket",
		applies: (p) => typeof p.review === "object" && p.review !== null,
	},
	{
		id: "doc",
		label: "Document",
		icon: "document-text",
		applies: (p) => has(p, "doc"),
	},
	{
		id: "scope",
		label: "Scope",
		icon: "document-text",
		applies: (p) => has(p, "scope"),
	},
	{
		id: "lineage",
		label: "Lineage",
		icon: "chart-bar",
		applies: (p) => typeof p.lineage === "object" && p.lineage !== null,
	},
	{
		id: "cytoscape",
		label: "Diagram",
		icon: "squares-2x2",
		applies: (p) => typeof p.graph === "object" && p.graph !== null,
	},
	{
		id: "evidence",
		label: "Evidence",
		icon: "magnifying-glass",
		applies: (p) => has(p, "evidence"),
	},
	{
		id: "phases",
		label: "Phases",
		icon: "queue-list",
		applies: (p) => has(p, "phases"),
	},
	{
		id: "tracks",
		label: "Tracks",
		icon: "bars-3",
		applies: (p) => Array.isArray(p.tracks),
	},
	{
		id: "slices",
		label: "Slices",
		icon: "queue-list",
		applies: (p) => has(p, "slices"),
	},
	{
		id: "contracts",
		label: "Contracts",
		icon: "server",
		applies: (p) => has(p, "contracts"),
	},
	{
		id: "discoveries",
		label: "Discoveries",
		icon: "magnifying-glass",
		applies: (p) => has(p, "discoveries"),
	},
	{
		id: "risks",
		label: "Risks",
		icon: "exclamation-triangle",
		applies: (p) => has(p, "risks"),
	},
	// Reference-family sections sit near the bottom, just above blockers / decisions / next steps.
	{
		id: "links",
		label: "References",
		icon: "link",
		applies: (p) =>
			(Array.isArray(p.references) && (p.references as unknown[]).length > 0) ||
			(Array.isArray(p.links) && (p.links as unknown[]).length > 0),
	},
	{
		id: "pull-requests",
		label: "Pull Requests",
		icon: "code-bracket",
		applies: (p) => hasLinkOfKind(p, "pr"),
	},
	{
		id: "jira-tickets",
		label: "Jira Tickets",
		icon: "server",
		applies: (p) => hasLinkOfKind(p, "jira"),
	},
	{
		id: "blockers",
		label: "Blockers",
		icon: "exclamation-triangle",
		applies: (p) => has(p, "blockers"),
	},
	{
		id: "errors",
		label: "Errors / Blocked",
		icon: "exclamation-circle",
		applies: (p) =>
			(Array.isArray(p.errors) && (p.errors as unknown[]).length > 0) ||
			(Array.isArray(p.phases) && (p.phases as { status: string }[]).some((ph) => ph.status === "blocked")),
	},
	{
		id: "roundtable",
		label: "Roundtable",
		icon: "user-group",
		applies: (p) => has(p, "roundtable"),
	},
	{
		id: "decisions",
		label: "Decisions",
		icon: "bolt",
		applies: (p) => has(p, "decisions"),
		collapseInImpl: true,
	},
	{
		id: "checklist",
		label: "Checklist",
		icon: "check-circle",
		applies: (p) => has(p, "checklist"),
	},
	{
		id: "open-questions",
		label: "Open Questions",
		icon: "question-mark-circle",
		applies: (p) => has(p, "open_questions"),
	},
	{
		id: "resolved-questions",
		label: "Resolved Questions",
		icon: "check-circle",
		applies: (p) => has(p, "open_questions_resolved"),
		collapseInImpl: true,
	},
	{
		id: "code-samples",
		label: "Code Samples",
		icon: "code-bracket",
		applies: (p) => has(p, "code_samples"),
	},
	{
		id: "permissions",
		label: "Permissions",
		icon: "shield-check",
		applies: (p) => Array.isArray(p.permissions),
	},
	{
		id: "approval",
		label: "Approval",
		icon: "check-circle",
		applies: (p) => !!p.approval,
	},
	{
		id: "pr-decision",
		label: "Launch PR",
		icon: "code-bracket",
		applies: (p) => !!p.pr_decision_request,
		// Must stay expanded/interactive even on recap boards — this IS the recap's gate.
	},
	{
		id: "next-steps",
		label: "Next Steps",
		icon: "arrow-right-circle",
		// Also render for a live review gate with no steps drafted yet — otherwise the
		// activity rail links to a section that does not exist, and the gate is unanswerable.
		applies: (p) =>
			has(p, "next_steps") ||
			p.next_steps_feedback_pending === true ||
			!!(p.next_steps_review as { required?: boolean } | undefined)?.required,
	},
];
