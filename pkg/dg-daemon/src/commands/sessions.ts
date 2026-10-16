import { CHAT_SESSIONS_CLEAR_PATH, redactText } from "@dg/common";
import { loopbackHostHeader, readPidFile, resolveDgPaths } from "@dg/common/node";
import type { Command } from "commander";

export function registerSessionCommands(program: Command): void {
	const sessions = program
		.command("sessions")
		.description("inspect or clear chat sessions on the running daemon");

	sessions
		.command("clear")
		.description(
			"close sessions no CLI is attached to, leaving sessions that are waiting for an agent",
		)
		.action(async () => {
			const paths = resolveDgPaths();
			const handle = readPidFile(paths);
			if (!handle) {
				console.error("dg-daemon: no daemon is running");
				process.exitCode = 1;
				return;
			}
			const response = await fetch(
				`http://127.0.0.1:${handle.port}${CHAT_SESSIONS_CLEAR_PATH}`,
				{
					method: "POST",
					headers: loopbackHostHeader(handle.port),
				},
			);
			if (!response.ok) {
				const body = await response.text();
				console.error(
					`dg-daemon: could not clear sessions: ${response.status} ${redactText(body)}`,
				);
				process.exitCode = 1;
				return;
			}
			const body = (await response.json()) as { closed?: unknown };
			const closed = Array.isArray(body.closed) ? body.closed.length : 0;
			console.log(`cleared ${closed} disconnected session${closed === 1 ? "" : "s"}`);
		});
}
