import { describe, expect, it } from "bun:test";
import { Window } from "happy-dom";
import type {
	DashboardApi,
	FeedItemPayload,
	JobPayload,
} from "@/lib/features/dashboard";
import { buildFeedItem, buildJob } from "./utils/dashboard-fixtures";
import { click, keydown, typeValue } from "./utils/dom-events";

const { renderDashboard } = await import("../entrypoints/dashboard/main");

const NOW = new Date("2026-09-03T12:10:00.000Z");

type Recorded = { call: string; args: unknown[] };

function fakeApi(
	jobs: JobPayload[],
	items: FeedItemPayload[],
	recorded: Recorded[] = [],
	ok = true,
): DashboardApi {
	const note = (call: string, ...args: unknown[]) => {
		recorded.push({ call, args });
		return Promise.resolve(true);
	};
	return {
		baseUrl: "http://127.0.0.1:7777",
		refresh: () =>
			Promise.resolve(ok ? { ok: true, jobs, items } : { ok: false }),
		markRead: (id: string) => note("markRead", id),
		markAllRead: () => note("markAllRead"),
		runJob: (id: string) => note("runJob", id),
		queueToAgent: (id: string, identity: string) =>
			note("queueToAgent", id, identity),
	};
}

function newRoot(): HTMLElement {
	const window = new Window();
	const document = window.document as unknown as Document;
	const root = document.createElement("div");
	document.body.appendChild(root);
	return root as unknown as HTMLElement;
}

async function mount(
	api: DashboardApi | undefined,
	root = newRoot(),
): Promise<HTMLElement> {
	const handle = renderDashboard({
		root,
		connect: () => Promise.resolve(api),
		now: () => NOW,
		poll: false,
	});
	await handle.ready;
	return root;
}

function text(root: HTMLElement, selector: string): string {
	return root.querySelector(selector)?.textContent ?? "";
}

function all(root: HTMLElement, selector: string): HTMLElement[] {
	return Array.from(root.querySelectorAll(selector)) as HTMLElement[];
}

describe("the dashboard page as it paints", () => {
	it("draws a row for every job, with its unread count", async () => {
		const root = await mount(
			fakeApi(
				[
					buildJob({ unread: 2 }),
					buildJob({ id: "job-2", label: "sentry-errors", unread: 0 }),
				],
				[],
			),
		);

		const names = all(root, ".dash__jobname").map((node) => node.textContent);
		expect(names).toEqual(["jira-sprint", "sentry-errors"]);
		expect(all(root, ".dash__pill").map((node) => node.textContent)).toEqual([
			"2",
			"0",
		]);
	});

	it("marks a failed job and a paused job apart in the class it paints", async () => {
		const root = await mount(
			fakeApi(
				[
					buildJob({ id: "a", label: "broken", lastExitCode: 1, lastError: "boom" }),
					buildJob({ id: "b", label: "off", enabled: false }),
				],
				[],
			),
		);

		expect(root.querySelector(".dash__job--failed")).not.toBeNull();
		expect(root.querySelector(".dash__job--paused")).not.toBeNull();
	});

	it("puts the failure banner above the feed, naming the job", async () => {
		const root = await mount(
			fakeApi(
				[buildJob({ lastExitCode: 1, lastError: "auth token expired" })],
				[buildFeedItem()],
			),
		);

		const alert = root.querySelector(".dash__alert");
		expect(alert?.textContent).toContain("jira-sprint");
		expect(alert?.textContent).toContain("auth token expired");
	});

	it("says the daemon is not answering rather than showing an empty feed", async () => {
		const root = await mount(undefined);

		expect(text(root, ".dash__alert--offline")).toContain("not answering");
	});

	it("keeps the last good data on screen when a later poll fails", async () => {
		const root = newRoot();
		let live = true;
		const flaky: DashboardApi = {
			...fakeApi([buildJob()], [buildFeedItem()]),
			refresh: () =>
				Promise.resolve(
					live ? { ok: true, jobs: [buildJob()], items: [buildFeedItem()] } : { ok: false },
				),
		};
		const handle = renderDashboard({
			root,
			connect: () => Promise.resolve(live ? flaky : undefined),
			now: () => NOW,
			poll: false,
		});
		await handle.ready;
		expect(text(root, ".dash__itemtitle")).toContain("Quote export");

		live = false;
		await handle.refresh();

		expect(root.querySelector(".dash__alert--offline")).not.toBeNull();
		expect(text(root, ".dash__itemtitle")).toContain("Quote export");
	});

	it("leaves the schedule control inert, since that page is not built", async () => {
		const root = await mount(fakeApi([buildJob()], []));

		const schedule = root.querySelector(
			".dash__btn--ghost",
		) as HTMLButtonElement | null;
		expect(schedule?.textContent).toContain("Schedule");
		expect(schedule?.disabled).toBe(true);
	});
});

