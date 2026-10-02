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
	waitForOpen,
	waitForValue,
	wsExtensionSocket,
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
		const cliFrames = collectFrames(cli);

		send(cli, { type: "cli-overwatch-open" });
		const open = await waitForValue(
			() => frames.find((frame) => frameType(frame) === "overwatch-open"),
			3000,
			"overwatch-open",
		);
		expect(open).toMatchObject({ sessionId: "__overwatch__" });
		send(extension, {
			type: "overwatch-open-result",
			sessionId: credentials.sessionId,
			token: credentials.token,
			requestId: (open as { requestId: string }).requestId,
			ok: true,
		});
		const result = await waitForValue(
			() =>
				cliFrames.find(
					(frame) => frameType(frame) === "cli-overwatch-open-result",
				),
			3000,
			"cli-overwatch-open-result",
		);
		expect(result).toEqual({ type: "cli-overwatch-open-result" });
	});

	it("returns the extension tab failure to the CLI", async () => {
		const { port, credentials } = await bootWithSession();
		const extension = await connectPage(port, credentials);
		const cli = await connectCli(port, credentials);
		sockets.push(extension, cli);
		const extensionFrames = collectFrames(extension);
		const cliFrames = collectFrames(cli);

		send(cli, { type: "cli-overwatch-open" });
		const open = await waitForValue(
			() =>
				extensionFrames.find(
					(frame) => frameType(frame) === "overwatch-open",
				),
			3000,
			"overwatch-open",
		);
		send(extension, {
			type: "overwatch-open-result",
			sessionId: credentials.sessionId,
			token: credentials.token,
			requestId: (open as { requestId: string }).requestId,
			ok: false,
			error: "tab creation failed",
		});

		const error = await waitForValue(
			() => cliFrames.find((frame) => frameType(frame) === "error"),
			3000,
			"tab failure",
		);
		expect(error).toMatchObject({ message: "tab creation failed" });
		expect(
			cliFrames.some(
				(frame) => frameType(frame) === "cli-overwatch-open-result",
			),
		).toBe(false);
	});

	it("notifies the authoritative publisher after a direct CLI mutation", async () => {
		const { port, credentials } = await bootWithSession();
		const publisher = await registerSession(port, {
			agentIdentity: "overwatch-board",
		});
		const mutationCli = await connectCli(port, credentials);
		const publisherCli = await connectCli(port, publisher);
		sockets.push(mutationCli, publisherCli);
		const mutationFrames = collectFrames(mutationCli);
		const publisherFrames = collectFrames(publisherCli);

		send(mutationCli, {
			type: "cli-overwatch-set",
			chat: "print",
			task: "Prepare launch collateral",
			stage: "review",
			kind: "chat",
		});
		await waitForValue(
			() =>
				mutationFrames.find(
					(frame) => frameType(frame) === "cli-overwatch-mutation-result",
				),
			3000,
			"mutation result",
		);
		send(publisherCli, { type: "cli-recv", block: false });
		const received = await waitForValue(
			() =>
				publisherFrames.find(
					(frame) => frameType(frame) === "cli-recv-result",
				),
			3000,
			"publisher notification",
		);

		expect(received).toMatchObject({
			outcome: "delivered",
			message: { from: "dg-daemon", to: "overwatch-board" },
		});
		expect(
			JSON.parse(
				(received as { message: { body: string } }).message.body,
			),
		).toMatchObject({ overwatch: { event: "board-changed" } });
	});

	it("does not deliver overwatch frames before the extension handshake", async () => {
		const { port, credentials } = await bootWithSession();
		const extension = wsExtensionSocket(port);
		await waitForOpen(extension);
		const cli = await connectCli(port, credentials);
		sockets.push(extension, cli);
		const extensionFrames = collectFrames(extension);
		const cliFrames = collectFrames(cli);

		send(cli, {
			type: "cli-overwatch-set",
			chat: "print",
			task: "Prepare launch collateral",
			stage: "review",
			kind: "chat",
		});
		send(cli, { type: "cli-overwatch-open" });
		const error = await waitForValue(
			() => cliFrames.find((frame) => frameType(frame) === "error"),
			3000,
			"extension-not-connected error",
		);
		await Bun.sleep(100);

		expect(error).toMatchObject({ message: "extension not connected" });
		expect(extensionFrames).toEqual([]);
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

	it("rejects malformed overwatch CLI frames before mutation or broadcast", async () => {
		const { port, credentials } = await bootWithSession();
		const extension = await connectPage(port, credentials);
		const cli = await connectCli(port, credentials);
		sockets.push(extension, cli);
		const extensionFrames = collectFrames(extension);
		const cliFrames = collectFrames(cli);
		const invalidFrames = [
			{
				type: "cli-overwatch-set",
				chat: "print",
				task: "Task",
				stage: "deploying",
				kind: "chat",
			},
			{ type: "cli-overwatch-remove", chat: "" },
			{
				type: "cli-overwatch-merged",
				mr: "!298",
				title: "x".repeat(201),
			},
			{
				type: "cli-overwatch-launch",
				goLive: "10/24/2026",
			},
			{ type: "cli-overwatch-open", unexpected: true },
			{ type: "cli-overwatch-snapshot", unexpected: true },
		];

		for (const [index, frame] of invalidFrames.entries()) {
			send(cli, frame);
			await waitForValue(
				() =>
					cliFrames.filter((candidate) => frameType(candidate) === "error")[
						index
					],
				3000,
				`invalid overwatch frame ${index}`,
			);
		}

		const response = await fetch(`http://127.0.0.1:${port}/overwatch`, {
			headers: {
				Host: `127.0.0.1:${port}`,
			},
		});
		expect(await response.json()).toEqual({ lanes: [], merges: [] });
		expect(
			extensionFrames.filter((frame) =>
				["overwatch-state", "overwatch-open"].includes(frameType(frame) ?? ""),
			),
		).toEqual([]);
		expect(
			cliFrames.some(
				(frame) => frameType(frame) === "cli-overwatch-snapshot-result",
			),
		).toBe(false);
	});
});
