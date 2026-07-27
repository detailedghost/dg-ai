import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, afterEach, beforeEach, describe, it } from "node:test";
import { Window } from "happy-dom";
import {
	mountMailboxPlanPage,
	type MailboxPlanPageOptions,
} from "../lib/features/mailbox-cleanup/plan-page";
import { createMailboxCleanupChoices } from "../lib/features/mailbox-cleanup/planning";
import {
	ACCOUNT_ALIAS,
	captureResult,
	NEXT_REVISION_ALIAS,
	NOW_MS,
	RAW_DISPLAY_SENTINEL,
	RAW_LOCATOR_SENTINEL,
	revision,
} from "./mailbox-plan-page-fixtures";
import {
	type WorkspaceHarnessOptions,
	view,
	workspaceHarness,
} from "./mailbox-plan-page-harness";

const window = new Window({
	url: "chrome-extension://dg-ai/mailbox-plan.html",
});
const document = window.document as unknown as Document;
const activeDisposers = new Set<() => void>();
const globalDescriptors = {
	document: Object.getOwnPropertyDescriptor(globalThis, "document"),
	HTMLElement: Object.getOwnPropertyDescriptor(globalThis, "HTMLElement"),
	KeyboardEvent: Object.getOwnPropertyDescriptor(globalThis, "KeyboardEvent"),
	window: Object.getOwnPropertyDescriptor(globalThis, "window"),
};

Object.defineProperties(globalThis, {
	document: { configurable: true, value: document },
	HTMLElement: { configurable: true, value: window.HTMLElement },
	KeyboardEvent: { configurable: true, value: window.KeyboardEvent },
	window: { configurable: true, value: window },
});

after(() => {
	for (const [key, descriptor] of Object.entries(globalDescriptors)) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
});

beforeEach(() => {
	document.body.replaceChildren();
});

afterEach(() => {
	for (const dispose of activeDisposers) dispose();
	activeDisposers.clear();
});

function mount(
	options: WorkspaceHarnessOptions = {},
	pageOptions: MailboxPlanPageOptions = {},
) {
	const harness = workspaceHarness(options);
	const root = document.createElement("main");
	document.body.appendChild(root);
	let displayClears = 0;
	const disposePage = mountMailboxPlanPage(root, harness.workspace, {
		resolveDisplayText(alias: string) {
			return alias.startsWith("msg_") ? RAW_DISPLAY_SENTINEL : undefined;
		},
		clearDisplayText() {
			displayClears += 1;
			pageOptions.clearDisplayText?.();
		},
		...pageOptions,
	});
	const dispose = (): void => {
		activeDisposers.delete(dispose);
		disposePage();
	};
	activeDisposers.add(dispose);
	return {
		...harness,
		dispose,
		getDisplayClearCount: () => displayClears,
		root,
	};
}

function buttonNamed(root: HTMLElement, name: string): HTMLButtonElement {
	const button = [...root.querySelectorAll("button")].find(
		(item) => item.textContent?.trim() === name,
	) as HTMLButtonElement | undefined;
	if (!button) throw new Error(`Missing button: ${name}`);
	return button;
}

function attributeCorpus(root: HTMLElement): string {
	return [...root.querySelectorAll("*")]
		.flatMap((element) =>
			[...element.attributes].map(
				(attribute) => `${attribute.name}=${attribute.value}`,
			),
		)
		.join("\n");
}

async function settleDom(): Promise<void> {
	await new Promise<void>((resolve) => {
		setTimeout(resolve, 0);
	});
}

async function waitFor(
	condition: () => boolean,
	message: string,
): Promise<void> {
	for (let attempt = 0; attempt < 20; attempt += 1) {
		if (condition()) return;
		await Promise.resolve();
	}
	throw new Error(message);
}

function deferred<T = void>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((next, fail) => {
		resolve = next;
		reject = fail;
	});
	return { promise, reject, resolve };
}

function fakeScheduler() {
	const tasks = new Map<object, () => void>();
	const callbacks: Array<() => void> = [];
	return {
		callbacks: () => [...callbacks],
		clearTimeout(timer: unknown) {
			if (typeof timer === "object" && timer !== null) tasks.delete(timer);
		},
		fireAll() {
			const pending = [...tasks.values()];
			tasks.clear();
			for (const callback of pending) callback();
		},
		setTimeout(callback: () => void) {
			const id = {};
			tasks.set(id, callback);
			callbacks.push(callback);
			return id;
		},
		size: () => tasks.size,
	};
}

function captureWithoutTargets() {
	const original = captureResult();
	const inventory = {
		...original.inventory,
		folders: [],
		labels: [],
		filters: [],
	};
	const metadata = { tags: [], categories: [] };
	const capture = {
		...original,
		inventory,
		metadata,
		counts: {
			...original.counts,
			folders: 0,
			labels: 0,
			tags: 0,
			categories: 0,
			filters: 0,
		},
		choices: createMailboxCleanupChoices(inventory, metadata),
	};
	return {
		capture,
		baseRevision: revision({
			targets: {
				folderAliases: [],
				labelAliases: [],
				filterAliases: [],
			},
			actions: revision().actions.filter(
				(action) => action.type !== "deactivate_filter",
			),
		}),
	};
}

function captureWithCohorts(count: number) {
	const capture = captureResult({ count });
	const template = capture.cohorts[0]!;
	const cohorts = capture.inventory.messages.map((message, index) => ({
		...template,
		cohortKey: `editor-page-${index}`,
		category: message.category,
		messageAliases: [message.alias],
		suggestedActions: [],
	}));
	return {
		capture: { ...capture, cohorts },
		baseRevision: revision({
			actions:
				capture.choices.find((choice) => choice.id === "conservative")
					?.actions ?? [],
			cohorts,
		}),
	};
}

