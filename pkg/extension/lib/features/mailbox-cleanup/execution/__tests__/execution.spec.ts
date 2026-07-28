import { describe, expect, it } from "bun:test";
import {
	buildMailboxExecutionGraph,
	createMailboxExecutionCoordinator,
	mailboxExecutionChangedAliases,
	type CanonicalMailboxExecutionAction,
	validateCanonicalMailboxExecutionRevision,
} from "../index";
import { createMailboxExecutionJournal } from "../journal";

const PLAN_ALIAS = "plan_0123456789abcdef0123456789abcdef";
const REVISION_ALIAS = "rev_fedcba9876543210fedcba9876543210";
const ACCOUNT_ALIAS = "acct_89abcdef0123456789abcdef01234567";
const RUN_ALIAS = "run_76543210fedcba9876543210fedcba98";
const MESSAGE_ALIAS = "msg_00112233445566778899aabbccddeeff";
const FOLDER_ALIAS = "fld_ffeeddccbbaa99887766554433221100";
const REPLACEMENT_FOLDER_ALIAS = "fld_89abcdef0123456789abcdef01234567";
const SECOND_REPLACEMENT_FOLDER_ALIAS =
	"fld_0123456789abcdef89abcdef01234567";
const LABEL_ALIAS = "lbl_13579bdf02468ace13579bdf02468ace";
const REPLACEMENT_LABEL_ALIAS = "lbl_abcdef0123456789abcdef0123456789";
const FILTER_ALIAS = "flt_2468ace013579bdf2468ace013579bdf";
const REPLACEMENT_FILTER_ALIAS = "flt_def0123456789abcdef0123456789abc";
const EXPECTED_FINGERPRINT = {
	schemaVersion: 1,
	algorithm: "sha256",
	digest: "9".repeat(64),
} as const;

type RecordValue = Readonly<Record<string, unknown>>;

type Command = Readonly<{
	planAlias: string;
	revisionAlias: string;
}>;

type ExecutionResult = Readonly<{
	status: "completed" | "paused" | "failed" | "canceled";
	reasonCode?: string;
	resumable: boolean;
	debriefAvailable?: boolean;
}>;

type JournalSnapshot = Readonly<{
	unitSize?: number;
	units?: readonly Readonly<{
		startIndex: number;
		endIndex: number;
		state: "pending" | "in_flight" | "verified";
	}>[];
	actions: readonly Readonly<{
		index: number;
		state: "pending" | "dispatched" | "observed" | "verified" | "skipped";
	}>[];
}>;

type Journal = Readonly<{
	snapshot(command: Command): Promise<JournalSnapshot | undefined>;
	activeCommands(): Promise<readonly Command[]>;
}>;

type Coordinator = Readonly<{
	start(command: Command): Promise<ExecutionResult>;
	resume(command: Command): Promise<ExecutionResult>;
	cancel(command: Command): Promise<ExecutionResult>;
	status(command: Command): Promise<ExecutionResult>;
	recoverActive(): Promise<readonly Readonly<{
		command: Command;
		result: ExecutionResult;
	}>[]>;
}>;

type DurableStorage = Readonly<{
	read(
		key: string,
	): Promise<Readonly<{ version: number; value: unknown }> | undefined>;
	compareAndSet(
		key: string,
		expectedVersion: number | undefined,
		value: unknown,
	): Promise<boolean>;
}>;

type Provider = Readonly<{
	preflight(input: RecordValue): Promise<RecordValue>;
	dispatch(input: RecordValue): Promise<RecordValue>;
	observe(input: RecordValue): Promise<RecordValue>;
	verifyFresh(input: RecordValue): Promise<RecordValue>;
	observeInbox(input: RecordValue): Promise<RecordValue>;
}>;

type CoordinatorDeps = Readonly<{
	loadRevision(planAlias: string, revisionAlias: string): Promise<unknown>;
	loadBinding(
		planAlias: string,
		revisionAlias: string,
	): Promise<Readonly<{ scope: RecordValue; bindings: RecordValue }>>;
	resolveProvider(scope: RecordValue): Promise<Provider>;
	computeFingerprint(input: RecordValue): Promise<typeof EXPECTED_FINGERPRINT>;
	journal: Journal;
	now(): string;
	generateDebrief(
		input: RecordValue,
	): Promise<Readonly<{ status: "downloaded" | "download_failed" }>>;
	transitionRevision(
		planAlias: string,
		revisionAlias: string,
		expected: "approved" | "in_flight",
		next: "in_flight" | "completed" | "canceled",
	): Promise<void>;
	phaseTimeoutMs?: number;
}>;

const makeJournal = createMailboxExecutionJournal as unknown as (
	deps: Readonly<{ storage: DurableStorage; now(): string }>,
) => Journal;
const makeCoordinator = createMailboxExecutionCoordinator as unknown as (
	deps: CoordinatorDeps,
) => Coordinator;

function deepFreeze<T>(value: T): T {
	if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
		for (const child of Object.values(value as Record<string, unknown>)) {
			deepFreeze(child);
		}
		Object.freeze(value);
	}
	return value;
}

function action(
	type: string,
	index = 0,
	overrides: Record<string, unknown> = {},
): RecordValue {
	return {
		schemaVersion: 1,
		actionAlias: `act_0123456789abcdef01234567${(index + 10)
			.toString(16)
			.padStart(8, "0")}`,
		type,
		...overrides,
	};
}

function messageAlias(index: number): string {
	return index === 0
		? MESSAGE_ALIAS
		: `msg_89abcdef0123456789abcdef${index
				.toString(16)
				.padStart(8, "0")}`;
}

