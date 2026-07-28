import { browser } from "wxt/browser";
import {
	createMailboxChatBridge,
	createMailboxRuntimeChatTransport,
} from "@/lib/features/mailbox-cleanup/bridge";
import {
	createMailboxLifecycle,
} from "@/lib/features/mailbox-cleanup/lifecycle";
import {
	consumeMailboxPlanBootstrap,
	createMailboxPlanWorkspace,
	initializeMailboxPlanPage,
	mountMailboxPlanPage,
} from "@/lib/features/mailbox-cleanup/plan-page";
import { computeMailboxScopedFingerprint } from "@/lib/features/mailbox-cleanup/planning";
import { isValidMailboxScopedAlias } from "@/lib/features/mailbox-cleanup/privacy";
import {
	createBrowserRawBindingAlarms,
	createMailboxPlanStore,
	createRawBindingStore,
	type SessionStorageSeam,
} from "@/lib/features/mailbox-cleanup/storage";
import "./style.css";

function sessionStorage(): SessionStorageSeam {
	return {
		async get(key) {
			const values = await browser.storage.session.get(key);
			return values[key];
		},
		async set(key, value) {
			await browser.storage.session.set({ [key]: value });
		},
		async delete(key) {
			await browser.storage.session.remove(key);
		},
	};
}

function scopedAlias(prefix: "rev" | "act"): string {
	for (let attempt = 0; attempt < 4; attempt += 1) {
		const bytes = crypto.getRandomValues(new Uint8Array(16));
		const alias = `${prefix}_${[...bytes]
			.map((byte) => byte.toString(16).padStart(2, "0"))
			.join("")}`;
		if (isValidMailboxScopedAlias(alias, prefix)) return alias;
	}
	throw new Error("Mailbox plan entropy unavailable");
}

function revisionAlias(): string {
	return scopedAlias("rev");
}

function actionAlias(): string {
	return scopedAlias("act");
}

function registerRevision(
	planAlias: string,
	revisionAlias: string,
): Promise<unknown> {
	return browser.runtime.sendMessage({
		type: "dg-mailbox-plans:register",
		command: { planAlias, revisionAlias },
	});
}

function showUnavailable(root: HTMLElement, message: string): void {
	root.removeAttribute("aria-busy");
	root.replaceChildren();
	root.appendChild(document.createElement("h1"));
	root.firstElementChild!.textContent = "Mailbox cleanup plan";
	const status = document.createElement("p");
	status.setAttribute("role", "alert");
	status.textContent = message;
	root.appendChild(status);
}

async function start(root: HTMLElement): Promise<void> {
	const session = sessionStorage();
	const input = await consumeMailboxPlanBootstrap({
		session,
		computeFingerprint: computeMailboxScopedFingerprint,
	});
	if (input === undefined) {
		showUnavailable(
			root,
			"No active sanitized mailbox plan is available. Start a new scan.",
		);
		return;
	}

	const alarmRegistration = createBrowserRawBindingAlarms({
		alarms: browser.alarms,
		session: browser.storage.session,
	});
	const bindings = createRawBindingStore({
		session,
		now: Date.now,
		alarms: alarmRegistration.alarms,
	});
	const plans = createMailboxPlanStore({
		indexedDB,
		now: Date.now,
	});
	const lifecycle = createMailboxLifecycle({
		store: plans,
		now: Date.now,
		execution: {
			has: async (planAlias, revisionAlias) =>
				planAlias === input.bindingScope.planAlias &&
				(await bindings.get({
					...input.bindingScope,
					revisionAlias,
				})) !== undefined,
			invalidate: (planAlias, revisionAlias, reason) =>
				bindings.invalidateRevision(planAlias, revisionAlias, reason),
		},
	});
	const bridge = createMailboxChatBridge({
		transport: createMailboxRuntimeChatTransport({
			runtime: browser.runtime,
		}),
		randomBytes: () => crypto.getRandomValues(new Uint8Array(16)),
		now: Date.now,
		setTimeout: (callback, milliseconds) =>
			globalThis.setTimeout(callback, milliseconds),
		clearTimeout: (timer) =>
			globalThis.clearTimeout(timer as ReturnType<typeof setTimeout>),
	});
	await bridge.open(input.baseRevision.planAlias).catch(() => undefined);
	const initialized = await initializeMailboxPlanPage(input, {
		lifecycle,
		registerRevision: async (planAlias, revisionAlias) => {
			await registerRevision(planAlias, revisionAlias);
		},
		createWorkspace: (workspaceInput) =>
			createMailboxPlanWorkspace(workspaceInput, {
				lifecycle,
				rawBindings: bindings,
				computeFingerprint: computeMailboxScopedFingerprint,
				createRevisionAlias: revisionAlias,
				createActionAlias: actionAlias,
				now: Date.now,
				bridge,
				startExecution: (command) =>
					browser.runtime.sendMessage({
						type: "dg-mailbox-cleanup:execution-start",
						command,
					}),
				registerRevision: async (planAlias, revisionAlias) => {
					await registerRevision(planAlias, revisionAlias);
				},
			}),
		mount: (workspace) => mountMailboxPlanPage(root, workspace),
	});
	const disposePage = initialized.dispose;
	root.removeAttribute("aria-busy");
	const dispose = (): void => {
		disposePage();
		bridge.dispose();
		alarmRegistration.dispose();
		void plans.close();
	};
	window.addEventListener("pagehide", dispose, { once: true });
}

const root = document.getElementById("mailbox-plan-root");
if (root instanceof HTMLElement) {
	void start(root).catch(() => {
		showUnavailable(
			root,
			"Mailbox plan setup failed safely. Start a new scan.",
		);
	});
}
