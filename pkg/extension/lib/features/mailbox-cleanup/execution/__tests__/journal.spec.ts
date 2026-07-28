import { describe, expect, it } from "bun:test";
import {
	buildMailboxExecutionAuthorityScope,
	createMailboxExecutionJournal,
	validateCanonicalMailboxExecutionRevision,
} from "../index";

const command = Object.freeze({
	planAlias: "plan_0123456789abcdef0123456789abcdef",
	revisionAlias: "rev_fedcba9876543210fedcba9876543210",
});
const ACCOUNT_ALIAS = "acct_89abcdef0123456789abcdef01234567";
const BEFORE_FINGERPRINT = Object.freeze({
	schemaVersion: 1 as const,
	algorithm: "sha256" as const,
	digest: "9".repeat(64),
});
const AFTER_FINGERPRINT = Object.freeze({
	schemaVersion: 1 as const,
	algorithm: "sha256" as const,
	digest: "a".repeat(64),
});

type AtomicRecord = Readonly<{
	version: number;
	value: unknown;
}>;

class AtomicMemoryStorage {
	readonly records = new Map<string, AtomicRecord>();

	async read(key: string): Promise<AtomicRecord | undefined> {
		const current = this.records.get(key);
		return current === undefined ? undefined : structuredClone(current);
	}

	async compareAndSet(
		key: string,
		expectedVersion: number | undefined,
		value: unknown,
	): Promise<boolean> {
		const current = this.records.get(key);
		if (current?.version !== expectedVersion) return false;
		this.records.set(key, {
			version: (current?.version ?? -1) + 1,
			value: structuredClone(value),
		});
		return true;
	}
}

function approvedRevision(actionCount = 1) {
	const messageAliases = Array.from(
		{ length: actionCount },
		(_, index) =>
			`msg_89abcdef0123456789abcdef${index
				.toString(16)
				.padStart(8, "0")}`,
	);
	return validateCanonicalMailboxExecutionRevision({
		schemaVersion: 1,
		...command,
		revisionNumber: 2,
		state: "approved",
		restartRequired: false,
		createdAt: "2026-07-27T12:00:00.000Z",
		inventoryFingerprint: BEFORE_FINGERPRINT,
		cohorts: [
			{
				schemaVersion: 1,
				cohortKey: "transactional-recent",
				category: "transactional",
				ageBucket: "recent",
				messageAliases,
				suggestedActions: [],
			},
		],
		targets: {
			folderAliases: [],
			labelAliases: [],
			filterAliases: [],
		},
		actions: messageAliases.map((messageAlias, index) => ({
				schemaVersion: 1,
				actionAlias: `act_0123456789abcdef01234567${(index + 10)
					.toString(16)
					.padStart(8, "0")}`,
				type: "archive",
				messageAlias,
			})),
	});
}

async function initialize(
	storage: AtomicMemoryStorage,
	now: () => string,
	leaseDurationMs = 30_000,
) {
	const journal = createMailboxExecutionJournal({
		storage,
		now,
		leaseDurationMs,
	});
	await journal.initialize(command, {
		accountAlias: ACCOUNT_ALIAS,
		revision: approvedRevision(),
		order: [0],
	});
	return journal;
}

