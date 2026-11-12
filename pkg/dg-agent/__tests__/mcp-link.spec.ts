import { describe, expect, it } from "bun:test";
import { DgCliError } from "@dg/common";
import type { CliClient, ResolvedSession } from "@dg/common/node";
import { connectCliLink } from "../src/mcp/link";
import { McpLinkClosedError } from "../src/mcp/server";

const SESSION: ResolvedSession = { port: 1, sessionId: "s", token: "t" };
const FRAME = { type: "cli-pw-ext-request", requestId: "r", request: { verb: "tabs" } } as const;
const accept = (_value: unknown): _value is never => true;

function fakeClient(request: () => Promise<unknown>) {
	let closeHandler: () => void = () => {};
	let requests = 0;
	const client = {
		request: async () => {
			requests += 1;
			return request();
		},
		close() {},
		onClose(handler: () => void) {
			closeHandler = handler;
		},
	} as unknown as CliClient;
	return { client, closeNow: () => closeHandler(), requests: () => requests };
}

async function linkRejecting(error: Error) {
	const { client } = fakeClient(async () => {
		throw error;
	});
	return connectCliLink(SESSION, async () => client);
}

describe("connectCliLink", () => {
	it.each([
		"dg-daemon closed the CLI connection",
		"the dg-daemon CLI connection failed",
	])("maps %p to McpLinkClosedError", async (message) => {
		const link = await linkRejecting(new DgCliError(message));
		await expect(link.request(FRAME, accept, 1)).rejects.toBeInstanceOf(McpLinkClosedError);
	});

	it("passes a timeout error through unchanged", async () => {
		const timeout = new DgCliError("dg-daemon did not answer the CLI request");
		const link = await linkRejecting(timeout);
		await expect(link.request(FRAME, accept, 1)).rejects.toBe(timeout);
	});

	it("marks a mid-request close as submitted", async () => {
		const link = await linkRejecting(new DgCliError("dg-daemon closed the CLI connection"));
		const error = await link.request(FRAME, accept, 1).catch((value: unknown) => value);
		expect((error as McpLinkClosedError).submitted).toBe(true);
	});

	it("throws a not-submitted McpLinkClosedError without sending when the socket closed while idle", async () => {
		const fake = fakeClient(async () => ({}));
		const link = await connectCliLink(SESSION, async () => fake.client);
		fake.closeNow();
		const error = await link.request(FRAME, accept, 1).catch((value: unknown) => value);
		expect(error).toBeInstanceOf(McpLinkClosedError);
		expect((error as McpLinkClosedError).submitted).toBe(false);
		expect(fake.requests()).toBe(0);
	});
});
