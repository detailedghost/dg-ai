import { describe, expect, it } from "bun:test";
import { DgCliError } from "@dg/common";
import type { CliClient, ResolvedSession } from "@dg/common/node";
import { connectCliLink } from "../src/mcp/link";
import { McpLinkClosedError } from "../src/mcp/server";

const SESSION: ResolvedSession = { port: 1, sessionId: "s", token: "t" };
const FRAME = { type: "cli-pw-ext-request", requestId: "r", request: { verb: "tabs" } } as const;
const accept = (_value: unknown): _value is never => true;

async function linkRejecting(error: Error) {
	const client = {
		request: async () => {
			throw error;
		},
		close() {},
	} as unknown as CliClient;
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
});