function contrastRatio(left: string, right: string): number {
	const luminance = (hex: string): number => {
		const channels = [1, 3, 5].map((offset) => {
			const value = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
			return value <= 0.04045
				? value / 12.92
				: ((value + 0.055) / 1.055) ** 2.4;
		});
		return (
			0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!
		);
	};
	const [lighter, darker] = [luminance(left), luminance(right)].sort(
		(a, b) => b - a,
	);
	return (lighter! + 0.05) / (darker! + 0.05);
}

describe("mountMailboxPlanPage Node DOM smoke", () => {
	it("renders the six areas, exact inventory coverage, expiry, partial, restart, and plan-expired states", () => {
		const complete = mount();
		const headings = [...complete.root.querySelectorAll("h1,h2,h3")].map(
			(element) => element.textContent?.trim(),
		);
		for (const area of [
			"Found",
			"Scrubbed",
			"Temporary data expiry",
			"Suggested cleanup",
			"Editor",
			"Execution status",
		]) {
			assert.equal(headings.filter((heading) => heading === area).length, 1);
		}
		const completeText = complete.root.textContent ?? "";
		for (const count of [
			"8 messages",
			"1 folder",
			"1 label",
			"1 tag",
			"1 category",
			"1 filter",
			`${view(complete.workspace).reviewMessageAliases.length} to Review`,
		]) {
			assert.ok(completeText.includes(count), `missing ${count}`);
		}
		assert.ok(
			completeText.includes(
				"This deletes DeeGee’s temporary mailbox lookup data—not messages.",
			),
		);
		assert.ok(
			completeText.includes(new Date(NOW_MS + 60 * 60 * 1_000).toISOString()),
		);
		assert.ok(
			completeText.includes(
				new Date(NOW_MS + 30 * 24 * 60 * 60 * 1_000).toISOString(),
			),
		);
		complete.dispose();

		const partial = mount({ partial: true });
		const partialText = partial.root.textContent ?? "";
		assert.ok(
			partialText.includes(
				"Partial scan: 8 messages reviewed. Uncaptured messages: unknown.",
			),
		);
		assert.ok(
			partialText.includes("Inbox Zero cannot be confirmed from this scan."),
		);
		assert.ok(!partialText.includes("Inbox Zero complete"));
		partial.dispose();

		const restart = mount({ restartRequired: true });
		assert.match(
			restart.root.querySelector('[role="alert"]')?.textContent ?? "",
			/restart/,
		);
		assert.ok((restart.root.textContent ?? "").includes("Save Draft"));
		assert.equal(buttonNamed(restart.root, "Accept Revision").disabled, true);
		restart.dispose();

		const expired = mount({ planExpiresAt: NOW_MS });
		assert.match(
			expired.root.querySelector('[role="alert"]')?.textContent ?? "",
			/expired/,
		);
		assert.equal(expired.root.querySelector("[data-mailbox-editor]"), null);
		assert.ok(!(expired.root.textContent ?? "").includes(RAW_DISPLAY_SENTINEL));
		expired.dispose();
	});

	it("keeps raw display text out of forbidden sinks and clears it on pagehide, binding expiry, and disposal", async () => {
		const harness = mount();
		assert.ok((harness.root.textContent ?? "").includes(RAW_DISPLAY_SENTINEL));
		const attributes = attributeCorpus(harness.root);
		for (const forbidden of [
			RAW_DISPLAY_SENTINEL,
			RAW_LOCATOR_SENTINEL,
			ACCOUNT_ALIAS,
		]) {
			assert.ok(!attributes.includes(forbidden));
		}
		for (const element of harness.root.querySelectorAll(
			"input,select,textarea",
		)) {
			assert.ok(
				!(element as HTMLInputElement).value.includes(RAW_DISPLAY_SENTINEL),
			);
		}
		assert.ok(!window.location.href.includes(RAW_DISPLAY_SENTINEL));
		assert.equal(window.location.hash, "");

		window.dispatchEvent(new window.Event("pagehide"));
		assert.ok(!(harness.root.textContent ?? "").includes(RAW_DISPLAY_SENTINEL));
		harness.dispose();
		assert.equal(harness.root.childElementCount, 0);

		const race = mount();
		const accept = buttonNamed(race.root, "Accept Revision");
		race.setBindingAvailable(false);
		accept.focus();
		accept.click();
		await settleDom();

		assert.ok(!(race.root.textContent ?? "").includes(RAW_DISPLAY_SENTINEL));
		const alert = race.root.querySelector('[role="alert"]');
		assert.match(alert?.textContent ?? "", /restart/);
		assert.ok(
			document.activeElement === alert ||
				Boolean(alert?.contains(document.activeElement)),
		);
		assert.notEqual(race.root.querySelector("[data-mailbox-editor]"), null);
		assert.equal(buttonNamed(race.root, "Save Draft").disabled, false);
		assert.equal(buttonNamed(race.root, "Accept Revision").disabled, true);
		race.dispose();
	});

	it("supports every slider key, equivalent buttons, focus retention, and exact ARIA/live behavior", async () => {
		const { dispose, root } = mount();
		const slider = root.querySelector(
			'input[type="range"]',
		) as HTMLInputElement | null;
		assert.notEqual(slider, null);
		if (!slider) throw new Error("Missing cleanup level slider");
		assert.equal(slider.getAttribute("aria-label"), "Cleanup level");
		assert.equal(slider.min, "0");
		assert.equal(slider.max, "100");
		assert.equal(slider.step, "50");
		assert.equal(slider.getAttribute("aria-valuetext"), "Conservative");
		const live = root.querySelector(
			'[role="status"][aria-live="polite"][aria-atomic="true"]',
		);
		assert.equal(live?.textContent, "");

		const choices = [
			buttonNamed(root, "Conservative"),
			buttonNamed(root, "Balanced"),
			buttonNamed(root, "Inbox Zero"),
		];
		assert.deepEqual(
			choices.map((button) => button.getAttribute("aria-pressed")),
			["true", "false", "false"],
		);
		choices[1]!.focus();
		choices[1]!.click();
		await settleDom();
		assert.equal(document.activeElement, choices[1]);
		assert.equal(slider.value, "50");
		assert.equal(slider.getAttribute("aria-valuetext"), "Balanced");
		assert.match(
			live?.textContent ?? "",
			/^Balanced selected\. \d+ messages archived, \d+ marked read, \d+ to Review, 0 deleted\.$/,
		);
		assert.ok(!(live?.textContent ?? "").includes(RAW_DISPLAY_SENTINEL));

		for (const [key, expected, valueText] of [
			["ArrowRight", "100", "Inbox Zero"],
			["ArrowLeft", "50", "Balanced"],
			["ArrowDown", "0", "Conservative"],
			["ArrowUp", "50", "Balanced"],
			["PageUp", "100", "Inbox Zero"],
			["PageDown", "50", "Balanced"],
			["Home", "0", "Conservative"],
			["End", "100", "Inbox Zero"],
		] as const) {
			slider.focus();
			const event = new window.KeyboardEvent("keydown", {
				bubbles: true,
				cancelable: true,
				key,
			});
			slider.dispatchEvent(event as unknown as Event);
			await settleDom();
			assert.equal(event.defaultPrevented, true);
			assert.equal(slider.value, expected);
			assert.equal(slider.getAttribute("aria-valuetext"), valueText);
			assert.equal(document.activeElement, slider);
		}
		dispose();
	});

	it("keeps visual focus order and workflow actions distinct", () => {
		const { dispose, root } = mount();
		const focusOrder = [
			root.querySelector('[role="alert"]'),
			root.querySelector('input[aria-label="Cleanup level"]'),
			buttonNamed(root, "Conservative"),
			buttonNamed(root, "Balanced"),
			buttonNamed(root, "Inbox Zero"),
			root.querySelector(
				"[data-mailbox-editor] select,[data-mailbox-editor] input",
			),
			buttonNamed(root, "Save Draft"),
			buttonNamed(root, "Submit to Chat"),
			buttonNamed(root, "Accept Revision"),
			buttonNamed(root, "Cancel cleanup"),
		].filter((element): element is Element => element !== null);
		for (let index = 1; index < focusOrder.length; index += 1) {
			assert.notEqual(
				focusOrder[index - 1]!.compareDocumentPosition(focusOrder[index]!) &
					window.Node.DOCUMENT_POSITION_FOLLOWING,
				0,
			);
		}
		const text = root.textContent ?? "";
		assert.ok(
			text.includes(
				"Sends a newly scrubbed copy; it does not accept the plan.",
			),
		);
		assert.match(
			text,
			/Accepts exactly the actions shown, including \d+ filter deactivations\. No messages are deleted\./,
		);
		assert.match(text, /proposal.*Draft/i);
		dispose();
	});

	it("keeps empty captures safe and the 5000-message DOM bounded by cohorts", () => {
		const empty = mount({ count: 0 });
		assert.ok(
			(empty.root.textContent ?? "").includes(
				"No Inbox messages were captured. There is nothing to clean up.",
			),
		);
		for (const name of ["Save Draft", "Submit to Chat", "Accept Revision"]) {
			assert.equal(buttonNamed(empty.root, name).disabled, true);
		}
		assert.equal(buttonNamed(empty.root, "Cancel cleanup").disabled, false);
		empty.dispose();

		const maximum = mount({ count: 5_000 });
		const cohort = captureResult({ count: 5_000 }).cohorts[0]!;
		const maximumText = maximum.root.textContent ?? "";
		assert.ok(maximumText.includes(cohort.category));
		assert.ok(maximumText.includes(cohort.ageBucket));
		assert.ok(maximumText.includes(String(cohort.messageAliases.length)));
		assert.ok(
			maximum.root.querySelectorAll("[data-message-editor]").length <= 20,
		);
		assert.ok(
			maximum.root.querySelectorAll("[data-cohort-editor]").length <= 20,
		);
		assert.ok(maximumText.includes("5000 messages"));
		assert.ok(
			maximum.root.querySelectorAll("[data-action-list] li").length <= 20,
			"action display list must remain bounded",
		);
		maximum.dispose();
	});

	it("renders and synchronizes bounded target, exception, exclusion, and filter editors", async () => {
		const harness = mount();
		const targetEditors = harness.root.querySelectorAll("[data-target-editor]");
		assert.ok(
			targetEditors.length >= 5,
			"folder, label, tag, category, filter",
		);
		assert.ok(
			harness.root.querySelectorAll("[data-message-exception]").length > 0,
		);
		assert.ok(
			harness.root.querySelectorAll("[data-message-exclusion]").length > 0,
		);
		assert.equal(
			harness.root.querySelectorAll("[data-filter-editor]").length,
			1,
		);
		assert.ok((harness.root.textContent ?? "").includes("Category 1"));
		assert.ok(!(harness.root.textContent ?? "").includes("Categorie 1"));

		const target = harness.root.querySelector(
			"[data-target-editor] input[type=checkbox]",
		) as HTMLInputElement | null;
		assert.notEqual(target, null);
		const beforeTargets = Object.values(view(harness.workspace).targets).flat()
			.length;
		target!.click();
		await settleDom();
		assert.notEqual(
			Object.values(view(harness.workspace).targets).flat().length,
			beforeTargets,
		);
		assert.equal(target!.checked, false);

		const exception = harness.root.querySelector(
			'[data-message-action="archive"]',
		) as HTMLInputElement | null;
		assert.notEqual(exception, null);
		if (!exception!.checked) exception!.click();
		await settleDom();
		assert.ok(
			view(harness.workspace).actions.some(
				(action) => action.type === "archive",
			),
		);
		assert.equal(exception!.checked, true);

		const exclusion = harness.root.querySelector(
			"[data-message-exclusion] input[type=checkbox]",
		) as HTMLInputElement | null;
		assert.notEqual(exclusion, null);
		exclusion!.click();
		await settleDom();
		assert.ok(view(harness.workspace).excludedMessageAliases.length > 0);
		assert.equal(exclusion!.checked, true);

		const filter = harness.root.querySelector(
			"[data-filter-editor] select",
		) as HTMLSelectElement | null;
		assert.notEqual(filter, null);
		filter!.value = "deactivate_filter";
		filter!.dispatchEvent(
			new window.Event("change", { bubbles: true }) as unknown as Event,
		);
		await settleDom();
		assert.ok(
			view(harness.workspace).actions.some(
				(action) => action.type === "deactivate_filter",
			),
		);
		assert.equal(filter!.value, "deactivate_filter");
		harness.dispose();
	});

	it("pages more than twenty cohorts without creating an unbounded editor", async () => {
		const fixture = captureWithCohorts(25);
		const harness = mount(fixture);
		assert.equal(
			harness.root.querySelectorAll("[data-cohort-editor]").length,
			20,
		);
		assert.match(
			harness.root.querySelector("[data-editor-page]")?.textContent ?? "",
			/1.*2/,
		);
		const next = [...harness.root.querySelectorAll("button")].find((button) =>
			/next/i.test(button.textContent ?? ""),
		) as HTMLButtonElement | undefined;
		assert.ok(next);
		next!.click();
		await settleDom();
		assert.equal(
			harness.root.querySelectorAll("[data-cohort-editor]").length,
			5,
		);
		assert.match(
			harness.root.querySelector("[data-editor-page]")?.textContent ?? "",
			/2.*2/,
		);
		harness.dispose();
	});

	it("disables terminal revisions and exposes aria-busy live operation feedback", async () => {
		for (const state of ["in_flight", "canceled", "completed"] as const) {
			const terminal = mount({
				baseRevision: revision({ state }),
			});
			for (const control of terminal.root.querySelectorAll(
				"button,input,select",
			)) {
				assert.equal(
					(control as HTMLInputElement).disabled,
					true,
					`${state} control remained enabled: ${control.textContent}`,
				);
			}
			terminal.dispose();
		}

		const fingerprint = deferred();
		const pending = mount({ fingerprintGate: fingerprint.promise });
		buttonNamed(pending.root, "Accept Revision").click();
		await Promise.resolve();
		assert.equal(pending.root.getAttribute("aria-busy"), "true");
		assert.equal(
			pending.root.querySelector('[role="status"]')?.textContent,
			"In progress. Accepting Revision.",
		);
		fingerprint.resolve();
		await settleDom();
		assert.equal(pending.root.getAttribute("aria-busy"), "false");
		assert.equal(buttonNamed(pending.root, "Accept Revision").disabled, true);
		pending.dispose();
	});

	it("shows recoverable chat status and reconnects exactly once", async () => {
		const chat = deferred<unknown>();
		const harness = mount({ bridgeResults: [chat.promise] });
		buttonNamed(harness.root, "Submit to Chat").click();
		await waitFor(
			() => harness.bridgeSubmissions.length > 0,
			"Submit did not reach the chat bridge",
		);
		chat.reject(
			Object.assign(new Error("disconnected"), { code: "disconnected" }),
		);
		await settleDom();

		const reconnect = buttonNamed(harness.root, "Reconnect");
		assert.equal(reconnect.disabled, false);
		assert.match(
			harness.root.querySelector('[role="status"]')?.textContent ?? "",
			/reconnect|disconnected/i,
		);
		reconnect.click();
		await settleDom();
		expectSingle(harness.bridgeReconnects);
		assert.equal(reconnect.disabled, true);
		harness.dispose();
	});

	it("clears display state at passive exact expiry and reschedules renewed expiry", async () => {
		const scheduler = fakeScheduler();
		const clearCalls: number[] = [];
		const renewedBindingExpiresAt = NOW_MS + 2_000;
		const harness = mount(
			{
				bindingExpiresAt: NOW_MS + 1_000,
				renewedBindingExpiresAt,
			},
			{
				clearDisplayText: () => clearCalls.push(clearCalls.length + 1),
				scheduler,
			},
		);
		assert.ok(scheduler.size() > 0);
		const staleCallbacks = scheduler.callbacks();
		buttonNamed(harness.root, "Balanced").click();
		await settleDom();
		assert.ok(
			(harness.root.textContent ?? "").includes(
				new Date(renewedBindingExpiresAt).toISOString(),
			),
		);

		harness.setNow(NOW_MS + 1_000);
		for (const callback of staleCallbacks) callback();
		await settleDom();
		assert.ok(
			(harness.root.textContent ?? "").includes(RAW_DISPLAY_SENTINEL),
			"stale pre-renewal timer must not clear display text",
		);

		harness.setNow(renewedBindingExpiresAt);
		harness.setBindingAvailable(false);
		scheduler.fireAll();
		await settleDom();
		assert.ok(!(harness.root.textContent ?? "").includes(RAW_DISPLAY_SENTINEL));
		assert.ok(clearCalls.length > 0);
		assert.equal(buttonNamed(harness.root, "Accept Revision").disabled, true);
		harness.dispose();

		const planScheduler = fakeScheduler();
		const plan = mount(
			{ planExpiresAt: NOW_MS + 1_000 },
			{ scheduler: planScheduler },
		);
		plan.setNow(NOW_MS + 1_000);
		planScheduler.fireAll();
		await settleDom();
		assert.equal(plan.root.querySelector("[data-mailbox-editor]"), null);
		assert.match(
			plan.root.querySelector('[role="alert"]')?.textContent ?? "",
			/expired/i,
		);
		plan.dispose();
	});

	it("clears raw display at the exact deadline before gated status resolves", async () => {
		const scheduler = fakeScheduler();
		const status = deferred();
		const harness = mount(
			{
				bindingExpiresAt: NOW_MS + 1_000,
				statusGate: status.promise,
			},
			{ scheduler },
		);
		assert.ok((harness.root.textContent ?? "").includes(RAW_DISPLAY_SENTINEL));

		harness.setNow(NOW_MS + 1_000);
		harness.setBindingAvailable(false);
		scheduler.fireAll();
		await Promise.resolve();
		await Promise.resolve();
		assert.ok(
			!(harness.root.textContent ?? "").includes(RAW_DISPLAY_SENTINEL),
			"exact local expiry must clear raw display before storage status returns",
		);

		status.resolve();
		await settleDom();
		assert.equal(buttonNamed(harness.root, "Accept Revision").disabled, true);
		harness.dispose();
	});

	it("removes the editor at plan expiry even when binding expiry happened first", async () => {
		const scheduler = fakeScheduler();
		const harness = mount(
			{
				bindingExpiresAt: NOW_MS + 1_000,
				planExpiresAt: NOW_MS + 2_000,
			},
			{ scheduler },
		);

		harness.setNow(NOW_MS + 1_000);
		harness.setBindingAvailable(false);
		scheduler.fireAll();
		await settleDom();
		assert.notEqual(harness.root.querySelector("[data-mailbox-editor]"), null);
		assert.ok(
			scheduler.size() > 0,
			"plan expiry must remain scheduled after binding expiry",
		);

		harness.setNow(NOW_MS + 2_000);
		scheduler.fireAll();
		await settleDom();
		assert.equal(harness.root.querySelector("[data-mailbox-editor]"), null);
		assert.match(
			harness.root.querySelector('[role="alert"]')?.textContent ?? "",
			/plan.*expired/i,
		);
		harness.dispose();
	});

	it("starts closed with Submit disabled, reconnects once, and preserves raw display text on recoverable chat errors", async () => {
		const closed = mount({ bridgeInitiallyOpen: false });
		assert.equal(buttonNamed(closed.root, "Submit to Chat").disabled, true);
		assert.equal(buttonNamed(closed.root, "Reconnect").disabled, false);
		buttonNamed(closed.root, "Reconnect").click();
		await settleDom();
		assert.equal(closed.bridgeReconnects.length, 1);
		assert.equal(buttonNamed(closed.root, "Submit to Chat").disabled, false);
		buttonNamed(closed.root, "Submit to Chat").click();
		await settleDom();
		assert.equal(closed.bridgeSubmissions.length, 1);
		closed.dispose();

		const chat = deferred<unknown>();
		const recoverable = mount({ bridgeResults: [chat.promise] });
		buttonNamed(recoverable.root, "Submit to Chat").click();
		await waitFor(
			() => recoverable.bridgeSubmissions.length > 0,
			"Submit did not reach the chat bridge",
		);
		chat.reject(
			Object.assign(new Error(RAW_DISPLAY_SENTINEL), {
				code: "disconnected",
			}),
		);
		await settleDom();
		assert.ok(
			(recoverable.root.textContent ?? "").includes(RAW_DISPLAY_SENTINEL),
			"recoverable chat failure must not clear local display text",
		);
		assert.doesNotMatch(
			recoverable.root.querySelector('[role="alert"]')?.textContent ?? "",
			/restart|fresh scan/i,
		);
		assert.equal(buttonNamed(recoverable.root, "Reconnect").disabled, false);
		recoverable.dispose();
	});

	it("rolls back failed automatic chat proposals before later acceptance", async () => {
		const planExpiresAt = NOW_MS + 30 * 24 * 60 * 60 * 1_000;
		const cases = [
			{
				name: "lifecycle edit",
				prepare(harness: ReturnType<typeof mount>) {
					harness.setLifecycleEditError(new Error(RAW_LOCATOR_SENTINEL));
				},
				recover(harness: ReturnType<typeof mount>) {
					harness.setLifecycleEditError(undefined);
				},
			},
			{
				name: "binding rebind",
				prepare(harness: ReturnType<typeof mount>) {
					harness.setRawBindingGetError(new Error(RAW_LOCATOR_SENTINEL));
				},
				recover(harness: ReturnType<typeof mount>) {
					harness.setRawBindingGetError(undefined);
				},
			},
			{
				name: "binding status",
				prepare(harness: ReturnType<typeof mount>) {
					harness.setBindingStatusErrorAtCall(
						harness.bindingStatusCalls.length + 2,
						new Error(RAW_LOCATOR_SENTINEL),
					);
				},
				recover(harness: ReturnType<typeof mount>) {
					harness.setBindingStatusErrorAtCall(0, undefined);
				},
			},
			{
				name: "plan expiry",
				prepare(harness: ReturnType<typeof mount>) {
					harness.setNow(planExpiresAt);
				},
			},
		] as const;

		for (const scenario of cases) {
			const proposalGate = deferred<unknown>();
			const harness = mount({
				bridgeResults: [proposalGate.promise],
				planExpiresAt,
			});
			const before = structuredClone(view(harness.workspace));
			buttonNamed(harness.root, "Submit to Chat").click();
			await waitFor(
				() => harness.bridgeSubmissions.length === 1,
				`${scenario.name} proposal did not reach chat`,
			);
			scenario.prepare(harness);
			proposalGate.resolve({
				status: "proposal",
				proposal: revision({
					revisionAlias: NEXT_REVISION_ALIAS,
					actions: [
						{
							type: "mark_read",
							messageAlias:
								captureResult().inventory.messages[1]!.alias,
						},
					],
				}),
			});
			await settleDom();

			const after = view(harness.workspace);
			assert.deepEqual(after.revision, before.revision, scenario.name);
			assert.deepEqual(after.actions, before.actions, scenario.name);
			assert.deepEqual(after.targets, before.targets, scenario.name);
			assert.equal(after.dirty, before.dirty, scenario.name);
			const errorText =
				harness.root.querySelector('[role="alert"]')?.textContent ?? "";
			assert.ok(errorText.length > 0, `${scenario.name} error was not shown`);
			assert.ok(!errorText.includes(RAW_DISPLAY_SENTINEL), scenario.name);
			assert.ok(!errorText.includes(RAW_LOCATOR_SENTINEL), scenario.name);
			switch (scenario.name) {
				case "lifecycle edit":
					assert.equal(
						harness.lifecycleCalls.filter((call) => call[0] === "edit")
							.length,
						1,
					);
					break;
				case "binding rebind":
					assert.equal(harness.bindingGetCalls.length, 1);
					break;
				case "binding status":
					assert.equal(harness.bindingStatusCalls.length, 3);
					break;
				case "plan expiry":
					assert.equal(after.planExpired, true);
					break;
			}

			if ("recover" in scenario) {
				scenario.recover(harness);
				buttonNamed(harness.root, "Accept Revision").click();
				await settleDom();
				assert.equal(
					view(harness.workspace).revision.state,
					"approved",
					scenario.name,
				);
				assert.deepEqual(
					view(harness.workspace).actions,
					before.actions,
					scenario.name,
				);
				assert.deepEqual(
					harness.fingerprintInputs.at(-1)?.actions,
					before.actions,
					scenario.name,
				);
			} else {
				assert.equal(
					buttonNamed(harness.root, "Accept Revision").disabled,
					true,
				);
			}
			harness.dispose();
		}
	});

	it("blocks the UI when binding invalidation wins after the approval transition", async () => {
		const harness = mount({ transitionInvalidatesBinding: true });
		buttonNamed(harness.root, "Accept Revision").click();
		await settleDom();

		assert.match(
			harness.root.querySelector('[role="alert"]')?.textContent ?? "",
			/restart|expired/i,
		);
		assert.equal(buttonNamed(harness.root, "Accept Revision").disabled, true);
		assert.ok(!(harness.root.textContent ?? "").includes(RAW_DISPLAY_SENTINEL));
		assert.equal(view(harness.workspace).revision.state, "approved");
		harness.dispose();
	});

	it("renders Mixed cohorts and truthfully controls and lists compound per-message actions", async () => {
		const capture = captureResult();
		const messageAlias = capture.inventory.messages[0]!.alias;
		const labelAlias = capture.inventory.labels[0]!.alias;
		const compoundActions = [
			{ type: "archive" as const, messageAlias },
			{ type: "mark_read" as const, messageAlias },
			{ type: "apply_label" as const, messageAlias, labelAlias },
		];
		const compound = mount({
			baseRevision: revision({ actions: compoundActions }),
		});
		const row = compound.root.querySelector(
			"[data-message-editor]",
		) as HTMLElement | null;
		assert.notEqual(row, null);
		assert.match(
			compound.root.textContent ?? "",
			/select each action independently.*more than one action/i,
		);
		const controls = [
			...row!.querySelectorAll<HTMLInputElement>("[data-message-action]"),
		];
		assert.deepEqual(
			controls.map((control) => control.dataset.messageAction),
			["archive", "mark_read", "move_to_folder", "apply_label", "remove_label"],
		);
		assert.deepEqual(
			controls
				.filter((control) => control.checked)
				.map((control) => control.dataset.messageAction),
			["archive", "mark_read", "apply_label"],
		);
		const listed = [
			...compound.root.querySelectorAll("[data-action-list] li"),
		].map((item) => item.textContent ?? "");
		for (const action of ["archive", "mark read", "apply label"]) {
			assert.ok(
				listed.some((item) => item.includes(action)),
				`compound action omitted from list: ${action}`,
			);
		}

		const markRead = row!.querySelector<HTMLInputElement>(
			'[data-message-action="mark_read"]',
		)!;
		markRead.click();
		await settleDom();
		const messageActions = view(compound.workspace).actions.filter(
			(action) =>
				"messageAlias" in action && action.messageAlias === messageAlias,
		);
		assert.deepEqual(
			messageActions.map((action) => action.type),
			["archive", "apply_label"],
			"one explicit edit must not replace unrelated compound actions",
		);
		compound.dispose();

		const harness = mount();
		const cohort = captureResult().cohorts[0]!;
		const firstAlias = cohort.messageAliases[0]!;
		const secondAlias = cohort.messageAliases[1]!;
		await harness.workspace.applyEdit({
			type: "set_message_exception",
			messageAlias: firstAlias,
			action: "archive",
		});
		await harness.workspace.applyEdit({
			type: "set_message_exception",
			messageAlias: secondAlias,
			action: "mark_read",
		});
		await settleDom();

		const cohortSelect = harness.root.querySelector(
			"[data-cohort-editor] select",
		) as HTMLSelectElement | null;
		assert.notEqual(cohortSelect, null);
		assert.equal(cohortSelect!.value, "mixed");
		assert.equal(
			cohortSelect!.querySelector('option[value="mixed"]')?.textContent,
			"Mixed",
		);
		const actionList = harness.root.querySelector("[data-action-list]");
		assert.notEqual(actionList, null);
		assert.equal(
			actionList!.querySelectorAll("li").length,
			view(harness.workspace).actions.length,
		);

		for (const actionValue of [
			"move_to_folder",
			"apply_label",
			"remove_label",
		] as const) {
			const messageRow = harness.root.querySelector(
				"[data-message-editor]",
			) as HTMLElement | null;
			assert.notEqual(messageRow, null);
			const action = messageRow!.querySelector<HTMLInputElement>(
				`[data-message-action="${actionValue}"]`,
			);
			assert.notEqual(action, null);
			assert.equal(action!.disabled, false);
			action!.focus();
			action!.click();
			await settleDom();
			const updatedMessageRow = harness.root.querySelector(
				"[data-message-editor]",
			) as HTMLElement | null;
			assert.notEqual(updatedMessageRow, null);
			const target = updatedMessageRow!.querySelector(
				`[data-message-target="${actionValue}"]`,
			) as HTMLSelectElement | null;
			assert.notEqual(target, null);
			assert.ok(target!.options.length > 0);
			target!.focus();
			target!.value = target!.options[0]!.value;
			target!.dispatchEvent(
				new window.Event("change", { bubbles: true }) as unknown as Event,
			);
			await settleDom();
			assert.equal(
				view(harness.workspace).actions.some(
					(candidate) => candidate.type === actionValue,
				),
				true,
			);
		}
		harness.dispose();
	});

	it("renders and edits every active label target independently without dropping sibling actions", async () => {
		const capture = captureResult();
		const messageAlias = capture.inventory.messages[0]!.alias;
		const [firstLabel, secondLabel, thirdLabel] = [
			...capture.inventory.labels.map((item) => item.alias),
			...capture.metadata.tags.map((item) => item.alias),
			...capture.metadata.categories.map((item) => item.alias),
		];
		assert.ok(firstLabel && secondLabel && thirdLabel);
		const initialActions = [
			{ type: "apply_label" as const, messageAlias, labelAlias: firstLabel },
			{ type: "apply_label" as const, messageAlias, labelAlias: secondLabel },
			{ type: "remove_label" as const, messageAlias, labelAlias: secondLabel },
			{ type: "remove_label" as const, messageAlias, labelAlias: thirdLabel },
		];
		const harness = mount({
			baseRevision: revision({ actions: initialActions }),
		});
		const actionSet = (
			actions: readonly Readonly<Record<string, unknown>>[],
		): string[] => actions.map((action) => JSON.stringify(action)).sort();
		const labelControl = (
			action: "apply_label" | "remove_label",
			target: string,
		): HTMLInputElement => {
			const control = harness.root.querySelector<HTMLInputElement>(
				`[data-message-label-action="${action}"][data-message-label-target="${target}"]`,
			);
			assert.notEqual(control, null);
			return control!;
		};
		const checkedPairs = (): string[] =>
			[
				...harness.root.querySelectorAll<HTMLInputElement>(
					"[data-message-label-action][data-message-label-target]",
				),
			]
				.filter((control) => control.checked)
				.map(
					(control) =>
						`${control.dataset.messageLabelAction}:${control.dataset.messageLabelTarget}`,
				)
				.sort();

		assert.deepEqual(checkedPairs(), [
			`apply_label:${firstLabel}`,
			`apply_label:${secondLabel}`,
			`remove_label:${secondLabel}`,
			`remove_label:${thirdLabel}`,
		].sort());

		labelControl("apply_label", firstLabel).click();
		await settleDom();
		const afterRemoval = initialActions.filter(
			(action) =>
				!(
					action.type === "apply_label" &&
					action.labelAlias === firstLabel
				),
		);
		assert.deepEqual(
			actionSet(view(harness.workspace).actions),
			actionSet(afterRemoval),
		);
		assert.deepEqual(checkedPairs(), [
			`apply_label:${secondLabel}`,
			`remove_label:${secondLabel}`,
			`remove_label:${thirdLabel}`,
		].sort());

		const replacement = labelControl("apply_label", thirdLabel);
		assert.equal(replacement.checked, false);
		replacement.click();
		await settleDom();
		const finalExpected = [
			...afterRemoval,
			{ type: "apply_label" as const, messageAlias, labelAlias: thirdLabel },
		];
		assert.deepEqual(
			actionSet(view(harness.workspace).actions),
			actionSet(finalExpected),
		);
		const listed = [
			...harness.root.querySelectorAll("[data-action-list] li"),
		].map((item) => item.textContent ?? "").sort();
		assert.deepEqual(listed, [
			"apply label · Message 1 · Label 2",
			"apply label · Message 1 · Label 3",
			"remove label · Message 1 · Label 2",
			"remove label · Message 1 · Label 3",
		].sort());

		const finalActions = structuredClone(view(harness.workspace).actions);
		buttonNamed(harness.root, "Save Draft").click();
		await settleDom();
		assert.deepEqual(harness.fingerprintInputs.at(-1)?.actions, finalActions);
		const persisted = harness.lifecycleCalls
			.filter((call) => call[0] === "edit")
			.at(-1)?.[3] as { actions?: unknown };
		assert.deepEqual(persisted.actions, finalActions);
		harness.dispose();
	});

	it("disables target-valued message actions when no sanitized target exists", async () => {
		const harness = mount(captureWithoutTargets());
		const row = harness.root.querySelector(
			"[data-message-editor]",
		) as HTMLElement | null;
		assert.notEqual(row, null);
		const before = structuredClone(view(harness.workspace).actions);
		const editsBefore = harness.lifecycleCalls.filter(
			(call) => call[0] === "edit",
		).length;

		for (const action of ["move_to_folder", "apply_label", "remove_label"]) {
			const control = row!.querySelector<HTMLInputElement>(
				`[data-message-action="${action}"]`,
			);
			assert.notEqual(control, null);
			assert.equal(control!.disabled, true);
			assert.equal(control!.checked, false);
			const target = row!.querySelector<HTMLSelectElement>(
				`[data-message-target="${action}"]`,
			);
			assert.notEqual(target, null);
			assert.equal(target!.disabled, true);
			assert.equal(target!.options.length, 0);
			assert.equal(target!.value, "");
			control!.click();
			assert.equal(control!.checked, false);
			target!.value = RAW_LOCATOR_SENTINEL;
			target!.dispatchEvent(
				new window.Event("change", { bubbles: true }) as unknown as Event,
			);
			assert.equal(target!.value, "");
		}
		await settleDom();
		assert.deepEqual(view(harness.workspace).actions, before);
		assert.equal(
			harness.lifecycleCalls.filter((call) => call[0] === "edit").length,
			editsBefore,
		);
		harness.dispose();
	});

	it("keeps sanitized metadata labels and restores connected focus after every editor class", async () => {
		const harness = mount();
		const text = harness.root.textContent ?? "";
		for (const label of [
			"Folder 1",
			"Label 1",
			"Tag 1",
			"Category 1",
			"Filter 1",
		]) {
			assert.ok(text.includes(label), `missing sanitized label ${label}`);
		}
		for (const value of [
			...captureResult().inventory.folders,
			...captureResult().inventory.labels,
			...captureResult().inventory.filters,
			...captureResult().metadata.tags,
			...captureResult().metadata.categories,
		]) {
			assert.ok(!text.includes(value.alias));
		}

		const interactions = [
			{
				selector: "[data-target-editor] input",
				run(control: HTMLElement) {
					(control as HTMLInputElement).click();
				},
			},
			{
				selector: "[data-cohort-editor] select",
				run(control: HTMLElement) {
					const select = control as HTMLSelectElement;
					select.value = "archive";
					select.dispatchEvent(
						new window.Event("change", {
							bubbles: true,
						}) as unknown as Event,
					);
				},
			},
			{
				selector: '[data-message-action="mark_read"]',
				run(control: HTMLElement) {
					(control as HTMLInputElement).click();
				},
			},
			{
				selector: "[data-message-exclusion] input",
				run(control: HTMLElement) {
					(control as HTMLInputElement).click();
				},
			},
			{
				selector: "[data-filter-editor] select",
				run(control: HTMLElement) {
					const select = control as HTMLSelectElement;
					select.value = "deactivate_filter";
					select.dispatchEvent(
						new window.Event("change", {
							bubbles: true,
						}) as unknown as Event,
					);
				},
			},
		];
		for (const interaction of interactions) {
			const control = harness.root.querySelector(
				interaction.selector,
			) as HTMLElement | null;
			assert.notEqual(control, null);
			control!.focus();
			interaction.run(control!);
			await settleDom();
			const active = document.activeElement as HTMLElement | null;
			assert.notEqual(active, null);
			assert.equal(active!.isConnected, true);
			assert.notEqual(active, document.body);
			assert.ok(
				active!.matches(interaction.selector),
				`focus left ${interaction.selector}`,
			);
		}
		harness.dispose();
	});

	it("announces Save, Submit, Accept, and Cancel outcomes in the live region", async () => {
		const liveText = (root: HTMLElement) =>
			root.querySelector('[role="status"]')?.textContent ?? "";

		const saved = mount();
		buttonNamed(saved.root, "Save Draft").click();
		await settleDom();
		assert.match(liveText(saved.root), /draft.*saved/i);
		saved.dispose();

		const waitingChat = deferred<unknown>();
		const submitted = mount({ bridgeResults: [waitingChat.promise] });
		buttonNamed(submitted.root, "Submit to Chat").click();
		await waitFor(
			() => submitted.bridgeSubmissions.length > 0,
			"Submit did not reach the chat bridge",
		);
		assert.match(liveText(submitted.root), /waiting.*proposal/i);
		waitingChat.resolve({ status: "canceled" });
		await settleDom();
		submitted.dispose();

		const accepted = mount();
		buttonNamed(accepted.root, "Accept Revision").click();
		await settleDom();
		assert.match(
			liveText(accepted.root),
			/revision.*accepted|accepted.*revision/i,
		);
		accepted.dispose();

		const canceled = mount();
		buttonNamed(canceled.root, "Cancel cleanup").click();
		await settleDom();
		assert.match(
			liveText(canceled.root),
			/cleanup.*canceled|canceled.*cleanup/i,
		);
		canceled.dispose();
	});

	it("keeps the DOM smoke suite in the package, workspace, and CI test gates", async () => {
		const extensionPackage = JSON.parse(
			await readFile(new URL("../package.json", import.meta.url), "utf8"),
		) as { scripts?: Record<string, string> };
		const rootPackage = JSON.parse(
			await readFile(new URL("../../../package.json", import.meta.url), "utf8"),
		) as { scripts?: Record<string, string> };
		const extensionWorkflow = await readFile(
			new URL(
				"../../../.github/workflows/ext-blt.yml",
				import.meta.url,
			),
			"utf8",
		);

		assert.equal(
			extensionPackage.scripts?.["test:mailbox-plan-dom"],
			"vite-node __tests__/mailbox-plan-page-dom.smoke.ts",
		);
		assert.match(
			extensionPackage.scripts?.test ?? "",
			/^bun run test:mailbox-plan-dom && bun test$/,
		);
		assert.match(
			rootPackage.scripts?.["test:all"] ?? "",
			/--filter=['"]\.\/pkg\/\*['"] test/,
		);
		assert.match(
			extensionWorkflow,
			/working-directory:\s*pkg\/extension[\s\S]*?name:\s*Test[\s\S]*?working-directory:\s*pkg\/extension[\s\S]*?run:\s*bun run test(?:\s|$)/,
			"extension CI must invoke the package test script that includes the DOM smoke",
		);
	});

	it("keeps status and heading colors at readable WCAG contrast", async () => {
		const css = await readFile(
			new URL("../entrypoints/mailbox-plan/style.css", import.meta.url),
			"utf8",
		);
		const values = [
			...css.matchAll(
				/--mailbox-(bg|panel|accent|warning):\s*(#[0-9a-f]{6})/gi,
			),
		].map((match) => match[2]!.toLowerCase());
		assert.ok(values.length >= 8, "light and dark palette tokens");
		const [lightBg, lightPanel, lightAccent, lightWarning] = values;
		const [darkBg, darkPanel, darkAccent, darkWarning] = values.slice(4);
		for (const [foreground, background] of [
			[lightAccent, lightPanel],
			[lightWarning, lightBg],
			[darkAccent, darkPanel],
			[darkWarning, darkBg],
		] as const) {
			assert.ok(foreground && background);
			assert.ok(
				contrastRatio(foreground, background) >= 4.5,
				`${foreground} on ${background} must meet 4.5:1`,
			);
		}
	});
});

function expectSingle(values: readonly unknown[]): void {
	assert.equal(values.length, 1);
}
