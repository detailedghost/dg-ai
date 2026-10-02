import { afterEach, describe, expect, it } from "bun:test";
import {
	bootServe,
	cleanupDgHome,
	closeSockets,
	collectFrames,
	connectCli,
	connectPage,
	createCleanupSlot,
	frameType,
	registerSession,
	send,
	stopServe,
	waitForValue,
} from "../utils/daemon-harness";

const cleanupSlot = createCleanupSlot();
const sockets: WebSocket[] = [];

afterEach(async () => {
	closeSockets(sockets);
	await cleanupSlot.run();
});

async function bootWithSession() {
	const running = await bootServe();
	cleanupSlot.set(async () => {
		await stopServe(running.proc);
		cleanupDgHome(running.dgHome);
	});
	const credentials = await registerSession(running.port, {
		agentIdentity: "print-agent",
	});
	return { ...running, credentials };
}

describe("overwatch CLI frames", () => {
	it("broadcasts the full board after set, remove, merged, and launch", async () => {
		const { port, credentials } = await bootWithSession();
		const extension = await connectPage(port, credentials);
		const cli = await connectCli(port, credentials);
		sockets.push(extension, cli);
		const frames = collectFrames(extension);

		send(cli, {
			type: "cli-overwatch-set",
			chat: "print",
			task: "Prepare launch collateral",
			stage: "review",
			kind: "chat",
		});
		const afterSet = await waitForValue(
			() => frames.filter((frame) => frameType(frame) === "overwatch-state")[0],
			3000,
			"overwatch-state after set",
		);
		expect(afterSet).toMatchObject({
			sessionId: "__overwatch__",
			board: { lanes: [{ chat: "print", publisher: "print-agent" }] },
		});

		send(cli, { type: "cli-overwatch-remove", chat: "print" });
		const afterRemove = await waitForValue(
			() => frames.filter((frame) => frameType(frame) === "overwatch-state")[1],
			3000,
			"overwatch-state after remove",
		);
		expect(afterRemove).toMatchObject({ board: { lanes: [] } });

		send(cli, {
			type: "cli-overwatch-merged",
			mr: "!298",
			title: "Launch checklist",
		});
		const afterMerge = await waitForValue(
			() => frames.filter((frame) => frameType(frame) === "overwatch-state")[2],
			3000,
			"overwatch-state after merged",
		);
		expect(afterMerge).toMatchObject({
			board: { merges: [{ mr: "!298", title: "Launch checklist" }] },
		});

		send(cli, {
			type: "cli-overwatch-launch",
			goLive: "2026-10-24T14:00:00.000Z",
			goNoGo: "2026-10-17T14:00:00.000Z",
		});
		const afterLaunch = await waitForValue(
			() => frames.filter((frame) => frameType(frame) === "overwatch-state")[3],
			3000,
			"overwatch-state after launch",
		);
		expect(afterLaunch).toMatchObject({
			board: {
				goLive: "2026-10-24T14:00:00.000Z",
				goNoGo: "2026-10-17T14:00:00.000Z",
			},
		});
	});

	it("returns the board snapshot on the CLI socket", async () => {
		const { port, credentials } = await bootWithSession();
		const cli = await connectCli(port, credentials);
		sockets.push(cli);
		const frames = collectFrames(cli);

		send(cli, { type: "cli-overwatch-snapshot" });
		const snapshot = await waitForValue(
			() =>
				frames.find(
					(frame) => frameType(frame) === "cli-overwatch-snapshot-result",
				),
			3000,
			"cli-overwatch-snapshot-result",
		);
		expect(snapshot).toMatchObject({ board: { lanes: [], merges: [] } });
	});

	it("pushes overwatch-open when an extension is connected", async () => {
		const { port, credentials } = await bootWithSession();
		const extension = await connectPage(port, credentials);
		const cli = await connectCli(port, credentials);
		sockets.push(extension, cli);
		const frames = collectFrames(extension);

		send(cli, { type: "cli-overwatch-open" });
		const open = await waitForValue(
			() => frames.find((frame) => frameType(frame) === "overwatch-open"),
			3000,
			"overwatch-open",
		);
		expect(open).toMatchObject({ sessionId: "__overwatch__" });
	});

	it("returns an error when opening without an extension connection", async () => {
		const { port, credentials } = await bootWithSession();
		const cli = await connectCli(port, credentials);
		sockets.push(cli);
		const frames = collectFrames(cli);

		send(cli, { type: "cli-overwatch-open" });
		const error = await waitForValue(
			() => frames.find((frame) => frameType(frame) === "error"),
			3000,
			"extension-not-connected error",
		);
		expect(error).toMatchObject({ message: "extension not connected" });
	});
});
