import {
	type MailboxFingerprint,
	type MailboxPlanRevision,
	serializeMailboxPlanRevision,
	validateMailboxPlanRevision,
} from "@dg/common";
import type {
	MailboxPlanStore,
	MailboxRevisionRecord,
	MailboxStoredPlan,
	MailboxTerminalReservation,
	RawBindingInvalidationReason,
	TerminalCleanupProof,
} from "../storage";

const DAY_MS = 24 * 60 * 60 * 1_000;
const RETENTION_MS: Record<MailboxPlanRevision["state"], number> = {
	draft: 30 * DAY_MS,
	approved: 7 * DAY_MS,
	in_flight: 7 * DAY_MS,
	completed: 7 * DAY_MS,
	canceled: 7 * DAY_MS,
};

const LEGAL_TRANSITIONS: Readonly<
	Record<MailboxPlanRevision["state"], readonly MailboxPlanRevision["state"][]>
> = {
	draft: ["approved", "canceled"],
	approved: ["in_flight", "canceled"],
	in_flight: ["completed", "canceled"],
	completed: [],
	canceled: [],
};

export type MailboxLifecyclePlan = Readonly<{
	schemaVersion: 1;
	planAlias: string;
	revisions: readonly MailboxPlanRevision[];
}>;

export type MailboxResumeResult = Readonly<{
	planAlias: string;
	revisionAlias: string;
	revision: MailboxPlanRevision;
	restartRequired: boolean;
	canExecute: boolean;
}>;

export type MailboxLifecycleAlarmSeam = Readonly<{
	schedule(planAlias: string, when: number): Promise<void> | void;
	cancel(planAlias: string): Promise<void> | void;
}>;

export type MailboxRestartSeam = Readonly<{
	mark(
		planAlias: string | undefined,
		revisionAlias: string | undefined,
		reason: "missing_execution_state" | "fingerprint_mismatch" | "storage_failure",
	): Promise<void> | void;
}>;

export type MailboxExecutionStateSeam = Readonly<{
	has(planAlias: string, revisionAlias: string): Promise<boolean> | boolean;
	invalidate(
		planAlias: string,
		revisionAlias: string,
		reason: RawBindingInvalidationReason,
	): Promise<TerminalCleanupProof | void> | TerminalCleanupProof | void;
	remove?(
		planAlias: string,
		revisionAlias: string,
	): Promise<void> | void;
}>;

export type MailboxFingerprintSeam = Readonly<{
	matches(
		stored: MailboxFingerprint,
		current: MailboxFingerprint,
	): Promise<boolean> | boolean;
}>;

export type MailboxLifecycleDeps = Readonly<{
	store: MailboxPlanStore;
	now: () => number;
	alarms?: MailboxLifecycleAlarmSeam;
	restart?: MailboxRestartSeam;
	execution: MailboxExecutionStateSeam;
	fingerprints?: MailboxFingerprintSeam;
}>;

export type MailboxTransition = Readonly<{
	planAlias: string;
	revisionAlias: string;
	expectedState: MailboxPlanRevision["state"];
	nextState: MailboxPlanRevision["state"];
}>;

export type MailboxLifecycle = Readonly<{
	create(revision: unknown): Promise<MailboxPlanRevision>;
	transition(change: MailboxTransition): Promise<MailboxPlanRevision>;
	edit(
		planAlias: string,
		basedOnRevisionAlias: string,
		draft: unknown,
	): Promise<MailboxPlanRevision>;
	get(planAlias: string): Promise<MailboxLifecyclePlan | undefined>;
	list(): Promise<readonly MailboxLifecyclePlan[]>;
	resume(
		planAlias: string,
		currentFingerprint?: MailboxFingerprint,
	): Promise<MailboxResumeResult | undefined>;
	removeExecutionState(
		planAlias: string,
		revisionAlias: string,
	): Promise<void>;
	reconcile(planAlias: string): Promise<MailboxLifecyclePlan | undefined>;
	reconcileAll(): Promise<readonly MailboxLifecyclePlan[]>;
}>;

export class MailboxLifecycleError extends Error {
	override readonly name = "MailboxLifecycleError";

	constructor(
		readonly code:
			| "illegal_transition"
			| "compare_failed"
			| "missing_revision"
			| "invalid_edit"
			| "store_corrupt",
	) {
		super(`Mailbox lifecycle rejected: ${code}`);
	}
}