function actionFor(type: string, index = 0): RecordValue {
	switch (type) {
		case "archive":
		case "mark_read":
			return action(type, index, { messageAlias: messageAlias(index) });
		case "move_to_folder":
			return action(type, index, {
				messageAlias: messageAlias(index),
				folderAlias: FOLDER_ALIAS,
			});
		case "create_folder":
			return action(type, index, { folderAlias: FOLDER_ALIAS });
		case "rename_folder":
			return action(type, index, {
				folderAlias: FOLDER_ALIAS,
				replacementFolderAlias: REPLACEMENT_FOLDER_ALIAS,
			});
		case "create_label":
		case "create_category":
			return action(type, index, { labelAlias: LABEL_ALIAS });
		case "rename_label":
		case "rename_category":
			return action(type, index, {
				labelAlias: LABEL_ALIAS,
				replacementLabelAlias: REPLACEMENT_LABEL_ALIAS,
			});
		case "apply_label":
		case "apply_category":
		case "remove_label":
			return action(type, index, {
				messageAlias: messageAlias(index),
				labelAlias: LABEL_ALIAS,
			});
		case "create_filter":
			return action(type, index, { filterAlias: FILTER_ALIAS });
		case "change_filter":
			return action(type, index, {
				filterAlias: FILTER_ALIAS,
				replacementFilterAlias: REPLACEMENT_FILTER_ALIAS,
			});
		case "deactivate_filter":
			return action(type, index, { filterAlias: FILTER_ALIAS });
		default:
			return action(type, index, { messageAlias: MESSAGE_ALIAS });
	}
}

function revision(
	actions: readonly RecordValue[] | undefined = [actionFor("archive")],
	overrides: Record<string, unknown> = {},
): RecordValue {
	const selectedActions = actions ?? [actionFor("archive")];
	const messageAliases = [
		...new Set(
			selectedActions.flatMap((item) =>
				typeof item.messageAlias === "string"
					? [item.messageAlias]
					: [],
			),
		),
	];
	return deepFreeze({
		schemaVersion: 1,
		planAlias: PLAN_ALIAS,
		revisionAlias: REVISION_ALIAS,
		revisionNumber: 2,
		state: "approved",
		restartRequired: false,
		createdAt: "2026-07-27T12:00:00.000Z",
		inventoryFingerprint: EXPECTED_FINGERPRINT,
		cohorts:
			messageAliases.length === 0
				? []
				: [
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
			folderAliases: [
				FOLDER_ALIAS,
				REPLACEMENT_FOLDER_ALIAS,
				SECOND_REPLACEMENT_FOLDER_ALIAS,
			],
			labelAliases: [LABEL_ALIAS, REPLACEMENT_LABEL_ALIAS],
			filterAliases: [FILTER_ALIAS, REPLACEMENT_FILTER_ALIAS],
		},
		actions: selectedActions,
		...overrides,
	});
}

function memoryStorage(
	values = new Map<string, unknown>(),
): DurableStorage &
	Readonly<{
		values: Map<string, unknown>;
		versions: Map<string, number>;
	}> {
	const versions = new Map<string, number>();
	return {
		values,
		versions,
		async read(key) {
			const value = values.get(key);
			return value === undefined
				? undefined
				: {
						version: versions.get(key) ?? 0,
						value: structuredClone(value),
					};
		},
		async compareAndSet(key, expectedVersion, value) {
			const currentVersion = values.has(key)
				? versions.get(key) ?? 0
				: undefined;
			if (currentVersion !== expectedVersion) return false;
			values.set(key, structuredClone(value));
			versions.set(key, (currentVersion ?? -1) + 1);
			return true;
		},
	};
}

function readyPreflight(overrides: Record<string, unknown> = {}): RecordValue {
	return {
		status: "ready",
		providerId: "fake-mail",
		surface: "inbox",
		accountAlias: ACCOUNT_ALIAS,
		locale: "en-US",
		layout: "supported",
		capabilities: [
			"archive",
			"move_to_folder",
			"mark_read",
			"create_folder",
			"rename_folder",
			"create_label",
			"rename_label",
			"apply_label",
			"create_category",
			"rename_category",
			"apply_category",
			"create_filter",
			"change_filter",
			"deactivate_filter",
		],
		targets: "available",
		...overrides,
	};
}

