import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { resolveDgPaths } from "@dg/common/node";
import {
	bootServe,
	ChatStore,
	cleanupDgHome,
	createCleanupSlot,
	EXTENSION_ORIGIN,
	FILE_ONLY_SEAMS,
	stopServe,
} from "../utils/daemon-harness";

const cleanupSlot = createCleanupSlot();

afterEach(() => cleanupSlot.run());

async function boot() {
	const running = await bootServe();
	cleanupSlot.set(async () => {
		await stopServe(running.proc);
		cleanupDgHome(running.dgHome);
	});
	return running;
}

function headers(port: number, origin = EXTENSION_ORIGIN) {
	return { Host: `127.0.0.1:${port}`, Origin: origin };
}

async function seedLane(dgHome: string): Promise<void> {
	const store = await ChatStore.open(
		resolveDgPaths({ env: { DG_HOME: dgHome } }),
		FILE_ONLY_SEAMS,
	);
	store.upsertLane({
		chat: "print",
		task: "Prepare launch collateral",
		stage: "review",
		kind: "chat",
		publisher: "print-agent",
	});
	store.close();
}

async function postAction(
	port: number,
	body: unknown,
	origin = EXTENSION_ORIGIN,
): Promise<Response> {
	return fetch(`http://127.0.0.1:${port}/overwatch/action`, {
		method: "POST",
		headers: {
			...headers(port, origin),
			"Content-Type": "application/json",
		},
		body: JSON.stringify(body),
	});
}

describe("overwatch HTTP routes", () => {
	it("returns the board and routes one action to the lane publisher", async () => {
		const { port, dgHome } = await boot();
		await seedLane(dgHome);

		const boardResponse = await fetch(`http://127.0.0.1:${port}/overwatch`, {
			headers: headers(port),
		});
		expect(boardResponse.status).toBe(200);
		expect(await boardResponse.json()).toMatchObject({
			lanes: [{ chat: "print", publisher: "print-agent" }],
		});

		const action = {
			chat: "print",
			action: "reject",
			note: "Revise the launch copy\nthen request review",
		};
		const actionResponse = await postAction(port, action);
		expect(actionResponse.status).toBe(200);

		const paths = resolveDgPaths({ env: { DG_HOME: dgHome } });
		const store = await ChatStore.open(paths, FILE_ONLY_SEAMS);
		const message = store.claimNextAgentMessage(
			"print-agent",
			"print-session",
		);
		expect(message?.from).toBe("overwatch-board");
		expect(JSON.parse(message?.body ?? "")).toEqual({ overwatch: action });
		store.close();

		const raw = new Database(paths.dbPath, { readonly: true });
		const count = raw
			.query("SELECT COUNT(*) AS count FROM agent_messages")
			.get() as { count: number };
		expect(count.count).toBe(1);
		raw.close(true);
	});

	it("returns 404 for an action on an unknown lane", async () => {
		const { port } = await boot();
		const response = await postAction(port, {
			chat: "missing",
			action: "approve",
		});
		expect(response.status).toBe(404);
	});

	it("refuses foreign Origins for reads and actions", async () => {
		const { port } = await boot();
		const read = await fetch(`http://127.0.0.1:${port}/overwatch`, {
			headers: headers(port, "https://evil.example"),
		});
		const action = await postAction(
			port,
			{ chat: "print", action: "approve" },
			"https://evil.example",
		);
		expect(read.status).toBe(400);
		expect(action.status).toBe(400);
	});
});