describe("the dashboard page as it is clicked", () => {
	it("filters the feed to a job, and clears the filter on a second click", async () => {
		const root = await mount(
			fakeApi(
				[buildJob(), buildJob({ id: "job-2", label: "sentry-errors" })],
				[
					buildFeedItem(),
					buildFeedItem({ id: "item-2", jobId: "job-2", title: "Sentry blew up" }),
				],
			),
		);
		expect(all(root, ".dash__item")).toHaveLength(2);

		click(all(root, ".dash__job")[0]);
		expect(all(root, ".dash__itemtitle").map((n) => n.textContent)).toEqual([
			"Quote export times out",
		]);

		click(all(root, ".dash__job")[0]);
		expect(all(root, ".dash__item")).toHaveLength(2);
	});

	it("asks the daemon to mark one item read", async () => {
		const recorded: Recorded[] = [];
		const root = await mount(fakeApi([buildJob()], [buildFeedItem()], recorded));

		click(all(root, ".dash__mark")[0]);
		await Bun.sleep(0);

		expect(recorded[0]).toEqual({ call: "markRead", args: ["item-1"] });
	});

	it("does not offer to mark an item that is already read", async () => {
		const root = await mount(
			fakeApi([buildJob()], [buildFeedItem({ read: true })]),
		);

		expect((all(root, ".dash__mark")[0] as HTMLButtonElement).disabled).toBe(
			true,
		);
	});

	it("runs the selected job on demand", async () => {
		const recorded: Recorded[] = [];
		const root = await mount(fakeApi([buildJob()], [buildFeedItem()], recorded));
		click(all(root, ".dash__job")[0]);

		const run = all(root, ".dash__btn").find(
			(node) => node.textContent === "Run now",
		);
		click(run as HTMLElement);
		await Bun.sleep(0);

		expect(recorded[0]).toEqual({ call: "runJob", args: ["job-1"] });
	});

	it("queues an item to the identity the user types, on Enter", async () => {
		const recorded: Recorded[] = [];
		const root = await mount(fakeApi([buildJob()], [buildFeedItem()], recorded));

		click(all(root, ".dash__queue")[0]);
		const input = root.querySelector(".dash__identity") as HTMLInputElement;
		expect(input).not.toBeNull();

		typeValue(input, "reviewer");
		keydown(input, "Enter");
		await Bun.sleep(0);

		expect(recorded[0]).toEqual({
			call: "queueToAgent",
			args: ["item-1", "reviewer"],
		});
	});

	it("queues nothing on Enter with an empty identity", async () => {
		const recorded: Recorded[] = [];
		const root = await mount(fakeApi([buildJob()], [buildFeedItem()], recorded));

		click(all(root, ".dash__queue")[0]);
		const input = root.querySelector(".dash__identity") as HTMLInputElement;
		typeValue(input, "   ");
		keydown(input, "Enter");
		await Bun.sleep(0);

		expect(recorded).toHaveLength(0);
	});

	it("abandons the identity input on Escape", async () => {
		const root = await mount(fakeApi([buildJob()], [buildFeedItem()]));

		click(all(root, ".dash__queue")[0]);
		const input = root.querySelector(".dash__identity") as HTMLInputElement;
		keydown(input, "Escape");

		expect(root.querySelector(".dash__identity")).toBeNull();
		expect(root.querySelector(".dash__queue")).not.toBeNull();
	});

	it("does not repaint over a half-typed identity when a poll lands", async () => {
		const recorded: Recorded[] = [];
		const root = newRoot();
		const handle = renderDashboard({
			root,
			connect: () => Promise.resolve(fakeApi([buildJob()], [buildFeedItem()], recorded)),
			now: () => NOW,
			poll: false,
		});
		await handle.ready;

		click(all(root, ".dash__queue")[0]);
		const input = root.querySelector(".dash__identity") as HTMLInputElement;
		typeValue(input, "revie");

		await handle.refresh();

		const survivor = root.querySelector(".dash__identity") as HTMLInputElement;
		expect(survivor).not.toBeNull();
		expect(survivor.value).toBe("revie");
	});
});