function harness(options: {
	revision?: RecordValue;
	preflight?: RecordValue;
	fingerprint?: typeof EXPECTED_FINGERPRINT;
	fingerprintAtCall?(
		call: number,
	): Readonly<{
		schemaVersion: 1;
		algorithm: "sha256";
		digest: string;
	}>;
	verifyStatus?: "verified" | "mismatch" | "ambiguous" | "timeout";
	verifyDeltaAliases?: readonly string[];
	omitVerifyDelta?: boolean;
	observeStatus?: "observed" | "ambiguous";
	inboxCount?: number;
	storage?: ReturnType<typeof memoryStorage>;
	throwAfterDispatch?: boolean;
	throwDuringVerify?: boolean;
	dispatchGate?: Promise<void>;
	onDispatch?(): void;
	observeGate?: Promise<void>;
	onObserve?(): void;
	observeReasonCode?: string;
	loadRevisionGate?: Promise<void>;
	onLoadRevision?(): void;
	loadRevisionValue?(): RecordValue;
	transitionRevision?(
		expected: "approved" | "in_flight",
		next: "in_flight" | "completed" | "canceled",
	): Promise<void>;
	generateDebrief?(): Promise<
		void | Readonly<{ status: "downloaded" | "download_failed" }>
	>;
	stallPhase?:
		| "preflight"
		| "dispatch"
		| "observe"
		| "verify"
		| "inbox";
	phaseTimeoutMs?: number;
} = {}) {
	const events: string[] = [];
	const storage = options.storage ?? memoryStorage();
	const journal = makeJournal({
		storage,
		now: () => "2026-07-27T12:30:00.000Z",
	});
	const selectedRevision = options.revision ?? revision();
	const selectedActions =
		(selectedRevision.actions as readonly RecordValue[] | undefined) ?? [];
	const selectedMessageAliases = selectedActions.flatMap((item) =>
		typeof item.messageAlias === "string" ? [item.messageAlias] : [],
	);
	const inputIndex = (input: RecordValue): number => {
		if (typeof input.index === "number") return input.index;
		const candidate =
			input.action !== null && typeof input.action === "object"
				? (input.action as RecordValue)
				: input;
		return selectedActions.findIndex(
			(item) => item.actionAlias === candidate.actionAlias,
		);
	};
	let dispatches = 0;
	let fingerprintCalls = 0;
	let verifiedActions = 0;
	const fingerprintVersion = (version: number) =>
		version === 0
			? EXPECTED_FINGERPRINT
			: Object.freeze({
					schemaVersion: 1 as const,
					algorithm: "sha256" as const,
					digest: (version % 15 + 1).toString(16).repeat(64),
				});
	const stalled = (): Promise<RecordValue> =>
		new Promise(() => undefined);
	const provider: Provider = {
		async preflight() {
			events.push("preflight");
			if (options.stallPhase === "preflight") return stalled();
			return options.preflight ?? readyPreflight();
		},
		async dispatch(input) {
			events.push(`dispatch:${inputIndex(input)}`);
			dispatches += 1;
			options.onDispatch?.();
			if (options.stallPhase === "dispatch") return stalled();
			await options.dispatchGate;
			if (options.throwAfterDispatch) {
				throw Object.freeze({
					reasonCode: "worker_suspended",
					checkpoint: "after_dispatch",
				});
			}
			return { status: "dispatched" };
		},
		async observe(input) {
			events.push(`observe:${inputIndex(input)}`);
			options.onObserve?.();
			if (options.stallPhase === "observe") return stalled();
			await options.observeGate;
			if (options.observeReasonCode !== undefined) {
				throw Object.freeze({
					reasonCode: options.observeReasonCode,
				});
			}
			return options.observeStatus === "ambiguous"
				? {
						status: "ambiguous",
						reasonCode: "provider_partial",
					}
				: {
						status: "observed",
						observedAt: "2026-07-27T12:30:01.000Z",
					};
		},
		async verifyFresh(input) {
			events.push(`verify:${inputIndex(input)}`);
			if (options.stallPhase === "verify") return stalled();
			if (options.throwDuringVerify) {
				throw Object.freeze({
					reasonCode: "worker_suspended",
					checkpoint: "during_verify",
				});
			}
			if (
				options.verifyStatus !== undefined &&
				options.verifyStatus !== "verified"
			) {
				return {
					status: options.verifyStatus,
					reasonCode:
						options.verifyStatus === "mismatch"
							? "verification_mismatch"
							: options.verifyStatus === "timeout"
								? "provider_timeout"
								: "provider_partial",
				};
			}
			const action = input.action as CanonicalMailboxExecutionAction;
			const changedAliases =
				options.verifyDeltaAliases ??
				mailboxExecutionChangedAliases(action);
			if (changedAliases.length > 0) verifiedActions += 1;
			return {
				status: "verified",
				verifiedAt: "2026-07-27T12:30:02.000Z",
				...(options.omitVerifyDelta
					? {}
					: {
							delta: {
								schemaVersion: 1,
								scope: "entire_fingerprint",
								actionAlias: action.actionAlias,
								changedAliases,
							},
						}),
			};
		},
		async observeInbox() {
			events.push("observe-inbox");
			if (options.stallPhase === "inbox") return stalled();
			return {
				status: "observed",
				count: options.inboxCount ?? 1,
				observedAt: "2026-07-27T12:30:03.000Z",
			};
		},
	};
	const coordinator = makeCoordinator({
		async loadRevision(planAlias, revisionAlias) {
			events.push("load-revision");
			options.onLoadRevision?.();
			await options.loadRevisionGate;
			expect({ planAlias, revisionAlias }).toEqual({
				planAlias: PLAN_ALIAS,
				revisionAlias: REVISION_ALIAS,
			});
			return options.loadRevisionValue?.() ?? selectedRevision;
		},
		async loadBinding() {
			events.push("load-binding");
			return {
				scope: {
					providerId: "fake-mail",
					surface: "inbox",
					accountAlias: ACCOUNT_ALIAS,
					runAlias: RUN_ALIAS,
					revisionAlias: REVISION_ALIAS,
				},
				bindings: {
					[MESSAGE_ALIAS]: "raw-message-1",
					...Object.fromEntries(
						selectedMessageAliases.map((alias, index) => [
							alias,
							`raw-message-${index + 1}`,
						]),
					),
					[FOLDER_ALIAS]: "raw-folder-1",
					[REPLACEMENT_FOLDER_ALIAS]: "raw-folder-2",
					[SECOND_REPLACEMENT_FOLDER_ALIAS]: "raw-folder-3",
					[LABEL_ALIAS]: "raw-label-1",
					[REPLACEMENT_LABEL_ALIAS]: "raw-label-2",
					[FILTER_ALIAS]: "raw-filter-1",
					[REPLACEMENT_FILTER_ALIAS]: "raw-filter-2",
				},
			};
		},
		async resolveProvider() {
			events.push("resolve-provider");
			return provider;
		},
		async computeFingerprint() {
			events.push("fresh-fingerprint");
			fingerprintCalls += 1;
			return (
				options.fingerprintAtCall?.(fingerprintCalls) ??
				options.fingerprint ??
				fingerprintVersion(verifiedActions)
			);
		},
		journal,
		now: () => "2026-07-27T12:30:00.000Z",
		async generateDebrief() {
			events.push("debrief");
			const generated = await options.generateDebrief?.();
			return generated ?? { status: "downloaded" as const };
		},
		async transitionRevision(
			planAlias,
			revisionAlias,
			expected,
			next,
		) {
			expect({ planAlias, revisionAlias }).toEqual(command);
			events.push(`lifecycle:${expected}->${next}`);
			await options.transitionRevision?.(expected, next);
		},
		phaseTimeoutMs: options.phaseTimeoutMs,
	});
	return {
		coordinator,
		events,
		journal,
		storage,
		dispatches: () => dispatches,
		fingerprintCalls: () => fingerprintCalls,
	};
}

const command = Object.freeze({
	planAlias: PLAN_ALIAS,
	revisionAlias: REVISION_ALIAS,
});

