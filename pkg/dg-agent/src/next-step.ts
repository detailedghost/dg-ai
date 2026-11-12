import type { SessionBootstrap } from "@dg/common";

const SESSION_ID_PREFIX = 8;

export function startNotice(
	{ agentIdentity, sessionId }: Pick<SessionBootstrap, "agentIdentity" | "sessionId">,
	extensionLinked: boolean,
): string {
	return extensionLinked
		? `Paired ${agentIdentity} (${sessionId.slice(0, SESSION_ID_PREFIX)}) with the browser extension.`
		: "No browser extension is connected. Install it with: dg-skills install";
}