function expiresAt(now: number, state: MailboxPlanRevision["state"]): number {
	return now + RETENTION_MS[state];
}

function lifecyclePlan(
	planAlias: string,
	records: readonly MailboxRevisionRecord[],
): MailboxLifecyclePlan {
	return Object.freeze({
		schemaVersion: 1,
		planAlias,
		revisions: Object.freeze(records.map((record) => record.revision)),
	});
}

function isExecutable(revision: MailboxPlanRevision): boolean {
	return (
		!revision.restartRequired &&
		(revision.state === "approved" || revision.state === "in_flight")
	);
}

function logicalExpiresAt(record: MailboxRevisionRecord): number {
	return record.terminalReservation === undefined
		? record.expiresAt
		: Math.min(
				record.expiresAt,
				record.terminalReservation.targetExpiresAt,
			);
}

function matchesTerminalOutcome(
	record: MailboxRevisionRecord | undefined,
	reservation: MailboxTerminalReservation,
	revision: MailboxPlanRevision,
): boolean {
	return (
		record !== undefined &&
		record.terminalReservation === undefined &&
		record.expiresAt === reservation.targetExpiresAt &&
		serializeMailboxPlanRevision(record.revision) ===
			serializeMailboxPlanRevision(revision)
	);
}

function matchesRestartOutcome(
	record: MailboxRevisionRecord | undefined,
	original: MailboxRevisionRecord,
	revision: MailboxPlanRevision,
): boolean {
	return (
		record !== undefined &&
		record.terminalReservation === undefined &&
		record.terminalCleanupPending === undefined &&
		record.expiresAt === original.expiresAt &&
		serializeMailboxPlanRevision(record.revision) ===
			serializeMailboxPlanRevision(revision)
	);
}

