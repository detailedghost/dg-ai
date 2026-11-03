import { afterEach, expect, test } from "bun:test";
import type { OverwatchBoard, OverwatchLane } from "@dg/common";
import { Window } from "happy-dom";
import { renderOverwatchPage } from "../src/board/main";

const NOW = new Date("2026-10-02T10:30:00.000Z");
const windows = new Set<Window>();

afterEach(async () => {
	await Promise.all([...windows].map((window) => window.happyDOM.close()));
	windows.clear();
});

function newRoot(): HTMLElement {
	const window = new Window();
	windows.add(window);
	const document = window.document as unknown as Document;
	const root = document.createElement("div");
	document.body.append(root);
	return root as unknown as HTMLElement;
}

function buildLane(overrides: Partial<OverwatchLane> = {}): OverwatchLane {
	return {
		chat: "print",
		task: "Follow ups after scheduling",
		stage: "e2e",
		mr: "!298",
		eta: "1h",
		kind: "chat",
		publisher: "print-agent",
		updatedAt: "2026-10-02T10:28:00.000Z",
		...overrides,
	};
}

function buildBoard(lanes: OverwatchLane[]): OverwatchBoard {
	return {
		goLive: "2026-10-04T12:45:00.000Z",
		goNoGo: "2026-10-03T15:00:00.000Z",
		lanes,
		merges: [],
	};
}

async function mount(board: OverwatchBoard) {
	const root = newRoot();
	const handle = renderOverwatchPage({
		root,
		connect: () =>
			Promise.resolve({
				baseUrl: "http://127.0.0.1:47823",
				getBoard: () => Promise.resolve(board),
				sendAction: () => Promise.resolve({ ok: true }),
			}),
		now: () => NOW,
		schedule: () => 1,
		cancel: () => undefined,
	});
	await handle.ready;
	return { root, handle };
}

test("renderOverwatchPage renders one lane per chat from a board fixture", async () => {
	const { root, handle } = await mount(
		buildBoard([
			buildLane(),
			buildLane({ chat: "infra", task: "Rotate keys", stage: "review" }),
		]),
	);

	expect(root.querySelectorAll(".overwatch__lane")).toHaveLength(2);
	expect(root.textContent).toContain("Follow ups after scheduling");
	expect(root.textContent).toContain("Rotate keys");
	handle.stop();
});

test("renderOverwatchPage shows the empty state when no lanes are reporting", async () => {
	const { root, handle } = await mount(buildBoard([]));

	expect(root.querySelectorAll(".overwatch__lane")).toHaveLength(0);
	expect((root.querySelector(".overwatch__empty") as HTMLElement).hidden).toBe(
		false,
	);
	handle.stop();
});

test("renderOverwatchPage polls the board api again on refresh", async () => {
	let reads = 0;
	const root = newRoot();
	const handle = renderOverwatchPage({
		root,
		connect: () =>
			Promise.resolve({
				baseUrl: "http://127.0.0.1:47823",
				getBoard: () => {
					reads += 1;
					return Promise.resolve(buildBoard([buildLane()]));
				},
				sendAction: () => Promise.resolve({ ok: true }),
			}),
		now: () => NOW,
		schedule: () => 1,
		cancel: () => undefined,
	});
	await handle.ready;
	const before = reads;

	await handle.refresh();

	expect(reads).toBeGreaterThan(before);
	handle.stop();
});
