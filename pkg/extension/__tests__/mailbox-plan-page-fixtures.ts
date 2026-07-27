import type {
	MailboxAction,
	MailboxFingerprint,
	MailboxInventory,
	MailboxMessage,
	MailboxPlanRevision,
	MailboxValidatedHint,
} from "@dg/common";
import {
	deriveMailboxCohorts,
	createMailboxCleanupChoices,
} from "../lib/features/mailbox-cleanup/planning";
import type {
	MailboxCaptureCounts,
	MailboxCaptureMetadata,
	MailboxCaptureResult,
} from "../lib/features/mailbox-cleanup/coordinator";
import type { RawBindingScope } from "../lib/features/mailbox-cleanup/storage";

export const NOW = "2026-07-27T12:00:00.000Z";
export const NOW_MS = Date.parse(NOW);
export const PLAN_ALIAS = "plan_00112233445566778899aabbccddeeff";
export const REVISION_ALIAS = "rev_102132435465768798a9bacbdcedfe0f";
export const NEXT_REVISION_ALIAS = "rev_2031425364758697a8b9cadbecfd0e1f";
export const ACCOUNT_ALIAS = "acct_30415263748596a7b8c9daebfc0d1e2f";
export const RUN_ALIAS = "run_405162738495a6b7c8d9eafb0c1d2e3f";
export const RAW_DISPLAY_SENTINEL =
	"Alice Example — Payroll Q4 — 4111111111111111";
export const RAW_LOCATOR_SENTINEL =
	"#mail-row[data-provider-id='raw-provider-message-1']";

export function alias(
	prefix: "msg" | "fld" | "lbl" | "flt",
	seed: number,
): string {
	return `${prefix}_89abcdef01234567fedcba98${seed
		.toString(16)
		.padStart(8, "0")}`;
}

export function mailboxMessage(seed: number): MailboxMessage {
	const categories = [
		"newsletter",
		"personal",
		"transactional",
		"notification",
	] as const;
	return {
		alias: alias("msg", seed),
		read: seed % 3 === 0,
		hasAttachments: seed % 5 === 0,
		receivedAt: "2026-06-01T12:00:00.000Z",
		category: categories[(seed - 1) % categories.length] ?? "other",
	};
}

export function mailboxInventory(count = 8, partial = false): MailboxInventory {
	return {
		schemaVersion: 1,
		providerId: "fake-mail",
		surface: "inbox",
		accountAlias: ACCOUNT_ALIAS,
		runAlias: RUN_ALIAS,
		capturedAt: NOW,
		partial,
		messages: Array.from({ length: count }, (_unused, index) =>
			mailboxMessage(index + 1),
		),
		folders: [{ alias: alias("fld", 1), messageCount: count }],
		labels: [{ alias: alias("lbl", 1), messageCount: count }],
		filters: [{ alias: alias("flt", 1), active: true }],
	};
}

export function captureMetadata(): MailboxCaptureMetadata {
	return {
		tags: [{ alias: alias("lbl", 101), messageCount: 2 }],
		categories: [{ alias: alias("lbl", 102), messageCount: 3 }],
	};
}

export function captureResult(
	options: Readonly<{
		count?: number;
		partial?: boolean;
	}> = {},
): Extract<MailboxCaptureResult, { status: "complete" | "partial" }> {
	const inventory = mailboxInventory(
		options.count ?? 8,
		options.partial ?? false,
	);
	const metadata = captureMetadata();
	const counts: MailboxCaptureCounts = {
		messages: inventory.messages.length,
		folders: inventory.folders.length,
		labels: inventory.labels.length,
		tags: metadata.tags.length,
		categories: metadata.categories.length,
		filters: inventory.filters.length,
	};
	return {
		status: inventory.partial ? "partial" : "complete",
		...(inventory.partial ? { reasonCode: "provider_partial" as const } : {}),
		inventory,
		counts,
		metadata,
		cohorts: deriveMailboxCohorts(inventory),
		choices: createMailboxCleanupChoices(inventory, metadata),
	};
}

export function fingerprint(seed = "a"): MailboxFingerprint {
	return {
		schemaVersion: 1,
		algorithm: "sha256",
		digest: seed.repeat(64),
	};
}

export function revision(
	overrides: Partial<MailboxPlanRevision> = {},
): MailboxPlanRevision {
	const capture = captureResult();
	const baseActions: readonly MailboxAction[] = [
		{
			type: "archive",
			messageAlias: capture.inventory.messages[0]!.alias,
		},
		{
			type: "deactivate_filter",
			filterAlias: capture.inventory.filters[0]!.alias,
		},
	];
	return {
		schemaVersion: 1,
		planAlias: PLAN_ALIAS,
		revisionAlias: REVISION_ALIAS,
		revisionNumber: 1,
		state: "draft",
		restartRequired: false,
		createdAt: NOW,
		inventoryFingerprint: fingerprint(),
		cohorts: capture.cohorts,
		targets: {
			folderAliases: capture.inventory.folders.map((item) => item.alias),
			labelAliases: [
				...capture.inventory.labels.map((item) => item.alias),
				...capture.metadata.tags.map((item) => item.alias),
				...capture.metadata.categories.map((item) => item.alias),
			],
			filterAliases: capture.inventory.filters.map((item) => item.alias),
		},
		actions: baseActions,
		...overrides,
	};
}

export function bindingScope(): RawBindingScope {
	return {
		planAlias: PLAN_ALIAS,
		providerId: "fake-mail",
		surface: "inbox",
		accountAlias: ACCOUNT_ALIAS,
		runAlias: RUN_ALIAS,
		revisionAlias: REVISION_ALIAS,
	};
}

export function localHints(): readonly MailboxValidatedHint[] {
	return [
		{
			cohortKey: captureResult().cohorts[0]!.cohortKey,
			classification: "needs_review",
			confidence: 0.8,
			provenance: {
				source: "validated_local",
				validatedAt: NOW,
			},
		},
	];
}