export function createMailboxLifecycle(
	deps: MailboxLifecycleDeps,
): MailboxLifecycle {
	const signalRestart = async (
		planAlias: string | undefined,
		revisionAlias: string | undefined,
		reason: "missing_execution_state" | "fingerprint_mismatch" | "storage_failure",
	): Promise<void> => {
		try {
			await deps.restart?.mark(planAlias, revisionAlias, reason);
		} catch {
			// Restart signaling is bounded; durable state remains authoritative.
		}
	};

	const failClosed = async (
		planAlias: string,
		revisionAlias: string,
	): Promise<void> => {
		try {
					await deps.execution.invalidate(
				planAlias,
				revisionAlias,
				"restart_required",
			);
		} catch {
			// Missing or unavailable execution state is already non-executable.
		}
		await signalRestart(planAlias, revisionAlias, "storage_failure");
	};

	const schedule = async (
		planAlias: string,
		records: readonly MailboxRevisionRecord[],
		cleanupRetryAt?: number,
	): Promise<void> => {
		try {
			const expiries = records.map(logicalExpiresAt);
			if (records.some((record) => record.terminalCleanupPending === true)) {
				expiries.push(deps.now());
			}
			if (cleanupRetryAt !== undefined) expiries.push(cleanupRetryAt);
			if (expiries.length === 0) {
				await deps.alarms?.cancel(planAlias);
				return;
			}
			await deps.alarms?.schedule(planAlias, Math.min(...expiries));
		} catch {
			// Durable state and read-time reconciliation remain authoritative.
		}
	};

	const markRestartRequired = async (
		record: MailboxRevisionRecord,
		reason:
			| "missing_execution_state"
			| "fingerprint_mismatch"
			| "storage_failure",
	): Promise<MailboxRevisionRecord> => {
		if (record.revision.restartRequired) return record;
		const revision = validateMailboxPlanRevision({
			...record.revision,
			restartRequired: true,
		});
		let restartReason = reason;
		try {
			await deps.execution.invalidate(
				record.planAlias,
				record.revisionAlias,
				"restart_required",
			);
		} catch {
			restartReason = "storage_failure";
		}
		await deps.store.compareAndSetRevision(
			record.planAlias,
			record.revisionAlias,
			record.revision.state,
			revision,
			record.expiresAt,
		);
		await signalRestart(
			record.planAlias,
			record.revisionAlias,
			restartReason,
		);
		return { ...record, revision };
	};

	const persistReservedRestart = async (
		record: MailboxRevisionRecord,
		onCleanupPending?: () => void,
	): Promise<MailboxRevisionRecord | undefined> => {
		const reservation = record.terminalReservation;
		if (reservation === undefined) return record;
		try {
			const revision = await deps.store.failTerminalReservation(
				record.planAlias,
				record.revisionAlias,
				reservation.nonce,
			);
			await signalRestart(
				record.planAlias,
				record.revisionAlias,
				"storage_failure",
			);
			const {
				terminalReservation: _terminalReservation,
				...restarted
				} = record;
				return { ...restarted, revision };
		} catch {
			const terminalRevision = validateMailboxPlanRevision({
				...record.revision,
				state: reservation.nextState,
			});
			const restartedRevision = validateMailboxPlanRevision({
				...record.revision,
				restartRequired: true,
			});
			try {
				const latest = await deps.store.getRecord(
					record.planAlias,
					record.revisionAlias,
				);
				if (
					latest !== undefined &&
					deps.now() < logicalExpiresAt(latest) &&
					matchesRestartOutcome(
						latest,
						record,
						restartedRevision,
					)
				) {
					return latest;
				}
				if (
					latest !== undefined &&
					deps.now() < logicalExpiresAt(latest) &&
					matchesTerminalOutcome(
						latest,
						reservation,
						terminalRevision,
					)
				) {
					await deps.store.markTerminalCleanupPending(
						record.planAlias,
						record.revisionAlias,
					);
					const pending = await deps.store.getRecord(
						record.planAlias,
						record.revisionAlias,
					);
					if (
						pending !== undefined &&
						deps.now() < logicalExpiresAt(pending) &&
						matchesTerminalOutcome(
							pending,
							reservation,
							terminalRevision,
						)
					) {
						return pending;
					}
				}
			} catch {
				// The bounded fail-closed path below owns signaling.
			}
			await failClosed(record.planAlias, record.revisionAlias);
			if (deps.now() >= logicalExpiresAt(record)) {
					try {
						await deps.store.deleteRevision(
							record.planAlias,
							record.revisionAlias,
						);
					} catch {
						onCleanupPending?.();
					}
			}
			return undefined;
		}
	};

	const recoverTerminalReservation = async (
		record: MailboxRevisionRecord,
		onCleanupPending?: () => void,
	): Promise<MailboxRevisionRecord | undefined> => {
		const reservation = record.terminalReservation;
		if (reservation === undefined) return record;
		try {
			await deps.execution.invalidate(
				record.planAlias,
				record.revisionAlias,
				reservation.nextState === "completed"
					? "completion"
					: "cancellation",
			);
			} catch {
				if (deps.now() >= logicalExpiresAt(record)) {
					await failClosed(record.planAlias, record.revisionAlias);
					try {
						await deps.store.deleteRevision(
							record.planAlias,
							record.revisionAlias,
						);
					} catch {
						// Logical expiry remains authoritative if cleanup is unavailable.
						onCleanupPending?.();
					}
					return undefined;
				}
				return persistReservedRestart(record, onCleanupPending);
			}

		const terminalRevision = validateMailboxPlanRevision({
			...record.revision,
			state: reservation.nextState,
		});
		try {
			const revision = await deps.store.commitTerminalTransition(
				record.planAlias,
				record.revisionAlias,
				reservation.expectedState,
				reservation.nonce,
				terminalRevision,
			);
			const {
				terminalReservation: _terminalReservation,
				...committed
			} = record;
			return {
				...committed,
				revision,
				expiresAt: reservation.targetExpiresAt,
			};
		} catch {
			// A completion event may race the returned promise. Confirm the durable
			// record before converting the reservation to restart-required.
			try {
				const latest = await deps.store.getRecord(
					record.planAlias,
					record.revisionAlias,
				);
				if (
					latest !== undefined &&
					matchesTerminalOutcome(
						latest,
						reservation,
						terminalRevision,
					)
				) {
					return latest;
				}
					if (
						latest !== undefined &&
						latest.terminalReservation?.nonce === reservation.nonce
					) {
						return persistReservedRestart(latest, onCleanupPending);
					}
			} catch {
				// The bounded fail-closed path below owns signaling.
			}
			await failClosed(record.planAlias, record.revisionAlias);
			return undefined;
		}
	};

	const reconcile = async (
		planAlias: string,
	): Promise<MailboxLifecyclePlan | undefined> => {
		let plan: MailboxStoredPlan | undefined;
		try {
			plan = await deps.store.getPlan(planAlias);
		} catch {
			await signalRestart(planAlias, undefined, "storage_failure");
			try {
				await deps.store.deletePlan(planAlias);
			} catch {
				// Logical access remains closed even when cleanup cannot run.
			}
			return undefined;
			}
				if (plan === undefined) return undefined;
				const active: MailboxRevisionRecord[] = [];
				let cleanupPending = false;
				for (const record of plan.revisions) {
				if (deps.now() >= logicalExpiresAt(record)) {
					if (record.terminalReservation !== undefined) {
						try {
							await deps.execution.invalidate(
								record.planAlias,
								record.revisionAlias,
								record.terminalReservation.nextState === "completed"
									? "completion"
									: "cancellation",
							);
						} catch {
							await signalRestart(
								record.planAlias,
								record.revisionAlias,
								"storage_failure",
							);
						}
					}
					try {
						await deps.store.deleteRevision(
							record.planAlias,
							record.revisionAlias,
						);
						} catch {
							// Logical expiry does not depend on physical cleanup.
							cleanupPending = true;
						}
						continue;
					}
					if (record.terminalReservation !== undefined) {
						const recovered = await recoverTerminalReservation(
							record,
							() => {
								cleanupPending = true;
							},
						);
						if (recovered !== undefined) active.push(recovered);
						continue;
				}
				if (
					record.revision.state === "completed" ||
					record.revision.state === "canceled"
				) {
					if (record.terminalCleanupPending === true) {
						try {
							const cleanupProof = await deps.execution.invalidate(
								record.planAlias,
								record.revisionAlias,
								record.revision.state === "completed"
									? "completion"
									: "cancellation",
							);
							if (deps.now() >= record.expiresAt) {
								try {
									await deps.store.deleteRevision(
										record.planAlias,
										record.revisionAlias,
									);
								} catch {
									cleanupPending = true;
								}
								continue;
							}
							await deps.store.clearTerminalCleanupPending(
								record.planAlias,
								record.revisionAlias,
								cleanupProof as TerminalCleanupProof,
							);
							const {
								terminalCleanupPending: _terminalCleanupPending,
								...cleared
							} = record;
							active.push(cleared);
						} catch {
							await signalRestart(
								record.planAlias,
								record.revisionAlias,
								"storage_failure",
							);
							active.push(record);
						}
						continue;
					}
					active.push(record);
					continue;
				}
			let executionPresent = false;
			let restartReason:
				| "missing_execution_state"
				| "storage_failure" = "missing_execution_state";
					try {
						executionPresent = await deps.execution.has(
						record.planAlias,
						record.revisionAlias,
					);
					} catch {
						restartReason = "storage_failure";
					}
					if (deps.now() >= logicalExpiresAt(record)) {
						try {
							await deps.store.deleteRevision(
								record.planAlias,
								record.revisionAlias,
							);
						} catch {
							cleanupPending = true;
						}
						continue;
					}
				if (record.revision.restartRequired) {
					if (executionPresent || restartReason === "storage_failure") {
						try {
							await deps.execution.invalidate(
								record.planAlias,
								record.revisionAlias,
								"restart_required",
							);
						} catch {
							await signalRestart(
								record.planAlias,
								record.revisionAlias,
								"storage_failure",
							);
						}
					}
					active.push(record);
					continue;
				}
				if (executionPresent) {
				active.push(record);
				continue;
			}
			try {
				active.push(
					await markRestartRequired(record, restartReason),
				);
				} catch {
					await failClosed(record.planAlias, record.revisionAlias);
					if (deps.now() >= logicalExpiresAt(record)) {
						try {
							await deps.store.deleteRevision(
								record.planAlias,
								record.revisionAlias,
							);
						} catch {
							cleanupPending = true;
						}
					}
				}
		}
			const visible: MailboxRevisionRecord[] = [];
			for (const record of active) {
				if (deps.now() < logicalExpiresAt(record)) {
					visible.push(record);
					continue;
				}
				try {
					await deps.store.deleteRevision(
						record.planAlias,
						record.revisionAlias,
					);
				} catch {
					cleanupPending = true;
				}
			}
				let exposed = visible;
				while (true) {
					await schedule(
						planAlias,
						exposed,
						cleanupPending ? deps.now() : undefined,
					);
					const expired = exposed.filter(
						(record) => deps.now() >= logicalExpiresAt(record),
					);
					if (expired.length === 0) break;
					exposed = exposed.filter(
						(record) => deps.now() < logicalExpiresAt(record),
					);
					for (const record of expired) {
						try {
							await deps.store.deleteRevision(
								record.planAlias,
								record.revisionAlias,
							);
						} catch {
							cleanupPending = true;
						}
					}
				}
				return exposed.length === 0
					? undefined
					: lifecyclePlan(planAlias, exposed);
	};

	return Object.freeze({
		async create(value) {
			const revision = validateMailboxPlanRevision(value);
			await deps.store.putRevision(revision, {
				expiresAt: expiresAt(deps.now(), revision.state),
			});
			const record = await deps.store.getRecord(
				revision.planAlias,
				revision.revisionAlias,
			);
			if (record !== undefined) await schedule(revision.planAlias, [record]);
			return revision;
		},
			async transition(change) {
				const current = await deps.store.getRecord(
				change.planAlias,
				change.revisionAlias,
			);
				if (current === undefined) {
					throw new MailboxLifecycleError("missing_revision");
				}
					if (current.revision.state !== change.expectedState) {
						throw new MailboxLifecycleError("compare_failed");
					}
			if (
				!LEGAL_TRANSITIONS[change.expectedState].includes(
					change.nextState,
				)
			) {
				throw new MailboxLifecycleError("illegal_transition");
			}
				const revision = validateMailboxPlanRevision({
					...current.revision,
					state: change.nextState,
				});
					const terminal =
						change.nextState === "completed" ||
						change.nextState === "canceled";
					const now = deps.now();
					const nextExpiry = expiresAt(now, change.nextState);
					if (terminal) {
				const reservation = await deps.store.reserveTerminalTransition(
					change.planAlias,
					change.revisionAlias,
					change.expectedState,
						change.nextState,
						nextExpiry,
					);
						const reservedPlan = await deps.store.getPlan(
							change.planAlias,
						);
						if (reservedPlan === undefined) {
							throw new MailboxLifecycleError("compare_failed");
						}
						await schedule(change.planAlias, reservedPlan.revisions);
					await deps.execution.invalidate(
					change.planAlias,
					change.revisionAlias,
					reservation.nextState === "completed"
						? "completion"
							: "cancellation",
					);
					const terminalRevision = validateMailboxPlanRevision({
						...current.revision,
						state: reservation.nextState,
					});
					let updated: MailboxPlanRevision;
					try {
						updated = await deps.store.commitTerminalTransition(
							change.planAlias,
							change.revisionAlias,
							change.expectedState,
							reservation.nonce,
							terminalRevision,
						);
					} catch {
						let latest: MailboxRevisionRecord | undefined;
						try {
							latest = await deps.store.getRecord(
								change.planAlias,
								change.revisionAlias,
							);
						} catch {
							throw new MailboxLifecycleError("compare_failed");
						}
						if (
							latest === undefined ||
							!matchesTerminalOutcome(
								latest,
								reservation,
								terminalRevision,
							)
						) {
							throw new MailboxLifecycleError("compare_failed");
						}
						updated = latest.revision;
					}
					const plan = await deps.store.getPlan(change.planAlias);
					if (plan !== undefined) {
						await schedule(change.planAlias, plan.revisions);
					}
					return updated;
				}
				const updated = await deps.store.compareAndSetRevision(
					change.planAlias,
					change.revisionAlias,
					change.expectedState,
					revision,
					nextExpiry,
				);
			const plan = await deps.store.getPlan(change.planAlias);
			if (plan !== undefined) await schedule(change.planAlias, plan.revisions);
			return updated;
		},
		async edit(planAlias, basedOnRevisionAlias, value) {
			const draft = validateMailboxPlanRevision(value);
			if (
				draft.planAlias !== planAlias ||
				draft.state !== "draft"
			) {
				throw new MailboxLifecycleError("invalid_edit");
			}
			const now = deps.now();
			const revision = await deps.store.appendDraftRevision(
				planAlias,
				basedOnRevisionAlias,
				draft,
				expiresAt(now, "draft"),
			);
			const updated = await deps.store.getPlan(planAlias);
			if (updated !== undefined) await schedule(planAlias, updated.revisions);
			return revision;
		},
		get: reconcile,
		async list() {
			let plans: readonly MailboxStoredPlan[];
			try {
				plans = await deps.store.listPlans();
			} catch {
				await signalRestart(
					undefined,
					undefined,
					"storage_failure",
				);
				throw new MailboxLifecycleError("store_corrupt");
			}
			const reconciled = await Promise.all(
				plans.map((plan) => reconcile(plan.planAlias)),
			);
			return Object.freeze(
				reconciled.filter(
					(plan): plan is MailboxLifecyclePlan =>
						plan !== undefined,
				),
			);
		},
		async resume(planAlias, currentFingerprint) {
			const plan = await reconcile(planAlias);
			if (plan === undefined) return undefined;
			const revision = plan.revisions.at(-1);
			if (revision === undefined) return undefined;
			let record: MailboxRevisionRecord | undefined;
			try {
				record = await deps.store.getRecord(
					planAlias,
					revision.revisionAlias,
				);
			} catch {
				await failClosed(planAlias, revision.revisionAlias);
				return undefined;
			}
				if (
					record === undefined ||
					deps.now() >= logicalExpiresAt(record)
				) {
					await failClosed(planAlias, revision.revisionAlias);
					return undefined;
					}
					if (record.terminalReservation !== undefined) {
						let cleanupPending = false;
						record = await recoverTerminalReservation(record, () => {
							cleanupPending = true;
						});
						if (cleanupPending) {
							await schedule(planAlias, [], deps.now());
						}
						if (record === undefined || deps.now() >= record.expiresAt) {
						await failClosed(planAlias, revision.revisionAlias);
						return undefined;
					}
				}
				let current = record.revision;
				if (currentFingerprint !== undefined) {
					const fingerprintMatches =
						deps.fingerprints !== undefined &&
						(await deps.fingerprints.matches(
							current.inventoryFingerprint,
							currentFingerprint,
						));
					if (deps.now() >= logicalExpiresAt(record)) {
						await failClosed(planAlias, revision.revisionAlias);
						return undefined;
					}
					if (
						!fingerprintMatches
					) {
					try {
						current = (
							await markRestartRequired(
								record,
								"fingerprint_mismatch",
							)
						).revision;
					} catch {
						await failClosed(planAlias, revision.revisionAlias);
						return undefined;
					}
					}
				}
				if (deps.now() >= logicalExpiresAt(record)) {
					await failClosed(planAlias, revision.revisionAlias);
					return undefined;
				}
				if (record.terminalCleanupPending === true) {
					await schedule(planAlias, [record]);
					if (deps.now() >= logicalExpiresAt(record)) {
						await failClosed(planAlias, revision.revisionAlias);
						try {
							await deps.store.deleteRevision(
								planAlias,
								revision.revisionAlias,
							);
						} catch {
							await schedule(planAlias, [], deps.now());
						}
						return undefined;
					}
				}
				return Object.freeze({
				planAlias,
				revisionAlias: current.revisionAlias,
				revision: current,
				restartRequired: current.restartRequired,
				canExecute: isExecutable(current),
			});
		},
		async removeExecutionState(planAlias, revisionAlias) {
			if (deps.execution.remove === undefined) {
				throw new MailboxLifecycleError("missing_revision");
			}
			await deps.execution.remove(planAlias, revisionAlias);
		},
		reconcile,
		async reconcileAll() {
			let plans: readonly MailboxStoredPlan[];
			try {
				plans = await deps.store.listPlans();
			} catch {
				await signalRestart(
					undefined,
					undefined,
					"storage_failure",
				);
				throw new MailboxLifecycleError("store_corrupt");
			}
			const reconciled = await Promise.all(
				plans.map((plan) => reconcile(plan.planAlias)),
			);
			return Object.freeze(
				reconciled.filter(
					(plan): plan is MailboxLifecyclePlan =>
						plan !== undefined,
				),
			);
		},
	});
}
