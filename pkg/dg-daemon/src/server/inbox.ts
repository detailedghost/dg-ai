import { INBOX_RELAY, type InboxCliRequest } from "@dg/common";
import type { ServerWebSocket } from "bun";
import type { BrowserRelay } from "./browser-relay";
import { sendViaQueue, type SocketState } from "./connection";
import type { FrameHandlerDeps } from "./frame-handlers";

type Answer = { ok: true; value: unknown } | { ok: false; error: string };

/** Answers profile and cache operations from the store and hands browser operations to the inbox relay. */
export async function handleInboxCli({
	requester,
	sessionId,
	cli,
	deps,
	relay,
}: {
	requester: ServerWebSocket<SocketState>;
	sessionId: string;
	cli: InboxCliRequest;
	deps: FrameHandlerDeps;
	relay: BrowserRelay;
}): Promise<void> {
	if (cli.operation === "browser")
		return relay.handleRequest(requester, sessionId, cli);
	const reply = (answer: Answer) =>
		sendViaQueue(
			requester,
			JSON.stringify({
				type: INBOX_RELAY.frames.cliResult,
				sessionId,
				requestId: cli.requestId,
				...answer,
			}),
		);
	if (deps.registry.get(sessionId)?.state !== "active") {
		await reply({ ok: false, error: INBOX_RELAY.strings.activeRequired });
		return;
	}
	try {
		let value: unknown = null;
		switch (cli.operation) {
			case "profile-get":
				value = deps.store.getInboxProfile(cli.name!);
				break;
			case "profile-set":
				deps.store.setInboxProfile(cli.name!, cli.profile);
				break;
			case "profile-list":
				value = deps.store.listInboxProfiles();
				break;
			case "cache-get":
				value = deps.store.getInboxAuthCache(cli.name!, cli.provider!);
				break;
			case "cache-set":
				deps.store.setInboxAuthCache(cli.name!, cli.provider!, cli.cache);
				break;
		}
		await reply({ ok: true, value });
	} catch {
		await reply({
			ok: false,
			error:
				"Inbox configuration storage failed; check daemon health and encryption key access.",
		});
	}
}
