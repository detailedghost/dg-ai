import type { Log } from "../engine";
import type { ChatProvider } from "../providers/types";
import type { Sleep } from "../providers/teams-relay/sleep";
import type { ChatRef } from "./shared";

const REGISTER_INTERVAL_MS = 24 * 3_600_000;

export async function startChatRegistration({
	provider,
	chats,
	env,
	version,
	sleep,
	signal,
}: {
	provider: ChatProvider;
	chats: ChatRef[];
	env: string;
	version: string;
	sleep: Sleep;
	signal: AbortSignal;
}): Promise<void> {
	while (!signal.aborted) {
		await Promise.all(
			chats.map(({ id }) => provider.registerChat({ chatId: id, env, version })),
		);
		await sleep(REGISTER_INTERVAL_MS, signal);
	}
}