async function seedInterruptedAction(
	storage: ReturnType<typeof memoryStorage>,
	state: "dispatched" | "observed",
): Promise<void> {
	const journal = createMailboxExecutionJournal({
		storage,
		now: () => "2026-07-27T12:30:00.000Z",
	});
	await journal.initialize(command, {
		accountAlias: ACCOUNT_ALIAS,
		revision: validateCanonicalMailboxExecutionRevision(revision()),
		order: [0],
	});
	const lease = await journal.acquireLease(
		command,
		ACCOUNT_ALIAS,
		"worker:seed",
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
	await journal.transitionAction(
		command,
		lease!,
		0,
		"pending",
		"dispatched",
	);
	if (state === "observed") {
		await journal.transitionAction(
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
	}
	await journal.releaseLease(command, lease!);
}

describe("mailbox execution public contract", () => {
	it("executes the exact immutable approved typed revision and rejects all other revision authority before provider work", async () => {
		const invalid = [
			revision(undefined, { state: "draft" }),
			revision(undefined, { state: "in_flight" }),
			revision(undefined, { restartRequired: true }),
			revision(undefined, { extra: "authority" }),
			revision([
				action("archive", 0, {
					messageAlias: MESSAGE_ALIAS,
					selector: "#mail-row",
				}),
			]),
			revision([
				action("archive", 0, {
					messageAlias: MESSAGE_ALIAS,
					command: "click delete",
				}),
			]),
			revision([
				{
					...actionFor("archive"),
					actionAlias: "act_11111111111111111111111111111111",
				},
			]),
		];

		for (const candidate of invalid) {
			const run = harness({ revision: candidate });
			const result = await run.coordinator.start(command);
			expect(result).toMatchObject({
				status: "failed",
				resumable: false,
			});
			expect(run.dispatches()).toBe(0);
			expect(
				run.events.some((event) => event.startsWith("lifecycle:")),
			).toBe(false);
			expect(run.events).not.toContain("preflight");
		}

		const accepted = harness();
		await expect(accepted.coordinator.start(command)).resolves.toMatchObject({
			status: "completed",
			resumable: false,
		});
		expect(accepted.dispatches()).toBe(1);
	});

	it("moves the accepted lifecycle through in-flight to its terminal state", async () => {
		const completed = harness();
		await completed.coordinator.start(command);
		expect(completed.events).toContain(
			"lifecycle:approved->in_flight",
		);
		expect(completed.events).toContain(
			"lifecycle:in_flight->completed",
		);
		expect(completed.events.indexOf("preflight")).toBeLessThan(
			completed.events.indexOf("lifecycle:approved->in_flight"),
		);
		expect(
			completed.events.indexOf("lifecycle:approved->in_flight"),
		).toBeLessThan(completed.events.indexOf("dispatch:0"));
		expect(completed.events.indexOf("observe-inbox")).toBeLessThan(
			completed.events.indexOf("lifecycle:in_flight->completed"),
		);
	});

	it("allows every non-destructive typed action and rejects every delete or trash variant before mutation", async () => {
		const allowed = [
			"archive",
			"move_to_folder",
			"mark_read",
			"create_folder",
			"rename_folder",
			"create_label",
			"rename_label",
			"apply_label",
			"create_category",
			"rename_category",
			"apply_category",
			"create_filter",
			"change_filter",
			"deactivate_filter",
		];
		for (const type of allowed) {
			const run = harness({ revision: revision([actionFor(type)]) });
			await expect(run.coordinator.start(command)).resolves.toMatchObject({
				status: "completed",
			});
			expect(run.dispatches()).toBe(1);
		}

		const forbidden = [
			"delete",
			"delete_message",
			"trash",
			"move_to_trash",
			"empty_trash",
			"permanently_delete",
			"delete_folder",
			"delete_label",
			"delete_category",
			"delete_filter",
			"remove_label",
		];
		for (const type of forbidden) {
			const run = harness({ revision: revision([actionFor(type)]) });
			await expect(run.coordinator.start(command)).resolves.toMatchObject({
				status: "failed",
				resumable: false,
			});
			expect(run.dispatches()).toBe(0);
			expect(
				run.events.some((event) => event.startsWith("lifecycle:")),
			).toBe(false);
			expect(run.events).not.toContain("preflight");
		}
	});

	it("fails closed on every preflight dimension immediately and repeats the complete preflight on resume", async () => {
		const cases: readonly [string, RecordValue, string][] = [
			["binding", { status: "blocked", reasonCode: "stale_binding" }, "stale_binding"],
			["provider", { status: "blocked", reasonCode: "provider_refused" }, "provider_refused"],
			["surface", { ...readyPreflight(), surface: "settings" }, "layout_mismatch"],
			["account", { ...readyPreflight(), accountAlias: "acct_0123456789abcdef89abcdef01234567" }, "wrong_account"],
			["locale", { ...readyPreflight(), locale: "fr-FR" }, "unsupported_locale"],
			["layout", { ...readyPreflight(), layout: "unsupported" }, "layout_mismatch"],
			["capabilities", { ...readyPreflight(), capabilities: [] }, "provider_refused"],
			["targets", { ...readyPreflight(), targets: "missing" }, "not_found"],
		];
		for (const [name, preflight, reasonCode] of cases) {
			const run = harness({ preflight });
			const result = await run.coordinator.start(command);
			expect({
				name,
				status: result.status,
				reasonCode: result.reasonCode,
				resumable: result.resumable,
			}).toMatchObject({
				name,
				status: "paused",
				reasonCode,
				resumable: true,
			});
			expect(run.dispatches()).toBe(0);
			expect(
				run.events.some((event) => event.startsWith("lifecycle:")),
			).toBe(false);
		}

		for (const capability of readyPreflight().capabilities as readonly string[]) {
			const capabilities = (
				readyPreflight().capabilities as readonly string[]
			).filter((candidate) => candidate !== capability);
			const run = harness({
				revision: revision([actionFor(capability)]),
				preflight: readyPreflight({ capabilities }),
			});
			await expect(run.coordinator.start(command)).resolves.toMatchObject({
				status: "paused",
				resumable: true,
			});
			expect(run.dispatches()).toBe(0);
		}

		const drift = harness({
			fingerprint: {
				...EXPECTED_FINGERPRINT,
				digest: "a".repeat(64),
			},
		});
		await expect(drift.coordinator.start(command)).resolves.toMatchObject({
			status: "failed",
			reasonCode: "stale_binding",
			resumable: false,
			debriefAvailable: true,
		});
		expect(drift.dispatches()).toBe(0);
		expect(
			drift.events.some((event) => event.startsWith("lifecycle:")),
		).toBe(true);

	});

	it("builds one deterministic dependency order and rejects invalid graphs before mutation", async () => {
		const create = actionFor("create_folder", 0);
		const move = {
			...actionFor("move_to_folder", 1),
			dependsOn: [create.actionAlias],
		};
		const run = harness({ revision: revision([move, create]) });
		await run.coordinator.start(command);
		expect(run.events.filter((event) => event.startsWith("dispatch:"))).toEqual([
			"dispatch:1",
			"dispatch:0",
		]);
		const reversedMessageActions =
			validateCanonicalMailboxExecutionRevision(
				revision([
					actionFor("archive", 0),
					{
						...actionFor("move_to_folder", 1),
						messageAlias: MESSAGE_ALIAS,
					},
					{
						...actionFor("apply_label", 2),
						messageAlias: MESSAGE_ALIAS,
					},
					{
						...actionFor("mark_read", 3),
						messageAlias: MESSAGE_ALIAS,
					},
				]),
			).actions;
		expect(
			buildMailboxExecutionGraph(reversedMessageActions),
		).toEqual([2, 3, 1, 0]);
		expect(() =>
			buildMailboxExecutionGraph(
				validateCanonicalMailboxExecutionRevision(
					revision([
						actionFor("archive", 0),
						{
							...actionFor("mark_read", 1),
							messageAlias: MESSAGE_ALIAS,
							dependsOn: [
								actionFor("archive", 0)
									.actionAlias,
							],
						},
					]),
				).actions,
			),
		).toThrow();

		const a = actionFor("create_folder", 0);
		const b = actionFor("rename_folder", 1);
		const invalid = [
			revision([
				{ ...a, dependsOn: [b.actionAlias] },
				{ ...b, dependsOn: [a.actionAlias] },
			]),
			revision([
				actionFor("rename_folder", 0),
				{
					...actionFor("rename_folder", 1),
					replacementFolderAlias:
						SECOND_REPLACEMENT_FOLDER_ALIAS,
				},
			]),
			revision([
				{
					...actionFor("move_to_folder", 0),
					dependsOn: ["act_89abcdef0123456789abcdef01234567"],
				},
			]),
		];
		for (const candidate of invalid) {
			const rejected = harness({ revision: candidate });
			await expect(rejected.coordinator.start(command)).resolves.toMatchObject({
				status: "failed",
				resumable: false,
			});
			expect(rejected.dispatches()).toBe(0);
		}
	});

	it("persists an evolving verified fingerprint and rejects unrelated drift before the next dispatch", async () => {
		const afterFirst = {
			...EXPECTED_FINGERPRINT,
			digest: "a".repeat(64),
		};
		const completed = harness({
			revision: revision([
				actionFor("archive", 0),
				actionFor("mark_read", 1),
			]),
			fingerprintAtCall: (call) =>
				call === 1
					? EXPECTED_FINGERPRINT
					: call < 4
						? afterFirst
						: {
								...EXPECTED_FINGERPRINT,
								digest: "b".repeat(64),
							},
		});

		await expect(completed.coordinator.start(command)).resolves.toMatchObject({
			status: "completed",
		});
		expect(completed.dispatches()).toBe(2);
		expect(completed.fingerprintCalls()).toBe(4);

		const drifted = harness({
			revision: revision([
				actionFor("archive", 0),
				actionFor("mark_read", 1),
			]),
			fingerprintAtCall: (call) =>
				call < 3
					? call === 1
						? EXPECTED_FINGERPRINT
						: afterFirst
					: {
							...EXPECTED_FINGERPRINT,
							digest: "b".repeat(64),
						},
		});
		await expect(drifted.coordinator.start(command)).resolves.toMatchObject({
			status: "failed",
			reasonCode: "stale_binding",
			resumable: false,
		});
		expect(drifted.dispatches()).toBe(1);
	});

	it("does not advance authority for bare, missing, or extra whole-scope delta evidence", async () => {
		for (const options of [
			{ omitVerifyDelta: true },
			{ verifyDeltaAliases: [] },
			{
				verifyDeltaAliases: [
					MESSAGE_ALIAS,
					FOLDER_ALIAS,
				],
			},
		]) {
			const run = harness(options);
			await expect(run.coordinator.start(command)).resolves.toMatchObject({
				status: "failed",
				resumable: false,
			});
			await expect(run.journal.snapshot(command)).resolves.toMatchObject({
				authorityFingerprint: EXPECTED_FINGERPRINT,
				actions: [
					{
						state: "needs_review",
						result: { status: "needs_review" },
					},
				],
			});
		}
	});

	it("requires relational destination counts in move and label deltas while excluding create-only targets", () => {
		expect(
			mailboxExecutionChangedAliases(
				actionFor("move_to_folder") as CanonicalMailboxExecutionAction,
			),
		).toEqual([FOLDER_ALIAS, MESSAGE_ALIAS].sort());
		expect(
			mailboxExecutionChangedAliases(
				actionFor("apply_label") as CanonicalMailboxExecutionAction,
			),
		).toEqual([LABEL_ALIAS, MESSAGE_ALIAS].sort());
		expect(
			mailboxExecutionChangedAliases(
				actionFor("create_folder") as CanonicalMailboxExecutionAction,
			),
		).toEqual([]);
	});

	it("persists pending, dispatched, observed, and verified around each action and recovers dispatched-before-observed without redispatch", async () => {
		const storage = memoryStorage();
		await seedInterruptedAction(storage, "dispatched");

		const restarted = harness({
			storage,
			loadRevisionValue: () =>
				revision(undefined, { state: "in_flight" }),
		});
		await restarted.coordinator.resume(command);
		expect(restarted.dispatches()).toBe(0);
		for (const event of [
			"load-revision",
			"load-binding",
			"resolve-provider",
			"preflight",
			"fresh-fingerprint",
		]) {
			expect(restarted.events).toContain(event);
		}
		expect(restarted.events.indexOf("preflight")).toBeLessThan(
			restarted.events.indexOf("observe:0"),
		);
		expect(restarted.events).toContain("observe:0");
		expect(restarted.events).toContain("verify:0");
		expect(await restarted.journal.snapshot(command)).toMatchObject({
			actions: [{ index: 0, state: "verified" }],
		});
	});

	it("recovers observed-before-verified without redispatch or re-observation", async () => {
		const storage = memoryStorage();
		await seedInterruptedAction(storage, "observed");

		const restarted = harness({
			storage,
			loadRevisionValue: () =>
				revision(undefined, { state: "in_flight" }),
		});
		await restarted.coordinator.resume(command);
		expect(restarted.dispatches()).toBe(0);
		expect(restarted.events).not.toContain("observe:0");
		expect(restarted.events).toContain("verify:0");
	});

	it("enumerates an orphaned run durably and fences two recovery instances", async () => {
		const storage = memoryStorage();
		await seedInterruptedAction(storage, "dispatched");
		let releaseObservation!: () => void;
		const observationGate = new Promise<void>((resolve) => {
			releaseObservation = resolve;
		});
		let observationStarted!: () => void;
		const started = new Promise<void>((resolve) => {
			observationStarted = resolve;
		});
		const revisionInFlight = () =>
			revision(undefined, { state: "in_flight" });
		const first = harness({
			storage,
			loadRevisionValue: revisionInFlight,
			observeGate: observationGate,
			onObserve: observationStarted,
		});
		const second = harness({
			storage,
			loadRevisionValue: revisionInFlight,
		});

		const recovering = first.coordinator.recoverActive();
		await started;
		const competing = await second.coordinator.recoverActive();
		expect(competing).toEqual([
			{
				command,
				result: {
					status: "paused",
					reasonCode: "worker_suspended",
					resumable: true,
				},
			},
		]);
		releaseObservation();
		await expect(recovering).resolves.toMatchObject([
			{
				command,
				result: { status: "completed" },
			},
		]);
		expect(first.dispatches()).toBe(0);
		expect(second.dispatches()).toBe(0);
		await expect(first.journal.activeCommands()).resolves.toEqual([]);
	});

	it("uses one revision/account lease and makes duplicate Start, Resume, and background deliveries idempotent", async () => {
		const run = harness();
		const [first, duplicateStart, duplicateResume] = await Promise.all([
			run.coordinator.start(command),
			run.coordinator.start(command),
			run.coordinator.resume(command),
		]);
		expect(first).toEqual(duplicateStart);
		expect(first).toEqual(duplicateResume);
		expect(run.dispatches()).toBe(1);
		expect(
			run.events.filter(
				(event) => event === "lifecycle:approved->in_flight",
			),
		).toHaveLength(1);
		expect(
			run.events.filter(
				(event) => event === "lifecycle:in_flight->completed",
			),
		).toHaveLength(1);
	});

	it("heartbeats the fenced lease immediately after the dispatch checkpoint and before provider mutation", async () => {
		const durable = memoryStorage();
		let dispatchedWrites = 0;
		const storage: ReturnType<typeof memoryStorage> = {
			...durable,
			async compareAndSet(key, expectedVersion, value) {
				const actions =
					value !== null && typeof value === "object"
						? (value as {
								actions?: readonly { state?: unknown }[];
							}).actions
						: undefined;
				const committed = await durable.compareAndSet(
					key,
					expectedVersion,
					value,
				);
				if (committed && actions?.[0]?.state === "dispatched") {
					dispatchedWrites += 1;
				}
				return committed;
			},
		};
		const run = harness({
			storage,
			onDispatch() {
				expect(dispatchedWrites).toBeGreaterThanOrEqual(2);
			},
		});

		await expect(run.coordinator.start(command)).resolves.toMatchObject({
			status: "completed",
		});
		expect(run.dispatches()).toBe(1);
	});

	it("fails closed on malformed durable journal state without dispatching or leaking persisted content", async () => {
		const storage = memoryStorage();
		const interrupted = harness({ storage, throwAfterDispatch: true });
		await interrupted.coordinator.start(command);
		expect(storage.values.size).toBeGreaterThan(0);
		for (const key of storage.values.keys()) {
			storage.values.set(key, {
				state: "dispatched",
				index: -1,
				raw: "private provider row selector",
			});
		}

		const restarted = harness({ storage });
		const result = await restarted.coordinator.resume(command);
		expect(result).toMatchObject({
			status: "failed",
			resumable: false,
		});
		expect(JSON.stringify(result)).not.toContain("private provider row selector");
		expect(restarted.dispatches()).toBe(0);
		expect(restarted.events).not.toContain("preflight");
	});

	it("fails closed when a shape-valid journal claims verified work without the required observation, verification, and result", async () => {
		const storage = memoryStorage();
		const interrupted = harness({ storage, throwAfterDispatch: true });
		await interrupted.coordinator.start(command);
		for (const [key, value] of storage.values) {
			const corrupted = structuredClone(value) as Record<string, unknown>;
			if (!Array.isArray(corrupted.actions)) continue;
			const actions = corrupted.actions as Array<Record<string, unknown>>;
			actions[0] = {
				...actions[0],
				state: "verified",
			};
			storage.values.set(key, corrupted);
		}

		const restarted = harness({ storage });
		const result = await restarted.coordinator.resume(command);
		expect(result).toMatchObject({
			status: "failed",
			resumable: false,
		});
		expect(restarted.dispatches()).toBe(0);
		expect(restarted.events).not.toContain("preflight");
		expect(restarted.events).not.toContain("debrief");
	});

	it("rejects impossible durable lease, unit, cancellation, and terminal combinations before provider work", async () => {
		const initialized = memoryStorage();
		const blocked = harness({
			storage: initialized,
			preflight: {
				status: "blocked",
				reasonCode: "blocked_prompt",
				prompt: "login",
			},
		});
		await blocked.coordinator.start(command);
		expect(initialized.values.size).toBe(2);
		const stored = [...initialized.values.values()].find(
			(value) =>
				value !== null &&
				typeof value === "object" &&
				Array.isArray((value as { actions?: unknown }).actions),
		);
		expect(stored).toBeDefined();

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
						owner: 42,
						expiresAt: "not-a-timestamp",
					};
				},
			},
			{
				name: "completed terminal with pending actions",
				mutate(snapshot) {
					snapshot.terminalStatus = "completed";
					snapshot.lifecycleState = "completed";
				},
			},
			{
				name: "unknown terminal reason",
				mutate(snapshot) {
					snapshot.terminalStatus = "failed";
					snapshot.terminalReasonCode =
						"private provider row selector";
				},
			},
		];

		for (const corruption of corruptions) {
			const storage = memoryStorage();
			for (const [key, value] of initialized.values) {
				const snapshot = structuredClone(value) as Record<string, unknown>;
				corruption.mutate(snapshot);
				storage.values.set(key, snapshot);
			}
			const restarted = harness({ storage });
			const result = await restarted.coordinator.resume(command);
			expect({
				name: corruption.name,
				status: result.status,
				resumable: result.resumable,
			}).toEqual({
				name: corruption.name,
				status: "failed",
				resumable: false,
			});
			expect(`${corruption.name}:${JSON.stringify(result)}`).not.toContain(
				"private provider row selector",
			);
			expect([corruption.name, restarted.dispatches()]).toEqual([
				corruption.name,
				0,
			]);
			expect([corruption.name, ...restarted.events]).not.toContain(
				"preflight",
			);
			expect([corruption.name, ...restarted.events]).not.toContain(
				"debrief",
			);
		}
	});

	it("stops on login, MFA, CAPTCHA, consent, and conditional-access prompts without dispatch", async () => {
		for (const prompt of [
			"login",
			"mfa",
			"captcha",
			"consent",
			"conditional_access",
		]) {
			const run = harness({
				preflight: {
					status: "blocked",
					reasonCode: "blocked_prompt",
					prompt,
				},
			});
			await expect(run.coordinator.start(command)).resolves.toEqual({
				status: "paused",
				reasonCode: "blocked_prompt",
				resumable: true,
			});
			expect(run.dispatches()).toBe(0);
		}
	});

	it("after cancel, failure, or ambiguity observes the dispatched action, dispatches nothing later, and skips untouched actions", async () => {
		const actions = [
			actionFor("archive", 0),
			actionFor("mark_read", 1),
			actionFor("apply_label", 2),
		];
		for (const verifyStatus of ["mismatch", "ambiguous", "timeout"] as const) {
			const run = harness({
				revision: revision(actions),
				verifyStatus,
			});
			const result = await run.coordinator.start(command);
			expect(result.status).toBe("failed");
			expect(run.dispatches()).toBe(1);
			expect(await run.journal.snapshot(command)).toMatchObject({
				actions: [
					{ index: 0, state: "needs_review" },
					{ index: 1, state: "skipped" },
					{ index: 2, state: "skipped" },
				],
			});
		}

		let releaseDispatch!: () => void;
		const dispatchGate = new Promise<void>((resolve) => {
			releaseDispatch = resolve;
		});
		let reportDispatch!: () => void;
		const dispatchStarted = new Promise<void>((resolve) => {
			reportDispatch = resolve;
		});
		const gatedCancelRun = harness({
			revision: revision(actions),
			dispatchGate,
			onDispatch: reportDispatch,
		});
		const first = gatedCancelRun.coordinator.start(command);
		await dispatchStarted;
		const canceled = gatedCancelRun.coordinator.cancel(command);
		releaseDispatch();
		await Promise.all([first, canceled]);
		expect(gatedCancelRun.dispatches()).toBe(1);
		expect(gatedCancelRun.events).toContain(
			"lifecycle:in_flight->canceled",
		);
		const snapshot = await gatedCancelRun.journal.snapshot(command);
		expect(snapshot?.actions.slice(1).every((item) => item.state === "skipped")).toBe(true);
	});

	it("does not lose an immediate Cancel that arrives while Start is still loading the accepted revision", async () => {
		let releaseLoad!: () => void;
		const loadRevisionGate = new Promise<void>((resolve) => {
			releaseLoad = resolve;
		});
		let reportLoad!: () => void;
		const loadStarted = new Promise<void>((resolve) => {
			reportLoad = resolve;
		});
		const run = harness({
			revision: revision([
				actionFor("archive", 0),
				actionFor("mark_read", 1),
			]),
			loadRevisionGate,
			onLoadRevision: reportLoad,
		});
		const starting = run.coordinator.start(command);
		await loadStarted;
		const canceling = run.coordinator.cancel(command);
		releaseLoad();
		await expect(starting).resolves.toMatchObject({
			status: "canceled",
		});
		await expect(canceling).resolves.toMatchObject({
			status: "canceled",
		});
		expect(run.dispatches()).toBe(0);
	});

	it("bounds every never-settling provider phase and lets Cancel stop an active dispatch", async () => {
		const phases = [
			"preflight",
			"dispatch",
			"observe",
			"verify",
			"inbox",
		] as const;
		const expected: Readonly<
			Record<
				(typeof phases)[number],
				ExecutionResult["status"]
			>
		> = {
			preflight: "failed",
			dispatch: "failed",
			observe: "failed",
			verify: "failed",
			inbox: "completed",
		};
		for (const phase of phases) {
			const run = harness({
				stallPhase: phase,
				phaseTimeoutMs: 10,
			});
			const result = await run.coordinator.start(command);
			expect({
				phase,
				status: result.status,
				reasonCode: result.reasonCode,
			}).toEqual({
				phase,
				status: expected[phase],
				reasonCode:
					phase === "inbox" ? undefined : "provider_timeout",
			});
		}

		let reportDispatch!: () => void;
		const dispatchStarted = new Promise<void>((resolve) => {
			reportDispatch = resolve;
		});
		const canceled = harness({
			stallPhase: "dispatch",
			phaseTimeoutMs: 100,
			onDispatch: reportDispatch,
		});
		const starting = canceled.coordinator.start(command);
		await dispatchStarted;
		await expect(canceled.coordinator.cancel(command)).resolves.toMatchObject({
			status: "paused",
			reasonCode: "canceled",
		});
		await expect(starting).resolves.toMatchObject({
			status: "canceled",
			reasonCode: "canceled",
			resumable: false,
		});
		expect(canceled.dispatches()).toBe(1);
	});

	it("returns a typed internal failure when a post-mutation journal checkpoint cannot be stored", async () => {
		const raw = "private provider row selector";
		const base = memoryStorage();
		let rejected = false;
		const storage: ReturnType<typeof memoryStorage> = {
			...base,
			async compareAndSet(key, expectedVersion, value) {
				const actions =
					value !== null && typeof value === "object"
						? (value as { actions?: readonly { state?: unknown }[] }).actions
						: undefined;
				if (!rejected && actions?.[0]?.state === "observed") {
					rejected = true;
					throw new Error(raw);
				}
				return base.compareAndSet(key, expectedVersion, value);
			},
		};
		const run = harness({ storage });

		const result = await run.coordinator.start(command);

		expect(result).toEqual({
			status: "failed",
			reasonCode: "internal_failure",
			resumable: false,
			debriefAvailable: true,
		});
		expect(JSON.stringify(result)).not.toContain(raw);
		expect(rejected).toBe(true);
		expect(run.dispatches()).toBe(1);
		expect(run.events).not.toContain("verify:0");
		expect(run.events).toContain("debrief");
		expect(run.events).toContain("lifecycle:in_flight->canceled");
	});

	it("reconciles a crash after external terminal transition without redispatching", async () => {
		const storage = memoryStorage();
		let externalState:
			| "approved"
			| "in_flight"
			| "completed"
			| "canceled" = "approved";
		let crashOnce = true;
		const loadRevisionValue = () =>
			revision(undefined, { state: externalState });
		const transitionRevision = async (
			expected: "approved" | "in_flight",
			next: "in_flight" | "completed" | "canceled",
		) => {
			expect(externalState).toBe(expected);
			externalState = next;
			if (next === "completed" && crashOnce) {
				crashOnce = false;
				throw new Error("simulated terminal crash");
			}
		};
		const crashed = harness({
			storage,
			loadRevisionValue,
			transitionRevision,
		});
		await expect(crashed.coordinator.start(command)).resolves.toEqual({
			status: "failed",
			reasonCode: "internal_failure",
			resumable: false,
		});
		expect(String(externalState)).toBe("completed");
		expect(crashed.dispatches()).toBe(1);

		const restarted = harness({
			storage,
			loadRevisionValue,
			transitionRevision,
		});
		await expect(restarted.coordinator.resume(command)).resolves.toEqual({
			status: "completed",
			resumable: false,
			debriefAvailable: true,
		});
		expect(restarted.dispatches()).toBe(0);
		expect(restarted.events).toContain("debrief");
	});

	it("recovers a crash immediately after durable terminal intent preparation", async () => {
		const durable = memoryStorage();
		let injected = false;
		const storage: ReturnType<typeof memoryStorage> = {
			...durable,
			async compareAndSet(key, expectedVersion, value) {
				const snapshot =
					value !== null && typeof value === "object"
						? value as Record<string, unknown>
						: undefined;
				const intent =
					snapshot?.lifecycleIntent !== null &&
					typeof snapshot?.lifecycleIntent === "object"
						? snapshot.lifecycleIntent as Record<string, unknown>
						: undefined;
				if (
					!injected &&
					intent?.next === "completed" &&
					snapshot?.terminalStatus === undefined
				) {
					const committed = await durable.compareAndSet(
						key,
						expectedVersion,
						value,
					);
					if (committed) {
						injected = true;
						throw new Error("simulated prepare crash");
					}
					return false;
				}
				return durable.compareAndSet(key, expectedVersion, value);
			},
		};
		let externalState:
			| "approved"
			| "in_flight"
			| "completed"
			| "canceled" = "approved";
		const loadRevisionValue = () =>
			revision(undefined, { state: externalState });
		const transitionRevision = async (
			expected: "approved" | "in_flight",
			next: "in_flight" | "completed" | "canceled",
		) => {
			expect(externalState).toBe(expected);
			externalState = next;
		};

		const crashed = harness({
			storage,
			loadRevisionValue,
			transitionRevision,
		});
		await expect(crashed.coordinator.start(command)).resolves.toEqual({
			status: "failed",
			reasonCode: "internal_failure",
			resumable: false,
		});
		expect(String(externalState)).toBe("in_flight");

		const restarted = harness({
			storage,
			loadRevisionValue,
			transitionRevision,
		});
		await expect(restarted.coordinator.resume(command)).resolves.toEqual({
			status: "completed",
			resumable: false,
			debriefAvailable: true,
		});
		expect(restarted.dispatches()).toBe(0);
		expect(String(externalState)).toBe("completed");
	});

	it("reports debrief availability from durable generation status after restart", async () => {
		const storage = memoryStorage();
		const failedDebrief = harness({
			storage,
			async generateDebrief() {
				throw new Error("download unavailable");
			},
		});
		await expect(failedDebrief.coordinator.start(command)).resolves.toEqual({
			status: "completed",
			resumable: false,
			debriefAvailable: false,
		});

		const restarted = harness({ storage });
		await expect(restarted.coordinator.status(command)).resolves.toEqual({
			status: "completed",
			resumable: false,
			debriefAvailable: false,
		});
		expect(restarted.events).not.toContain("debrief");
	});

	it("retries a durable debrief whose first download did not complete", async () => {
		const storage = memoryStorage();
		const first = harness({
			storage,
			async generateDebrief() {
				return { status: "download_failed" as const };
			},
		});
		await expect(first.coordinator.start(command)).resolves.toEqual({
			status: "completed",
			resumable: false,
			debriefAvailable: false,
		});

		const restarted = harness({
			storage,
			loadRevisionValue: () =>
				revision(undefined, { state: "completed" }),
			async generateDebrief() {
				return { status: "downloaded" as const };
			},
		});
		await expect(restarted.coordinator.resume(command)).resolves.toEqual({
			status: "completed",
			resumable: false,
			debriefAvailable: true,
		});
		expect(restarted.events).toContain("debrief");
	});

	it("uses fresh verification exactly once, never retries or rolls back, and only claims Inbox Zero from a final fresh empty observation", async () => {
		for (const verifyStatus of [
			"verified",
			"mismatch",
			"ambiguous",
			"timeout",
		] as const) {
			const run = harness({ verifyStatus, inboxCount: 0 });
			const result = await run.coordinator.start(command);
			expect(
				run.events.filter((event) => event === "verify:0"),
			).toHaveLength(1);
			expect(run.dispatches()).toBe(1);
			expect(
				run.events.some((event) => event.includes("rollback")),
			).toBe(false);
			if (verifyStatus === "timeout") {
				expect(result).toMatchObject({
					status: "failed",
					reasonCode: "provider_timeout",
					resumable: false,
				});
			}
		}

		const empty = harness({ inboxCount: 0 });
		await empty.coordinator.start(command);
		expect(empty.events.indexOf("observe-inbox")).toBeLessThan(
			empty.events.indexOf("lifecycle:in_flight->completed"),
		);
		expect(
			empty.events.indexOf("lifecycle:in_flight->completed"),
		).toBeLessThan(empty.events.indexOf("debrief"));

		const nonempty = harness({ inboxCount: 2 });
		await nonempty.coordinator.start(command);
		expect(nonempty.events).toContain("observe-inbox");
		expect(JSON.stringify(await nonempty.journal.snapshot(command))).not.toContain(
			"Inbox Zero",
		);
	});
});