describe("createMailboxExecutionJournal", () => {
	it("grants one fenced lease across two journal instances sharing durable storage", async () => {
		const storage = new AtomicMemoryStorage();
		const now = () => "2026-07-27T12:30:00.000Z";
		const first = await initialize(storage, now);
		const second = createMailboxExecutionJournal({ storage, now });

		const leases = await Promise.all([
			first.acquireLease(command, ACCOUNT_ALIAS, "worker:first"),
			second.acquireLease(command, ACCOUNT_ALIAS, "worker:second"),
		]);

		expect(leases.filter((lease) => lease !== undefined)).toHaveLength(1);
		expect(
			new Set(leases.flatMap((lease) => lease?.fence ?? [])).size,
		).toBe(1);
	});

	it("rejects a stale fence after an expired lease is acquired by another worker", async () => {
		const storage = new AtomicMemoryStorage();
		let nowMs = Date.parse("2026-07-27T12:30:00.000Z");
		const now = () => new Date(nowMs).toISOString();
		const first = await initialize(storage, now, 30);
		const second = createMailboxExecutionJournal({
			storage,
			now,
			leaseDurationMs: 30,
		});
		const firstLease = await first.acquireLease(
			command,
			ACCOUNT_ALIAS,
			"worker:first",
		);
		expect(firstLease).toBeDefined();

		nowMs += 31;
		const secondLease = await second.acquireLease(
			command,
			ACCOUNT_ALIAS,
			"worker:second",
		);
		expect(secondLease).toBeDefined();
		expect(secondLease?.fence).toBeGreaterThan(firstLease?.fence ?? 0);

		await expect(
			first.transitionAction(
				command,
				firstLease!,
				0,
				"pending",
				"dispatched",
			),
		).rejects.toMatchObject({
			name: "MailboxExecutionJournalError",
			code: "lease_lost",
		});
		await expect(
			first.prepareLifecycle(
				command,
				firstLease!,
				"approved",
				"canceled",
				{ status: "failed", reasonCode: "internal_failure" },
			),
		).rejects.toMatchObject({
			name: "MailboxExecutionJournalError",
			code: "lease_lost",
		});
	});

	it("rejects impossible durable lease, unit, cancellation, and terminal combinations", async () => {
		const pristine = new AtomicMemoryStorage();
		const now = () => "2026-07-27T12:30:00.000Z";
		await initialize(pristine, now);
		const [storageKey, original] = [...pristine.records.entries()].find(
			([key]) => key.includes(`:${command.planAlias}:`),
		)!;
		const corruptions: readonly Readonly<{
			name: string;
			mutate(snapshot: Record<string, unknown>): void;
		}>[] = [
			{
				name: "missing units",
				mutate(snapshot) {
					delete snapshot.units;
				},
			},
			{
				name: "non-boolean cancel request",
				mutate(snapshot) {
					snapshot.cancelRequested = "yes";
				},
			},
			{
				name: "invalid lease",
				mutate(snapshot) {
					snapshot.lease = {
						owner: "worker:first",
						fence: 0,
						expiresAt: "not-a-timestamp",
					};
				},
			},
			{
				name: "completed terminal with pending actions",
				mutate(snapshot) {
					snapshot.lifecycleState = "completed";
					snapshot.terminalStatus = "completed";
				},
			},
			{
				name: "unknown terminal reason",
				mutate(snapshot) {
					snapshot.lifecycleState = "canceled";
					snapshot.terminalStatus = "failed";
					snapshot.terminalReasonCode =
						"private provider row selector";
				},
			},
		];

		for (const corruption of corruptions) {
			const storage = new AtomicMemoryStorage();
			const snapshot = structuredClone(original.value) as Record<
				string,
				unknown
			>;
			corruption.mutate(snapshot);
			storage.records.set(storageKey, {
				version: original.version,
				value: snapshot,
			});
			const journal = createMailboxExecutionJournal({ storage, now });
			const error = await journal.snapshot(command).then(
				() => undefined,
				(value: unknown) => value,
			);
			expect({
				name: corruption.name,
				errorName:
					error instanceof Error
						? error.name
						: undefined,
				code:
					error !== null && typeof error === "object"
						? (error as { code?: unknown }).code
						: undefined,
			}).toEqual({
				name: corruption.name,
				errorName: "MailboxExecutionJournalError",
				code: "invalid_snapshot",
			});
			expect(String(error)).not.toContain("private provider row selector");
		}
	});

	it("persists the final Inbox observation before preparing the completed lifecycle", async () => {
		const storage = new AtomicMemoryStorage();
		const now = () => "2026-07-27T12:30:00.000Z";
		const journal = await initialize(storage, now);
		const lease = await journal.acquireLease(
			command,
			ACCOUNT_ALIAS,
			"worker:first",
		);
		expect(lease).toBeDefined();
		let snapshot = await journal.prepareLifecycle(
			command,
			lease!,
			"approved",
			"in_flight",
		);
		snapshot = await journal.commitLifecycle(
			command,
			lease!,
			"approved",
			"in_flight",
		);
		snapshot = await journal.transitionAction(
			command,
			lease!,
			0,
			"pending",
			"dispatched",
		);
		snapshot = await journal.transitionAction(
			command,
			lease!,
			0,
			"dispatched",
			"observed",
			{
				observation: {
					status: "observed",
					observedAt: "2026-07-27T12:30:01.000Z",
				},
			},
		);
		snapshot = await journal.transitionAction(
			command,
			lease!,
			0,
			"observed",
			"verified",
			{
				verification: {
					status: "verified",
					verifiedAt: "2026-07-27T12:30:02.000Z",
					delta: {
						schemaVersion: 1,
						scope: "entire_fingerprint",
						actionAlias: snapshot.actions[0]!.action.actionAlias,
						changedAliases: [
							(snapshot.actions[0]!.action as { messageAlias: string })
								.messageAlias,
						],
						beforeFingerprint: BEFORE_FINGERPRINT,
						afterFingerprint: AFTER_FINGERPRINT,
						beforeScope:
							buildMailboxExecutionAuthorityScope([
								snapshot.actions[0]!.action,
							]),
						afterScope:
							buildMailboxExecutionAuthorityScope([]),
					},
				},
				result: {
					schemaVersion: 1,
					index: 0,
					action: snapshot.actions[0]!.action,
					status: "completed",
					affectedCount: 1,
				},
				authorityFingerprint: AFTER_FINGERPRINT,
				authorityScope:
					buildMailboxExecutionAuthorityScope([]),
			},
		);
		snapshot = await journal.setFinalInboxObservation(
			command,
			lease!,
			{
				status: "observed",
				count: 0,
				observedAt: "2026-07-27T12:30:03.000Z",
			},
		);

		await expect(
			journal.prepareLifecycle(
				command,
				lease!,
				"in_flight",
				"completed",
				{ status: "completed" },
			),
		).resolves.toMatchObject({
			lifecycleState: "in_flight",
			lifecycleIntent: {
				expected: "in_flight",
				next: "completed",
			},
			finalInboxObservation: {
				status: "observed",
				count: 0,
			},
			actions: [{ state: "verified" }],
		});
	});

	it("rejects completed settlement unless every action is verified completed", async () => {
		const storage = new AtomicMemoryStorage();
		const now = () => "2026-07-27T12:30:00.000Z";
		const journal = await initialize(storage, now);
		const lease = await journal.acquireLease(
			command,
			ACCOUNT_ALIAS,
			"worker:first",
		);
		expect(lease).toBeDefined();
		await journal.prepareLifecycle(
			command,
			lease!,
			"approved",
			"in_flight",
		);
		await journal.commitLifecycle(
			command,
			lease!,
			"approved",
			"in_flight",
		);
		await journal.skipPending(command, lease!, "canceled");
		await journal.prepareLifecycle(
			command,
			lease!,
			"in_flight",
			"completed",
			{ status: "completed" },
		);

		await expect(
			journal.finish(command, lease!, "completed"),
		).rejects.toMatchObject({
			name: "MailboxExecutionJournalError",
			code: "invalid_snapshot",
		});
	});

	it("derives exact 100-action journal units without executing the batch", async () => {
		const storage = new AtomicMemoryStorage();
		const now = () => "2026-07-27T12:30:00.000Z";
		const journal = createMailboxExecutionJournal({ storage, now });
		const actionCount = 101;

		const snapshot = await journal.initialize(command, {
			accountAlias: ACCOUNT_ALIAS,
			revision: approvedRevision(actionCount),
			order: Array.from({ length: actionCount }, (_, index) => index),
		});

		expect(snapshot.actions).toHaveLength(actionCount);
		expect(snapshot.unitSize).toBe(100);
		expect(snapshot.units).toEqual([
			{ startIndex: 0, endIndex: 99, state: "pending" },
			{ startIndex: 100, endIndex: 100, state: "pending" },
		]);
	});
});
