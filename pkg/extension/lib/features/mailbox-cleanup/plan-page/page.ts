import type {
	MailboxChoiceId,
	MailboxPlanPageOptions,
	MailboxPlanSnapshot,
	MailboxPlanWorkspace,
} from "./contracts";

const CHOICES = [
	{ id: "conservative", label: "Conservative", position: 0 },
	{ id: "balanced", label: "Balanced", position: 50 },
	{ id: "inbox_zero", label: "Inbox Zero", position: 100 },
] as const;

const MAX_TIMER_DELAY_MS = 2_147_483_647;

const SLIDER_KEYS = new Set([
	"ArrowRight",
	"ArrowLeft",
	"ArrowDown",
	"ArrowUp",
	"PageUp",
	"PageDown",
	"Home",
	"End",
]);

function element<K extends keyof HTMLElementTagNameMap>(
	tag: K,
	text?: string,
): HTMLElementTagNameMap[K] {
	const node = document.createElement(tag);
	if (text !== undefined) node.textContent = text;
	return node;
}

function section(title: string): {
	section: HTMLElement;
	body: HTMLDivElement;
} {
	const container = element("section");
	container.className = "mailbox-panel";
	container.appendChild(element("h2", title));
	const body = element("div");
	container.appendChild(body);
	return { section: container, body };
}

function countLabel(value: number, singular: string): string {
	return `${value} ${singular}${value === 1 ? "" : "s"}`;
}

function choiceLabel(choice: MailboxChoiceId): string {
	return (
		CHOICES.find((candidate) => candidate.id === choice)?.label ??
		"Conservative"
	);
}

function errorMessage(error: unknown): string {
	const code =
		error !== null && typeof error === "object" && "code" in error
			? (error as { code?: unknown }).code
			: undefined;
	if (code === "disconnected" || code === "timeout") {
		return "Chat disconnected. Reconnect to continue this proposal.";
	}
	if (code === "busy") return "Another plan change is in progress.";
	if (
		code === "plan_expired"
	) {
		return "This mailbox cleanup plan has expired. Start a new scan.";
	}
	if (code === "invalid_state") {
		return "This revision cannot be changed in its current state.";
	}
	return "Mailbox lookup data is unavailable. A restart and fresh scan are required before acceptance.";
}

