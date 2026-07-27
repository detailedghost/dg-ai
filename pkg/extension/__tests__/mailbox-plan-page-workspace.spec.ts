import { describe, expect, it } from "bun:test";
import {
	captureResult,
	fingerprint,
	NEXT_REVISION_ALIAS,
	NOW_MS,
	RAW_LOCATOR_SENTINEL,
	revision,
} from "./mailbox-plan-page-fixtures";
import { view, workspaceHarness } from "./mailbox-plan-page-harness";

function deferred<T = void>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((next, fail) => {
		resolve = next;
		reject = fail;
	});
	return { promise, reject, resolve };
}

async function waitFor(
	condition: () => boolean,
	message: string,
): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		if (condition()) return;
		await Promise.resolve();
	}
	throw new Error(message);
}

describe("mailbox plan workspace", () => {
	it("applies exclusion, then exception, then cohort edit over the deterministic baseline and routes ambiguity to Review", async () => {
		const { workspace } = workspaceHarness();
		const cohort = captureResult().cohorts[0]!;
		const [excludedAlias, exceptionAlias] = cohort.messageAliases;
		if (!excludedAlias || !exceptionAlias) {
			throw new Error("Fixture cohort needs two messages");
		}

		await workspace.selectChoice("balanced");
		await workspace.applyEdit({
			type: "set_cohort_action",
			cohortKey: cohort.cohortKey,
			action: "archive",
		});
		await workspace.applyEdit({
			type: "set_message_exception",
			messageAlias: exceptionAlias,
			action: "mark_read",
		});
		await workspace.applyEdit({
			type: "exclude_message",
			messageAlias: excludedAlias,
		});

		const snapshot = view(workspace);
		expect(snapshot.excludedMessageAliases).toContain(excludedAlias);
		expect(
			snapshot.actions.some(
				(action) =>
					"messageAlias" in action && action.messageAlias === excludedAlias,
			),
		).toBe(false);
		expect(snapshot.actions).toContainEqual({
			type: "mark_read",
			messageAlias: exceptionAlias,
		});
		expect(snapshot.reviewMessageAliases).toContain(excludedAlias);
	});

	it("accepts alias-only folders, labels, categories, and filters and rejects raw or unbounded edits", async () => {
		const { workspace } = workspaceHarness();
		const capture = captureResult();
		const edits = [
			{
				type: "set_message_exception",
				messageAlias: capture.inventory.messages[0]!.alias,
				action: "move_to_folder",
				folderAlias: capture.inventory.folders[0]!.alias,
			},
			{
				type: "set_message_exception",
				messageAlias: capture.inventory.messages[1]!.alias,
				action: "apply_label",
				labelAlias: capture.inventory.labels[0]!.alias,
			},
			{
				type: "set_message_exception",
				messageAlias: capture.inventory.messages[2]!.alias,
				action: "apply_label",
				labelAlias: capture.metadata.categories[0]!.alias,
			},
			{
				type: "set_filter_action",
				filterAlias: capture.inventory.filters[0]!.alias,
				action: "deactivate_filter",
			},
		] as const;
		for (const edit of edits) {
			await expect(workspace.applyEdit(edit)).resolves.toBeUndefined();
		}
		await expect(
			workspace.applyEdit({
				type: "set_message_exception",
				messageAlias: capture.inventory.messages[0]!.alias,
				action: "move_to_folder",
				folderAlias: "Inbox/Payroll",
				selector: RAW_LOCATOR_SENTINEL,
			} as never),
		).rejects.toThrow();
		await expect(
			workspace.applyEdit({
				type: "set_bulk_exclusions",
				messageAliases: Array.from(
					{ length: 5_001 },
					(_unused, index) => `msg-${index}`,
				),
			}),
		).rejects.toThrow();
	});

	it("keeps Save, Submit, Accept, and Cancel distinct and forks a Draft after an accepted edit", async () => {
		const { bridgeSubmissions, lifecycleCalls, workspace } = workspaceHarness();

		const saved = await workspace.saveDraft();
		expect(saved.state).toBe("draft");
		expect(lifecycleCalls.at(-1)?.[0]).toBe("edit");

		const submitted = await workspace.submitToChat();
		expect(submitted).toMatchObject({ status: "submitted" });
		expect(bridgeSubmissions).toHaveLength(1);
		expect(
			lifecycleCalls.some(
				(call) =>
					call[0] === "transition" &&
					(call[1] as { nextState?: string }).nextState === "approved",
			),
		).toBe(false);

		const accepted = await workspace.acceptRevision();
		expect(accepted.state).toBe("approved");
		expect(accepted.inventoryFingerprint).toEqual(fingerprint("b"));
		expect(Object.isFrozen(accepted)).toBe(true);
		expect(Object.isFrozen(accepted.actions)).toBe(true);
		expect(Object.isFrozen(accepted.targets)).toBe(true);
		expect(Object.isFrozen(accepted.inventoryFingerprint)).toBe(true);
		expect(Object.isFrozen(accepted.cohorts)).toBe(true);
		expect(Object.isFrozen(accepted.cohorts[0]?.messageAliases)).toBe(true);
		expect(
			lifecycleCalls.filter(
				(call) =>
					call[0] === "transition" &&
					(call[1] as { nextState?: string }).nextState === "approved",
			),
		).toHaveLength(1);

		await workspace.applyEdit({
			type: "exclude_message",
			messageAlias: captureResult().inventory.messages[0]!.alias,
		});
		expect(view(workspace).revision.state).toBe("draft");
		expect(view(workspace).revision.revisionAlias).toBe(NEXT_REVISION_ALIAS);

		await workspace.cancel();
		expect(lifecycleCalls.at(-1)?.[1]).toMatchObject({ nextState: "canceled" });
	});

	it("fails closed when binding expiry wins a click and renews only defined user decisions", async () => {
		const harness = workspaceHarness();
		expect(harness.touches).toEqual([]);
		harness.workspace.getSnapshot();
		expect(harness.touches).toEqual([]);

		harness.setBindingAvailable(false);
		await expect(harness.workspace.acceptRevision()).rejects.toThrow();
		expect(harness.touches).toEqual(["user_decision"]);
		expect(view(harness.workspace)).toMatchObject({
			restartRequired: true,
			bindingAvailable: false,
		});
		await expect(harness.workspace.saveDraft()).resolves.toMatchObject({
			state: "draft",
		});
		await expect(
			harness.workspace.applyEdit({
				type: "set_message_exception",
				messageAlias: captureResult().inventory.messages[0]!.alias,
				action: "archive",
			}),
		).rejects.toThrow();
		expect(harness.touches.every((event) => event === "user_decision")).toBe(
			true,
		);
	});

	it("preserves baseline, local hint, chat, cohort, exception, then exclusion precedence", async () => {
		const harness = workspaceHarness({ localHintsEnabled: true });
		expect(view(harness.workspace).chatAvailable).toBe(true);
		const cohort = captureResult().cohorts[0]!;
		const messageAlias = cohort.messageAliases[0]!;
		expect(view(harness.workspace).reviewMessageAliases).toContain(
			messageAlias,
		);
		expect(
			view(harness.workspace).actions.some(
				(action) =>
					"messageAlias" in action && action.messageAlias === messageAlias,
			),
		).toBe(false);
		const chatDraft = revision({
			revisionAlias: NEXT_REVISION_ALIAS,
			actions: [
				{
					type: "mark_read",
					messageAlias,
				},
			],
		});

		await harness.workspace.applyEdit({
			type: "apply_chat_proposal",
			proposal: chatDraft,
		});
		expect(view(harness.workspace).actions).toContainEqual({
			type: "mark_read",
			messageAlias,
		});

		await harness.workspace.applyEdit({
			type: "set_cohort_action",
			cohortKey: cohort.cohortKey,
			action: "archive",
		});
		expect(view(harness.workspace).actions).toContainEqual({
			type: "archive",
			messageAlias,
		});

		await harness.workspace.applyEdit({
			type: "set_message_exception",
			messageAlias,
			action: "mark_read",
		});
		expect(view(harness.workspace).actions).toContainEqual({
			type: "mark_read",
			messageAlias,
		});

		await harness.workspace.applyEdit({
			type: "exclude_message",
			messageAlias,
		});
		expect(
			view(harness.workspace).actions.some(
				(action) =>
					"messageAlias" in action && action.messageAlias === messageAlias,
			),
		).toBe(false);
		expect(view(harness.workspace).reviewMessageAliases).toContain(
			messageAlias,
		);
	});

	it("fails before touching or persisting when plan expiry wins a user-decision race", async () => {
		const harness = workspaceHarness();
		harness.setNow(NOW_MS + 30 * 24 * 60 * 60 * 1_000);

		expect(view(harness.workspace).planExpired).toBe(true);
		await expect(harness.workspace.acceptRevision()).rejects.toMatchObject({
			code: "plan_expired",
		});
		await expect(
			harness.workspace.applyEdit({
				type: "exclude_message",
				messageAlias: captureResult().inventory.messages[0]!.alias,
			}),
		).rejects.toMatchObject({ code: "plan_expired" });
		await expect(harness.workspace.saveDraft()).rejects.toMatchObject({
			code: "plan_expired",
		});
		expect(harness.touches).toEqual([]);
		expect(harness.lifecycleCalls).toEqual([]);
		expect(harness.fingerprintInputs).toEqual([]);
	});

	it("publishes transitionPending during acceptance and fingerprints the exact accepted actions and targets", async () => {
		let releaseTransition = (): void => {};
		const transitionGate = new Promise<void>((resolve) => {
			releaseTransition = resolve;
		});
		const harness = workspaceHarness({ transitionGate });
		await harness.workspace.applyEdit({
			type: "exclude_message",
			messageAlias: captureResult().inventory.messages[0]!.alias,
		});
		const expected = view(harness.workspace);
		let releasePending = (): void => {};
		const pendingSeen = new Promise<void>((resolve) => {
			releasePending = resolve;
		});
		const unsubscribe = harness.workspace.subscribe((snapshot) => {
			if (snapshot.transitionPending) releasePending();
		});

		const accepting = harness.workspace.acceptRevision();
		await pendingSeen;
		unsubscribe();
		expect(view(harness.workspace).transitionPending).toBe(true);
		releaseTransition();
		const accepted = await accepting;

		expect(view(harness.workspace).transitionPending).toBe(false);
		expect(harness.fingerprintInputs).toHaveLength(1);
		expect(harness.fingerprintInputs[0]?.actions).toEqual(expected.actions);
		expect(harness.fingerprintInputs[0]?.targets).toEqual(
			expected.revision.targets,
		);
		expect(accepted.actions).toEqual(expected.actions);
	});

	it("locks the exact action snapshot before deferred fingerprinting and rejects a concurrent edit", async () => {
		const fingerprintGate = deferred();
		const harness = workspaceHarness({
			fingerprintGate: fingerprintGate.promise,
		});
		const before = view(harness.workspace);
		const accepting = harness.workspace.acceptRevision();
		await Promise.resolve();

		expect(view(harness.workspace).transitionPending).toBe(true);
		await expect(
			harness.workspace.applyEdit({
				type: "exclude_message",
				messageAlias: captureResult().inventory.messages[0]!.alias,
			}),
		).rejects.toThrow();
		fingerprintGate.resolve();

		const accepted = await accepting;
		expect(harness.fingerprintInputs).toHaveLength(1);
		expect(harness.fingerprintInputs[0]?.actions).toEqual(before.actions);
		expect(accepted.actions).toEqual(before.actions);
		expect(
			harness.lifecycleCalls.filter((call) => call[0] === "transition"),
		).toHaveLength(1);
	});

	it("makes repeated acceptance idempotent without touching, forking, or transitioning twice", async () => {
		const harness = workspaceHarness();
		const first = await harness.workspace.acceptRevision();
		const callsAfterFirst = {
			edits: harness.lifecycleCalls.filter((call) => call[0] === "edit").length,
			touches: harness.touches.length,
			transitions: harness.lifecycleCalls.filter(
				(call) => call[0] === "transition",
			).length,
		};

		const second = await harness.workspace.acceptRevision();

		expect(second).toEqual(first);
		expect(
			harness.lifecycleCalls.filter((call) => call[0] === "edit"),
		).toHaveLength(callsAfterFirst.edits);
		expect(harness.touches).toHaveLength(callsAfterFirst.touches);
		expect(
			harness.lifecycleCalls.filter((call) => call[0] === "transition"),
		).toHaveLength(callsAfterFirst.transitions);
	});

	it("reopens the authoritative base revision and lets a later slider choice override chat", async () => {
		const capture = captureResult();
		const balanced = capture.choices.find(
			(choice) => choice.id === "balanced",
		)!;
		const baseRevision = revision({
			actions: balanced.actions,
			cohorts: capture.cohorts,
		});
		const reopened = workspaceHarness({ baseRevision, capture });

		expect(view(reopened.workspace).actions).toEqual(baseRevision.actions);
		expect(view(reopened.workspace).selectedChoiceId).toBe("balanced");

		const alias = capture.inventory.messages[0]!.alias;
		await reopened.workspace.applyEdit({
			type: "apply_chat_proposal",
			proposal: revision({
				revisionAlias: NEXT_REVISION_ALIAS,
				actions: [{ type: "mark_read", messageAlias: alias }],
			}),
		});
		await reopened.workspace.selectChoice("inbox_zero");
		const inboxZero = capture.choices.find(
			(choice) => choice.id === "inbox_zero",
		)!;
		expect(view(reopened.workspace).actions).toEqual(inboxZero.actions);
	});

	it("persists a typed chat proposal as Draft while preserving a newer user edit", async () => {
		const proposalGate = deferred<unknown>();
		const capture = captureResult();
		const messageAlias = capture.inventory.messages[0]!.alias;
		const chatDraft = revision({
			revisionAlias: NEXT_REVISION_ALIAS,
			actions: [{ type: "mark_read", messageAlias }],
		});
		const harness = workspaceHarness({
			bridgeResults: [proposalGate.promise],
		});

		const submitting = harness.workspace.submitToChat();
		await Promise.race([
			waitFor(
				() => harness.bridgeSubmissions.length > 0,
				"Submit did not reach the chat bridge",
			),
			submitting.then(() => {
				throw new Error("Submit settled before reaching the chat bridge");
			}),
		]);
		await harness.workspace.applyEdit({
			type: "set_message_exception",
			messageAlias,
			action: "archive",
		});
		proposalGate.resolve({ status: "proposal", proposal: chatDraft });
		await expect(submitting).resolves.toMatchObject({ status: "proposal" });

		expect(view(harness.workspace).revision.state).toBe("draft");
		expect(view(harness.workspace).actions).toContainEqual({
			type: "archive",
			messageAlias,
		});
		expect(
			harness.lifecycleCalls.filter((call) => call[0] === "edit").length,
		).toBeGreaterThan(0);
	});

	it("clones mutable edits before awaiting the raw-binding touch seam", async () => {
		const touchGate = deferred();
		const harness = workspaceHarness({ touchGate: touchGate.promise });
		const messageAlias = captureResult().inventory.messages[0]!.alias;
		const edit: {
			type: "set_message_exception";
			messageAlias: string;
			action: "archive" | "mark_read";
		} = {
			type: "set_message_exception",
			messageAlias,
			action: "archive",
		};
		const applying = harness.workspace.applyEdit(edit);
		edit.action = "mark_read";
		touchGate.resolve();
		await applying;

		expect(view(harness.workspace).actions).toContainEqual({
			type: "archive",
			messageAlias,
		});
		expect(view(harness.workspace).actions).not.toContainEqual({
			type: "mark_read",
			messageAlias,
		});
	});

	it("fails closed at touch, fingerprint, and rebind expiry crossings without a sink or transition", async () => {
		const touchGate = deferred();
		const touchRace = workspaceHarness({ touchGate: touchGate.promise });
		const touching = touchRace.workspace.acceptRevision();
		touchRace.setBindingAvailable(false);
		touchGate.resolve();
		await expect(touching).rejects.toThrow();
		expect(touchRace.fingerprintInputs).toEqual([]);
		expect(touchRace.bindingPuts).toEqual([]);
		expect(touchRace.lifecycleCalls).toEqual([]);

		const fingerprintGate = deferred();
		const fingerprintRace = workspaceHarness({
			fingerprintGate: fingerprintGate.promise,
		});
		const fingerprinting = fingerprintRace.workspace.acceptRevision();
		while (fingerprintRace.fingerprintInputs.length === 0) {
			await Promise.resolve();
		}
		fingerprintRace.setNow(NOW_MS + 30 * 24 * 60 * 60 * 1_000);
		fingerprintGate.resolve();
		await expect(fingerprinting).rejects.toThrow();
		expect(fingerprintRace.bindingPuts).toEqual([]);
		expect(
			fingerprintRace.lifecycleCalls.filter((call) => call[0] === "transition"),
		).toEqual([]);

		const rebindGate = deferred();
		const rebindRace = workspaceHarness({ rebindGate: rebindGate.promise });
		const rebinding = rebindRace.workspace.acceptRevision();
		await Promise.race([
			waitFor(
				() => rebindRace.fingerprintInputs.length > 0,
				"Accept did not reach fingerprinting before rebind",
			),
			rebinding.then(() => {
				throw new Error("Accept settled before fingerprinting");
			}),
		]);
		rebindRace.setBindingAvailable(false);
		rebindGate.resolve();
		await expect(rebinding).rejects.toThrow();
		expect(rebindRace.bindingPuts).toEqual([]);
		expect(
			rebindRace.lifecycleCalls.filter((call) => call[0] === "transition"),
		).toEqual([]);
	});

	it("refreshes passive binding status, publishes renewed expiry, and exposes reconnect state", async () => {
		const renewedBindingExpiresAt = NOW_MS + 2 * 60 * 60 * 1_000;
		const disconnected = Object.assign(new Error("chat disconnected"), {
			code: "disconnected",
		});
		const chat = deferred<unknown>();
		const harness = workspaceHarness({
			bridgeResults: [chat.promise],
			renewedBindingExpiresAt,
		});
		const workspace = harness.workspace as typeof harness.workspace & {
			refreshStatus(): Promise<void>;
			reconnectChat(): Promise<void>;
		};

		await workspace.selectChoice("balanced");
		expect(view(workspace).bindingExpiresAt).toBe(renewedBindingExpiresAt);
		expect(harness.bindingStatusCalls.length).toBeGreaterThan(0);

		const submitting = workspace.submitToChat();
		await Promise.race([
			waitFor(
				() => harness.bridgeSubmissions.length > 0,
				"Submit did not reach the chat bridge",
			),
			submitting.then(() => {
				throw new Error("Submit settled before reaching the chat bridge");
			}),
		]);
		chat.reject(disconnected);
		await expect(submitting).rejects.toMatchObject({
			code: "disconnected",
		});
		expect(view(workspace).canReconnect).toBe(true);
		expect(view(workspace).chatStatus).toBe("disconnected");
		expect(view(workspace).chatMessage).toMatch(/reconnect/i);
		await workspace.reconnectChat();
		expect(harness.bridgeReconnects).toHaveLength(1);
		expect(view(workspace).canReconnect).toBe(false);

		harness.setBindingAvailable(false);
		await workspace.refreshStatus();
		expect(view(workspace)).toMatchObject({
			bindingAvailable: false,
			restartRequired: true,
		});
	});

	it("forks an approved revision immediately for slider selection and every public edit class", async () => {
		const capture = captureResult();
		const messageAlias = capture.inventory.messages[0]!.alias;
		const edits = [
			{
				type: "set_cohort_action",
				cohortKey: capture.cohorts[0]!.cohortKey,
				action: "archive",
			},
			{
				type: "set_message_exception",
				messageAlias,
				action: "archive",
			},
			{
				type: "set_message_exception",
				messageAlias,
				action: "move_to_folder",
				folderAlias: capture.inventory.folders[0]!.alias,
			},
			{
				type: "set_message_exception",
				messageAlias,
				action: "apply_label",
				labelAlias: capture.inventory.labels[0]!.alias,
			},
			{
				type: "set_message_exception",
				messageAlias,
				action: "remove_label",
				labelAlias: capture.inventory.labels[0]!.alias,
			},
			{ type: "exclude_message", messageAlias },
			{ type: "include_message", messageAlias },
			{ type: "set_bulk_exclusions", messageAliases: [messageAlias] },
			{
				type: "set_filter_action",
				filterAlias: capture.inventory.filters[0]!.alias,
				action: "deactivate_filter",
			},
			{
				type: "set_target",
				targetKind: "folder",
				alias: capture.inventory.folders[0]!.alias,
				selected: false,
			},
			{
				type: "apply_chat_proposal",
				proposal: revision({
					revisionAlias: NEXT_REVISION_ALIAS,
				}),
			},
		] as const;

		const slider = workspaceHarness();
		await slider.workspace.acceptRevision();
		const sliderEdits = slider.lifecycleCalls.filter(
			(call) => call[0] === "edit",
		).length;
		await slider.workspace.selectChoice("balanced");
		expect(view(slider.workspace).revision.state).toBe("draft");
		expect(
			slider.lifecycleCalls.filter((call) => call[0] === "edit"),
		).toHaveLength(sliderEdits + 1);

		for (const edit of edits) {
			const harness = workspaceHarness();
			await harness.workspace.acceptRevision();
			const before = harness.lifecycleCalls.filter(
				(call) => call[0] === "edit",
			).length;
			try {
				await harness.workspace.applyEdit(edit);
			} catch (error) {
				throw new Error(
					`approved ${edit.type} edit was rejected: ${JSON.stringify(edit)}`,
					{ cause: error },
				);
			}
			expect(view(harness.workspace).revision.state).toBe("draft");
			expect(
				harness.lifecycleCalls.filter((call) => call[0] === "edit"),
			).toHaveLength(before + 1);
		}
	});

	it("restores the exact accepted view when choice or edit persistence fails", async () => {
		const exercise = async (
			change: (harness: ReturnType<typeof workspaceHarness>) => Promise<void>,
		) => {
			const harness = workspaceHarness();
			await harness.workspace.acceptRevision();
			const accepted = structuredClone(harness.workspace.getSnapshot());
			harness.setLifecycleEditError(new Error("store unavailable"));

			await expect(change(harness)).rejects.toThrow("store unavailable");
			const after = harness.workspace.getSnapshot();
			expect(after.revision).toEqual(accepted.revision);
			expect(after.actions).toEqual(accepted.actions);
			expect(after.targets).toEqual(accepted.targets);
			expect(after.selectedChoiceId).toBe(accepted.selectedChoiceId);
			expect(after.dirty).toBe(false);
		};

		await exercise((harness) => harness.workspace.selectChoice("balanced"));
		await exercise((harness) =>
			harness.workspace.applyEdit({
				type: "exclude_message",
				messageAlias: captureResult().inventory.messages[0]!.alias,
			}),
		);
	});

	it("returns deeply immutable snapshots that cannot alter persisted or submitted actions", async () => {
		const harness = workspaceHarness({
			capture: structuredClone(captureResult()),
			baseRevision: structuredClone(revision()),
		});
		const snapshot = harness.workspace.getSnapshot();
		const actions = structuredClone(snapshot.actions);
		const cohorts = structuredClone(snapshot.cohorts);

		expect(Object.isFrozen(snapshot.actions)).toBe(true);
		expect(Object.isFrozen(snapshot.actions[0])).toBe(true);
		expect(Object.isFrozen(snapshot.cohorts)).toBe(true);
		expect(Object.isFrozen(snapshot.cohorts[0])).toBe(true);
		expect(Object.isFrozen(snapshot.cohorts[0]?.messageAliases)).toBe(true);
		expect(Object.isFrozen(snapshot.cohorts[0]?.suggestedActions)).toBe(true);
		expect(
			Reflect.set(snapshot.actions[0] as object, "type", "mark_read"),
		).toBe(false);
		expect(
			Reflect.set(
				snapshot.cohorts[0]!.messageAliases as object,
				"0",
				"msg_ffffffffffffffffffffffffffffffff",
			),
		).toBe(false);

		await harness.workspace.saveDraft();
		await harness.workspace.submitToChat();
		const persisted = harness.lifecycleCalls
			.filter((call) => call[0] === "edit")
			.at(-1)?.[3] as ReturnType<typeof revision>;
		const submitted = harness.bridgeSubmissions.at(-1) as {
			revision: ReturnType<typeof revision>;
		};
		expect(persisted.actions).toEqual(actions);
		expect(persisted.cohorts).toEqual(cohorts);
		expect(submitted.revision.actions).toEqual(actions);
		expect(submitted.revision.cohorts).toEqual(cohorts);
	});

	it("rejects every mutating in-flight or terminal operation and does not fork an approved revision merely to Submit", async () => {
		for (const state of ["in_flight", "canceled", "completed"] as const) {
			const harness = workspaceHarness({
				baseRevision: revision({ state }),
			});
			const messageAlias = captureResult().inventory.messages[0]!.alias;
			await expect(harness.workspace.saveDraft()).rejects.toMatchObject({
				code: "invalid_state",
			});
			await expect(harness.workspace.submitToChat()).rejects.toMatchObject({
				code: "invalid_state",
			});
			await expect(
				harness.workspace.selectChoice("balanced"),
			).rejects.toMatchObject({ code: "invalid_state" });
			await expect(
				harness.workspace.applyEdit({
					type: "exclude_message",
					messageAlias,
				}),
			).rejects.toMatchObject({ code: "invalid_state" });
			expect(harness.touches).toEqual([]);
			expect(harness.bridgeSubmissions).toEqual([]);
			expect(harness.lifecycleCalls).toEqual([]);
		}

		const approved = workspaceHarness();
		await approved.workspace.acceptRevision();
		const edits = approved.lifecycleCalls.filter(
			(call) => call[0] === "edit",
		).length;
		await expect(approved.workspace.submitToChat()).rejects.toMatchObject({
			code: "invalid_state",
		});
		expect(approved.bridgeSubmissions).toEqual([]);
		expect(
			approved.lifecycleCalls.filter((call) => call[0] === "edit"),
		).toHaveLength(edits);
		expect(view(approved.workspace).revision.state).toBe("approved");
	});

	it("publishes restart-required UI state when binding invalidation wins immediately after approval", async () => {
		const harness = workspaceHarness({
			transitionInvalidatesBinding: true,
		});

		await expect(harness.workspace.acceptRevision()).rejects.toMatchObject({
			code: "binding_expired",
		});
		expect(view(harness.workspace)).toMatchObject({
			revision: { state: "approved", restartRequired: true },
			bindingAvailable: false,
			restartRequired: true,
		});
		expect(
			harness.lifecycleCalls.filter((call) => call[0] === "transition"),
		).toHaveLength(1);
	});

	it("starts closed, disables Submit, reconnects, and delivers one submission", async () => {
		const harness = workspaceHarness({ bridgeInitiallyOpen: false });
		expect(view(harness.workspace)).toMatchObject({
			chatAvailable: false,
			chatStatus: "disconnected",
			canReconnect: true,
		});

		await harness.workspace.reconnectChat();
		expect(harness.bridgeReconnects).toHaveLength(1);
		expect(view(harness.workspace).chatAvailable).toBe(true);
		await harness.workspace.submitToChat();
		expect(harness.bridgeSubmissions).toHaveLength(1);

		for (const bridgeHasIsOpen of [false, true]) {
			const unavailable = workspaceHarness({
				bridgeHasIsOpen,
				bridgeInitiallyOpen: false,
			});
			expect(view(unavailable.workspace)).toMatchObject({
				chatAvailable: false,
				chatStatus: "disconnected",
				canReconnect: true,
			});
			await expect(unavailable.workspace.submitToChat()).rejects.toMatchObject({
				code: "chat_unavailable",
			});
			expect(unavailable.bridgeSubmissions).toEqual([]);
		}
	});
});
