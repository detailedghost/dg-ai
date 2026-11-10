import { DgCliError } from "@dg/common";
import { CliClient, type ResolvedSession } from "@dg/common/node";
import { type McpLink, McpLinkClosedError } from "./server";

function closedConnection(error: unknown): boolean {
	return (
		error instanceof DgCliError &&
		/closed the CLI connection|CLI connection failed/.test(error.message)
	);
}

export async function connectCliLink(
	session: ResolvedSession,
	connect: (session: ResolvedSession) => Promise<CliClient> = (value) =>
		CliClient.connect(value),
): Promise<McpLink> {
	const client = await connect(session);
	return {
		async request(frame, accept, timeoutMs) {
			try {
				return await client.request(frame, accept, timeoutMs);
			} catch (error) {
				throw closedConnection(error) ? new McpLinkClosedError() : error;
			}
		},
		close: () => client.close(),
	};
}
