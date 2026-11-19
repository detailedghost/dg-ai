import { describeError } from "@dg/common";
import type { Log } from "../../engine";
import { discard, RelayAuthError, type RelayClient } from "./client";

const SERVICE = "channel-review";
const REPO = "detailedghost/dg-ai";

export type ChatRegistration = { chatId: string; env: string; version: string };

export function createRegistrar({
	client,
	log,
	botName,
}: {
	client: RelayClient;
	log: Log;
	botName: string;
}) {
	return async function register({
		chatId,
		env,
		version,
	}: ChatRegistration): Promise<void> {
		try {
			const response = await client.request(
				`/chat/${encodeURIComponent(chatId)}/register`,
				{
					method: "PUT",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ service: SERVICE, env, version, repo: REPO }),
				},
			);
			await discard(response);
			if (response.status === 200 || response.status === 201) return;
			if (response.status === 400) {
				log.error(`chat ${chatId}: the relay rejected the registration (HTTP 400)`);
			} else if (response.status === 404) {
				log.warn(`chat ${chatId}: ${botName} is not a member, so the registration was skipped`);
			} else {
				log.warn(`chat ${chatId}: registration failed with HTTP ${response.status}`);
			}
		} catch (error) {
			log.warn(
				error instanceof RelayAuthError
					? `chat ${chatId}: the relay rejected the API code while registering the chat`
					: `chat ${chatId}: registration failed: ${describeError(error)}`,
			);
		}
	};
}