export function mountMailboxPlanPage(
	root: HTMLElement,
	workspace: MailboxPlanWorkspace,
	options: MailboxPlanPageOptions = {},
): () => void {
	let displayResolver = options.resolveDisplayText;
	let displayCleared = false;
	let disposed = false;
	let editorPage = 0;
	let bindingExpiryTimer: unknown;
	let planExpiryTimer: unknown;
	let bindingExpiryGeneration = 0;
	let planExpiryGeneration = 0;
	const rawDisplayNodes = new Map<HTMLElement, string>();
	const scheduler = options.scheduler ?? {
		setTimeout: (callback: () => void, milliseconds: number) => {
			const timer = globalThis.setTimeout(callback, milliseconds);
			if (
				typeof timer === "object" &&
				timer !== null &&
				"unref" in timer &&
				typeof timer.unref === "function"
			) {
				timer.unref();
			}
			return timer;
		},
		clearTimeout: (timer: unknown) =>
			globalThis.clearTimeout(timer as ReturnType<typeof setTimeout>),
	};

	root.replaceChildren();
	root.classList.add("mailbox-plan-page");

	const title = element("h1", "Mailbox cleanup plan");
	root.appendChild(title);

	const alert = element("div");
	alert.setAttribute("role", "alert");
	alert.tabIndex = -1;
	alert.hidden = true;
	root.appendChild(alert);

	const found = section("Found");
	const scrubbed = section("Scrubbed");
	const expiry = section("Temporary data expiry");
	const suggested = section("Suggested cleanup");
	const editor = section("Editor");
	const execution = section("Execution status");
	root.append(
		found.section,
		scrubbed.section,
		expiry.section,
		suggested.section,
		editor.section,
		execution.section,
	);

	const foundCounts = element("p");
	const coverage = element("p");
	found.body.append(foundCounts, coverage);

	const scrubbedSummary = element("p");
	scrubbed.body.appendChild(scrubbedSummary);

	const expiryExplanation = element(
		"p",
		"This deletes DeeGee’s temporary mailbox lookup data—not messages. Passive viewing does not renew it. Display names are erased at lookup expiry; the sanitized plan remains until plan expiry.",
	);
	const bindingExpiry = element("p");
	const planExpiry = element("p");
	expiry.body.append(expiryExplanation, bindingExpiry, planExpiry);

	const sliderLabel = element("label", "Cleanup level");
	const slider = element("input");
	slider.type = "range";
	slider.min = "0";
	slider.max = "100";
	slider.step = "50";
	slider.setAttribute("aria-label", "Cleanup level");
	sliderLabel.appendChild(slider);
	const choiceButtons = CHOICES.map((choice) => {
		const button = element("button", choice.label);
		button.type = "button";
		button.dataset.choice = choice.id;
		return button;
	});
	const choiceControls = element("div");
	choiceControls.className = "mailbox-choice-buttons";
	choiceControls.append(...choiceButtons);
	const outcome = element("p");
	const partialWarning = element("p");
	const live = element("div");
	live.setAttribute("role", "status");
	live.setAttribute("aria-live", "polite");
	live.setAttribute("aria-atomic", "true");
	suggested.body.append(
		sliderLabel,
		choiceControls,
		outcome,
		partialWarning,
		live,
	);

	const editorContent = element("div");
	editorContent.dataset.mailboxEditor = "";
	const editorIntro = element(
		"p",
		"Review means no automatic action. Select each action independently; a message can have more than one action.",
	);
	const emptyState = element("p");
	const targetEditors = element("div");
	const cohortEditors = element("div");
	const messageEditors = element("div");
	const filterEditors = element("div");
	const actionList = element("ul");
	actionList.dataset.actionList = "";
	const displayList = element("ul");
	const paging = element("div");
	paging.className = "mailbox-editor-paging";
	const previousPage = element("button", "Previous");
	previousPage.type = "button";
	previousPage.dataset.focusKey = "previous-page";
	const pageStatus = element("span");
	pageStatus.dataset.editorPage = "";
	const nextPage = element("button", "Next");
	nextPage.type = "button";
	nextPage.dataset.focusKey = "next-page";
	paging.append(previousPage, pageStatus, nextPage);
	editorContent.append(
		editorIntro,
		emptyState,
		targetEditors,
		cohortEditors,
		messageEditors,
		filterEditors,
		actionList,
		displayList,
		paging,
	);
	editor.body.appendChild(editorContent);

	const executionSummary = element("p");
	const submitExplanation = element(
		"p",
		"Sends a newly scrubbed copy; it does not accept the plan. A typed chat proposal is saved as a Draft for review.",
	);
	const acceptExplanation = element("p");
	const workflow = element("div");
	workflow.className = "mailbox-workflow";
	const save = element("button", "Save Draft");
	const submit = element("button", "Submit to Chat");
	const accept = element("button", "Accept Revision");
	const reconnect = element("button", "Reconnect");
	const cancel = element("button", "Cancel cleanup");
	for (const button of [save, submit, accept, reconnect, cancel]) {
		button.type = "button";
	}
	workflow.append(save, submit, accept, reconnect, cancel);
	execution.body.append(
		executionSummary,
		submitExplanation,
		acceptExplanation,
		workflow,
	);

	const initial = workspace.getSnapshot();
	const capture = initial.captureCounts;

	const clearRawDisplays = (): void => {
		displayResolver = undefined;
		for (const [node] of rawDisplayNodes) node.textContent = "";
		if (displayCleared) return;
		displayCleared = true;
		options.clearDisplayText?.();
	};

	const showError = (error: unknown): void => {
		const code =
			error !== null && typeof error === "object" && "code" in error
				? (error as { code?: unknown }).code
				: undefined;
		if (code === "busy") {
			live.textContent = errorMessage(error);
			return;
		}
		if (
			code === "disconnected" ||
			code === "timeout" ||
			code === "chat_unavailable"
		) {
			alert.hidden = false;
			alert.textContent =
				"Chat is unavailable. Reconnect before submitting.";
			return;
		}
		clearRawDisplays();
		alert.hidden = false;
		alert.textContent = errorMessage(error);
		alert.focus();
	};

	async function run(operation: () => Promise<void>): Promise<void> {
		try {
			await operation();
		} catch (error) {
			showError(error);
		}
	}

	const selectedAction = (
		snapshot: MailboxPlanSnapshot,
		messageAlias: string,
	):
		| "review"
		| "mixed"
		| "archive"
		| "mark_read"
		| "move_to_folder"
		| "apply_label"
		| "remove_label" => {
		const actions = snapshot.actions.filter(
			(candidate) =>
				"messageAlias" in candidate &&
				candidate.messageAlias === messageAlias,
		);
		if (actions.length === 0) return "review";
		if (actions.length > 1) return "mixed";
		const action = actions[0];
		return action === undefined || action.type === "deactivate_filter"
			? "review"
			: action.type;
	};

	const appendCohortOptions = (select: HTMLSelectElement): void => {
		for (const [value, text] of [
			["mixed", "Mixed"],
			["review", "Review — no automatic action"],
			["archive", "Archive"],
			["mark_read", "Mark read"],
		] as const) {
			const option = element("option", text);
			option.value = value;
			option.disabled = value === "mixed";
			select.appendChild(option);
		}
	};

	const renderEditor = (snapshot: MailboxPlanSnapshot): void => {
		const activeFocusKey =
			document.activeElement instanceof HTMLElement &&
			editorContent.contains(document.activeElement)
				? document.activeElement.dataset.focusKey
				: undefined;
		targetEditors.replaceChildren();
		cohortEditors.replaceChildren();
		messageEditors.replaceChildren();
		filterEditors.replaceChildren();
		actionList.replaceChildren();
		displayList.replaceChildren();
		rawDisplayNodes.clear();

		const pageSize = 20;
		const pageCount = Math.max(
			1,
			Math.ceil(
				Math.max(
					snapshot.cohorts.length,
					snapshot.editorInventory.messageAliases.length,
					snapshot.editorInventory.folderAliases.length,
					snapshot.editorInventory.labelAliases.length,
					snapshot.editorInventory.tagAliases.length,
					snapshot.editorInventory.categoryAliases.length,
					snapshot.editorInventory.filterAliases.length,
					snapshot.actions.length,
				) / pageSize,
			),
		);
		editorPage = Math.min(editorPage, pageCount - 1);
		const start = editorPage * pageSize;
		const targetGroups = [
			["Folders", "Folder", "folder", snapshot.editorInventory.folderAliases],
			["Labels", "Label", "label", snapshot.editorInventory.labelAliases],
			["Tags", "Tag", "label", snapshot.editorInventory.tagAliases],
			[
				"Categories",
				"Category",
				"label",
				snapshot.editorInventory.categoryAliases,
			],
			["Filters", "Filter", "filter", snapshot.editorInventory.filterAliases],
		] as const;
		for (const [
			groupIndex,
			[title, singular, targetKind, aliases],
		] of targetGroups.entries()) {
			const visibleAliases = aliases.slice(start, start + pageSize);
			if (visibleAliases.length === 0) continue;
			const group = element("fieldset");
			group.appendChild(element("legend", title));
			for (const [index, alias] of visibleAliases.entries()) {
				const label = element(
					"label",
					`${singular} ${start + index + 1}`,
				);
				label.dataset.targetEditor = "";
				const checkbox = element("input");
				checkbox.type = "checkbox";
				checkbox.dataset.focusKey = `target-${groupIndex}-${start + index}`;
				const selected =
					targetKind === "folder"
						? snapshot.targets.folderAliases
						: targetKind === "label"
							? snapshot.targets.labelAliases
							: snapshot.targets.filterAliases;
				checkbox.checked = selected.includes(alias);
				checkbox.addEventListener("change", () => {
					void run(async () => {
						await workspace.applyEdit({
							type: "set_target",
							targetKind,
							alias,
							selected: checkbox.checked,
						});
					});
				});
				label.prepend(checkbox);
				group.appendChild(label);
			}
			targetEditors.appendChild(group);
		}

		for (const cohort of snapshot.cohorts.slice(start, start + pageSize)) {
			const item = element("article");
			item.dataset.cohortEditor = "";
			const heading = element(
				"h3",
				`${cohort.category} · ${cohort.ageBucket} · ${countLabel(
					cohort.messageAliases.length,
					"message",
				)}`,
			);
			const label = element("label", "Cohort action");
			const select = element("select");
			select.dataset.focusKey = `cohort-${start + cohortEditors.childElementCount}`;
			appendCohortOptions(select);
			const actions = new Set(
				cohort.messageAliases.map((alias) =>
					selectedAction(snapshot, alias),
				),
			);
			select.value =
				actions.size === 1 ? [...actions][0] ?? "review" : "mixed";
			label.appendChild(select);
			select.addEventListener("change", () => {
				void run(async () => {
					await workspace.applyEdit({
						type: "set_cohort_action",
						cohortKey: cohort.cohortKey,
						action: select.value as
							| "archive"
							| "mark_read"
							| "review",
					});
				});
			});
			item.append(heading, label);
			cohortEditors.appendChild(item);
		}

		for (const [index, message] of snapshot.editorInventory.messages
			.slice(start, start + pageSize)
			.entries()) {
			const alias = message.alias;
			const row = element("article");
			row.dataset.messageEditor = "";
			const received = new Date(message.receivedAt)
				.toISOString()
				.slice(0, 10);
			const metadata = element(
				"p",
				`${message.category} · ${received} · ${
					message.read ? "Read" : "Unread"
				} · ${
					message.hasAttachments
						? "Has attachment"
						: "No attachment"
				}`,
			);
			const exception = element("fieldset");
			exception.dataset.messageException = "";
			exception.appendChild(
				element("legend", `Message ${start + index + 1} actions`),
			);
			const labelCandidates = [
				...snapshot.editorInventory.labelAliases,
				...snapshot.editorInventory.tagAliases,
				...snapshot.editorInventory.categoryAliases,
			];
			const messageActions = snapshot.actions.filter(
				(candidate) =>
					"messageAlias" in candidate &&
					candidate.messageAlias === alias,
			);
			for (const [actionIndex, [actionType, actionLabel, candidates]] of [
				["archive", "Archive", []],
				["mark_read", "Mark read", []],
				[
					"move_to_folder",
					"Move to folder",
					snapshot.editorInventory.folderAliases,
				],
				["apply_label", "Apply label", labelCandidates],
				["remove_label", "Remove label", labelCandidates],
			].entries()) {
				const type = actionType as
					| "archive"
					| "mark_read"
					| "move_to_folder"
					| "apply_label"
					| "remove_label";
				const controlLabel = element("label", actionLabel as string);
				const checkbox = element("input");
				checkbox.type = "checkbox";
				checkbox.dataset.messageAction = type;
				checkbox.dataset.focusKey =
					`message-action-${start + index}-${actionIndex}`;
				const currentAction = messageActions.find(
					(candidate) => candidate.type === type,
				);
				checkbox.checked = currentAction !== undefined;
				const target = element("select");
				target.dataset.messageTarget = type;
				target.dataset.focusKey =
					`message-target-${start + index}-${actionIndex}`;
				target.setAttribute(
					"aria-label",
					`${actionLabel} target for Message ${start + index + 1}`,
				);
				for (const [targetIndex, targetAlias] of (
					candidates as readonly string[]
				).entries()) {
					const option = element(
						"option",
						`${type === "move_to_folder" ? "Folder" : "Label"} ${targetIndex + 1}`,
					);
					option.value = targetAlias;
					target.appendChild(option);
				}
				const selectedTarget =
					currentAction?.type === "move_to_folder"
						? currentAction.folderAlias
						: currentAction?.type === "apply_label" ||
								currentAction?.type === "remove_label"
							? currentAction.labelAlias
							: undefined;
				if (
					selectedTarget !== undefined &&
					(candidates as readonly string[]).includes(selectedTarget)
				) {
					target.value = selectedTarget;
				}
				const needsTarget =
					type === "move_to_folder" ||
					type === "apply_label" ||
					type === "remove_label";
				if (!needsTarget) delete target.dataset.messageTarget;
				const hasTarget =
					(candidates as readonly string[]).length > 0;
				checkbox.disabled = needsTarget && !hasTarget;
				target.hidden = !needsTarget;
				target.disabled = !needsTarget || !hasTarget;
				const applyAction = async (
					selected: boolean,
				): Promise<void> => {
					if (!selected) {
						await workspace.applyEdit({
							type: "set_message_action",
							messageAlias: alias,
							action: type,
							selected: false,
							...(type === "apply_label" ||
							type === "remove_label"
								? {
										labelAlias:
											currentAction?.type === "apply_label" ||
											currentAction?.type === "remove_label"
												? currentAction.labelAlias
												: target.value,
									}
								: {}),
						});
						return;
					}
					if (needsTarget && target.value === "") {
						checkbox.checked = false;
						alert.hidden = false;
						alert.textContent =
							"No sanitized target is available for this action.";
						return;
					}
					await workspace.applyEdit({
						type: "set_message_action",
						messageAlias: alias,
						action: type,
						selected: true,
						...(type === "move_to_folder"
							? { folderAlias: target.value }
							: type === "apply_label" ||
									type === "remove_label"
								? { labelAlias: target.value }
								: {}),
					});
				};
				checkbox.addEventListener("change", () => {
					if (checkbox.disabled) return;
					void run(() => applyAction(checkbox.checked));
				});
				target.addEventListener("change", () => {
					if (!checkbox.checked || target.disabled) return;
					void run(() => applyAction(true));
				});
					controlLabel.prepend(checkbox);
					exception.append(controlLabel, target);
				}
				const labelActionControls = element("fieldset");
				labelActionControls.appendChild(
					element("legend", "Label actions by target"),
				);
				for (const [labelIndex, labelAlias] of labelCandidates.entries()) {
					for (const [type, text] of [
						["apply_label", "Apply"],
						["remove_label", "Remove"],
					] as const) {
						const controlLabel = element(
							"label",
							`${text} Label ${labelIndex + 1}`,
						);
						const control = element("input");
						control.type = "checkbox";
						control.dataset.messageLabelAction = type;
						control.dataset.messageLabelTarget = labelAlias;
						control.dataset.focusKey =
							`message-${type}-${start + index}-${labelIndex}`;
						control.checked = messageActions.some(
							(candidate) =>
								candidate.type === type &&
								candidate.labelAlias === labelAlias,
						);
						control.addEventListener("change", () => {
							void run(async () => {
								await workspace.applyEdit({
									type: "set_message_action",
									messageAlias: alias,
									action: type,
									selected: control.checked,
									labelAlias,
								});
							});
						});
						controlLabel.prepend(control);
						labelActionControls.appendChild(controlLabel);
					}
				}
				labelActionControls.hidden = labelCandidates.length === 0;
				exception.appendChild(labelActionControls);
				const exclusion = element("label", "Exclude from cleanup");
			exclusion.dataset.messageExclusion = "";
			const checkbox = element("input");
			checkbox.type = "checkbox";
			checkbox.dataset.focusKey = `message-exclusion-${start + index}`;
			checkbox.checked =
				snapshot.excludedMessageAliases.includes(alias);
			checkbox.addEventListener("change", () => {
				void run(async () => {
					await workspace.applyEdit({
						type: checkbox.checked
							? "exclude_message"
							: "include_message",
						messageAlias: alias,
					});
				});
			});
			exclusion.prepend(checkbox);
			row.append(metadata, exception, exclusion);
			messageEditors.appendChild(row);

			const display = element("li");
			rawDisplayNodes.set(display, alias);
			displayList.appendChild(display);
		}

		for (const [index, alias] of snapshot.editorInventory.filterAliases
			.slice(start, start + pageSize)
			.entries()) {
			const label = element(
				"label",
				`Filter ${start + index + 1} action`,
			);
			label.dataset.filterEditor = "";
			const select = element("select");
			select.dataset.focusKey = `filter-${start + index}`;
			for (const [value, text] of [
				["review", "Review"],
				["deactivate_filter", "Deactivate filter"],
			] as const) {
				const option = element("option", text);
				option.value = value;
				select.appendChild(option);
			}
			select.value = snapshot.actions.some(
				(action) =>
					action.type === "deactivate_filter" &&
					action.filterAlias === alias,
			)
				? "deactivate_filter"
				: "review";
			select.addEventListener("change", () => {
				void run(async () => {
					await workspace.applyEdit({
						type: "set_filter_action",
						filterAlias: alias,
						action: select.value as
							| "deactivate_filter"
							| "review",
					});
				});
			});
			label.appendChild(select);
			filterEditors.appendChild(label);
		}
		for (const [index, plannedAction] of snapshot.actions
			.slice(start, start + pageSize)
			.entries()) {
			const item = element("li");
			const subject =
				"messageAlias" in plannedAction
					? `Message ${
							snapshot.editorInventory.messageAliases.indexOf(
								plannedAction.messageAlias,
							) + 1
						}`
					: `Filter ${
							snapshot.editorInventory.filterAliases.indexOf(
								plannedAction.filterAlias,
							) + 1
						}`;
			const destination =
				plannedAction.type === "move_to_folder"
					? ` · Folder ${
							snapshot.editorInventory.folderAliases.indexOf(
								plannedAction.folderAlias,
							) + 1
						}`
					: plannedAction.type === "apply_label" ||
							plannedAction.type === "remove_label"
						? ` · Label ${
								[
									...snapshot.editorInventory.labelAliases,
									...snapshot.editorInventory.tagAliases,
									...snapshot.editorInventory.categoryAliases,
								].indexOf(plannedAction.labelAlias) + 1
							}`
						: "";
			item.textContent = `${plannedAction.type.replaceAll("_", " ")} · ${subject}${destination}`;
			actionList.appendChild(item);
		}
		pageStatus.textContent = `Page ${editorPage + 1} of ${pageCount}`;
		previousPage.disabled = editorPage === 0;
		nextPage.disabled = editorPage + 1 >= pageCount;
		if (activeFocusKey !== undefined) {
			const replacement = [...editorContent.querySelectorAll<HTMLElement>(
				"[data-focus-key]",
			)].find(
				(control) => control.dataset.focusKey === activeFocusKey,
			);
			replacement?.focus();
		}
	};

	const scheduleExpiryCheck = (snapshot: MailboxPlanSnapshot): void => {
		bindingExpiryGeneration += 1;
		planExpiryGeneration += 1;
		if (bindingExpiryTimer !== undefined) {
			scheduler.clearTimeout(bindingExpiryTimer);
			bindingExpiryTimer = undefined;
		}
		if (planExpiryTimer !== undefined) {
			scheduler.clearTimeout(planExpiryTimer);
			planExpiryTimer = undefined;
		}
		if (disposed || snapshot.planExpired) return;
		const refreshStatus = (): void => {
			void run(async () => {
				await workspace.refreshStatus();
			});
		};
		const planGeneration = planExpiryGeneration;
		const schedulePlanDeadline = (): void => {
			if (disposed || planGeneration !== planExpiryGeneration) return;
			const remaining = snapshot.planExpiresAt - Date.now();
			planExpiryTimer = scheduler.setTimeout(() => {
				planExpiryTimer = undefined;
				if (
					disposed ||
					planGeneration !== planExpiryGeneration
				) {
					return;
				}
				if (Date.now() < snapshot.planExpiresAt) {
					schedulePlanDeadline();
					return;
				}
				clearRawDisplays();
				refreshStatus();
			}, Math.min(MAX_TIMER_DELAY_MS, Math.max(0, remaining)));
		};
		schedulePlanDeadline();
		if (snapshot.bindingAvailable) {
			const bindingGeneration = bindingExpiryGeneration;
			const scheduleBindingDeadline = (): void => {
				if (
					disposed ||
					bindingGeneration !== bindingExpiryGeneration
				) {
					return;
				}
				const remaining = snapshot.bindingExpiresAt - Date.now();
				bindingExpiryTimer = scheduler.setTimeout(() => {
					bindingExpiryTimer = undefined;
					if (
						disposed ||
						bindingGeneration !== bindingExpiryGeneration
					) {
						return;
					}
					if (Date.now() < snapshot.bindingExpiresAt) {
						scheduleBindingDeadline();
						return;
					}
					clearRawDisplays();
					refreshStatus();
				}, Math.min(MAX_TIMER_DELAY_MS, Math.max(0, remaining)));
			};
			scheduleBindingDeadline();
		}
	};

	const update = (snapshot: MailboxPlanSnapshot): void => {
		if (disposed) return;
		root.setAttribute(
			"aria-busy",
			String(snapshot.operationStatus !== "idle"),
		);
		foundCounts.textContent = [
			countLabel(snapshot.captureCounts.messages, "message"),
			countLabel(snapshot.captureCounts.folders, "folder"),
			countLabel(snapshot.captureCounts.labels, "label"),
			countLabel(snapshot.captureCounts.tags, "tag"),
			countLabel(snapshot.captureCounts.categories, "category"),
			countLabel(snapshot.captureCounts.filters, "filter"),
		].join(", ");
		coverage.textContent =
			snapshot.coverage === "partial"
				? `Partial scan: ${snapshot.captureCounts.messages} messages reviewed. Uncaptured messages: unknown.`
				: `Complete scan: ${snapshot.captureCounts.messages} messages reviewed.`;
		scrubbedSummary.textContent =
			"Only aliases, message state, attachment presence, dates, and scrubbed planning categories—not subjects, senders, or body text—are kept in this plan.";
		bindingExpiry.textContent = `Mailbox lookup data expires at ${new Date(
			snapshot.bindingExpiresAt,
		).toISOString()}.`;
		planExpiry.textContent = `Sanitized plan expires at ${new Date(
			snapshot.planExpiresAt,
		).toISOString()}.`;

		slider.value = String(snapshot.sliderPosition);
		slider.setAttribute(
			"aria-valuetext",
			choiceLabel(snapshot.selectedChoiceId),
		);
		for (const button of choiceButtons) {
			button.setAttribute(
				"aria-pressed",
				String(button.dataset.choice === snapshot.selectedChoiceId),
			);
		}
		outcome.textContent = `${snapshot.outcome.archived} messages archived, ${snapshot.outcome.markedRead} marked read, ${snapshot.outcome.review} to Review, 0 deleted.`;
		partialWarning.textContent =
			snapshot.coverage === "partial"
				? "Partial scan: only captured messages are included. Uncaptured messages will not be changed. Inbox Zero cannot be confirmed from this scan."
				: "";
		const operationCopy = {
			idle: "",
			saving: "Saving Draft",
			submitting: "Submitting to Chat",
			accepting: "Accepting Revision",
			canceling: "Canceling cleanup",
			editing: "Updating plan",
			reconnecting: "Reconnecting to Chat",
		} as const;
		live.textContent =
			snapshot.operationStatus !== "idle"
				? `In progress. ${operationCopy[snapshot.operationStatus]}.`
				: snapshot.chatMessage || snapshot.announcement;

		const empty = snapshot.captureCounts.messages === 0;
		emptyState.textContent = empty
			? "No Inbox messages were captured. There is nothing to clean up."
			: "";
		if (!snapshot.planExpired && editorContent.isConnected) {
			renderEditor(snapshot);
		}
		targetEditors.hidden = empty;
		cohortEditors.hidden = empty;
		messageEditors.hidden = empty;
		filterEditors.hidden = empty;
		paging.hidden = empty;
		displayList.hidden = empty || snapshot.planExpired;
		for (const [node, alias] of rawDisplayNodes) {
			node.textContent =
				!snapshot.bindingAvailable || snapshot.planExpired
					? ""
					: displayResolver?.(alias) ?? "";
		}

		if (snapshot.planExpired) {
			clearRawDisplays();
			alert.hidden = false;
			alert.textContent =
				"This mailbox cleanup plan has expired. Start a new scan.";
			editorContent.remove();
		} else if (snapshot.restartRequired || !snapshot.bindingAvailable) {
			clearRawDisplays();
			alert.hidden = false;
			alert.textContent =
				"Mailbox lookup data expired or changed. Save Draft is available, but restart with a fresh scan before accepting.";
		} else {
			alert.hidden = true;
			alert.textContent = "";
		}

		const editorDisabled =
			snapshot.transitionPending ||
			snapshot.restartRequired ||
			!snapshot.bindingAvailable;
		const terminal =
			snapshot.revision.state === "canceled" ||
			snapshot.revision.state === "completed" ||
			snapshot.revision.state === "in_flight";
		for (const control of editorContent.querySelectorAll(
			"input,select,button",
		)) {
			(control as HTMLInputElement).disabled =
				(control as HTMLInputElement).disabled ||
				editorDisabled ||
				terminal;
		}
		slider.disabled =
			empty ||
			snapshot.planExpired ||
			snapshot.transitionPending ||
			terminal;
		for (const button of choiceButtons) {
			button.disabled =
				empty ||
				snapshot.planExpired ||
				snapshot.transitionPending ||
				terminal;
		}
		save.disabled =
			empty ||
			snapshot.planExpired ||
			snapshot.transitionPending ||
			terminal;
		submit.disabled =
			empty ||
			snapshot.planExpired ||
			snapshot.transitionPending ||
			!snapshot.chatAvailable ||
			snapshot.restartRequired ||
			snapshot.revision.state !== "draft" ||
			terminal;
		accept.disabled =
			empty ||
			snapshot.planExpired ||
			snapshot.transitionPending ||
			snapshot.restartRequired ||
			!snapshot.bindingAvailable ||
			snapshot.revision.state !== "draft" ||
			terminal;
		reconnect.disabled =
			!snapshot.canReconnect ||
			snapshot.transitionPending ||
			snapshot.planExpired ||
			terminal;
		reconnect.hidden =
			!snapshot.canReconnect &&
			snapshot.chatStatus !== "reconnecting" &&
			snapshot.chatStatus !== "waiting";
		cancel.disabled = snapshot.transitionPending || terminal;

		const revisionState =
			snapshot.revision.state === "in_flight"
				? "In progress"
				: snapshot.revision.state;
		executionSummary.textContent = `Revision ${snapshot.revision.revisionNumber}: ${revisionState}${snapshot.restartRequired ? " · restart required" : ""}.`;
		const filterCount = snapshot.actions.filter(
			(action) => action.type === "deactivate_filter",
		).length;
		acceptExplanation.textContent = `Accepts exactly the actions shown, including ${filterCount} filter deactivations. No messages are deleted.`;
		scheduleExpiryCheck(snapshot);
	};

	const choose = (choice: MailboxChoiceId): void => {
		void run(async () => {
			await workspace.selectChoice(choice);
		});
	};
	for (const button of choiceButtons) {
		button.addEventListener("click", () => {
			choose(button.dataset.choice as MailboxChoiceId);
		});
	}
	slider.addEventListener("input", () => {
		const numeric = Number(slider.value);
		const nearest =
			numeric <= 25 ? "conservative" : numeric >= 75 ? "inbox_zero" : "balanced";
		choose(nearest);
	});
	slider.addEventListener("keydown", (event) => {
		if (!SLIDER_KEYS.has(event.key)) return;
		event.preventDefault();
		const current = Number(slider.value);
		let next = current;
		switch (event.key) {
			case "ArrowRight":
			case "ArrowUp":
			case "PageUp":
				next = Math.min(100, current + 50);
				break;
			case "ArrowLeft":
			case "ArrowDown":
			case "PageDown":
				next = Math.max(0, current - 50);
				break;
			case "Home":
				next = 0;
				break;
			case "End":
				next = 100;
				break;
		}
		slider.value = String(next);
		choose(
			next === 0
				? "conservative"
				: next === 50
					? "balanced"
					: "inbox_zero",
		);
	});

	save.addEventListener("click", () => {
		void run(async () => {
			await workspace.saveDraft();
		});
	});
	submit.addEventListener("click", () => {
		void run(async () => {
			await workspace.submitToChat();
		});
	});
	accept.addEventListener("click", () => {
		void run(async () => {
			await workspace.acceptRevision();
		});
	});
	cancel.addEventListener("click", () => {
		void run(async () => {
			await workspace.cancel();
		});
	});
	reconnect.addEventListener("click", () => {
		void run(async () => {
			await workspace.reconnectChat();
		});
	});
	previousPage.addEventListener("click", () => {
		editorPage = Math.max(0, editorPage - 1);
		update(workspace.getSnapshot());
	});
	nextPage.addEventListener("click", () => {
		editorPage += 1;
		update(workspace.getSnapshot());
	});

	const onPageHide = (): void => {
		clearRawDisplays();
	};
	window.addEventListener("pagehide", onPageHide);
	const unsubscribe = workspace.subscribe(update);
	update(initial);

	return () => {
		if (disposed) return;
		disposed = true;
		if (bindingExpiryTimer !== undefined) {
			scheduler.clearTimeout(bindingExpiryTimer);
			bindingExpiryTimer = undefined;
		}
		if (planExpiryTimer !== undefined) {
			scheduler.clearTimeout(planExpiryTimer);
			planExpiryTimer = undefined;
		}
		window.removeEventListener("pagehide", onPageHide);
		unsubscribe();
		clearRawDisplays();
		root.replaceChildren();
	};
}
