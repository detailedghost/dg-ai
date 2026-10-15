import type { ChannelConfig, EnvSettings } from "../../config";
import type { ChatProvider } from "../types";
import { resolveChat } from "./chats";
import { createRelayClient } from "./client";
import { createReactions } from "./reactions";
import { reply } from "./reply";
import { abortableSleep } from "./sleep";
import { createSubscribe } from "./subscribe";
import type { ProviderSeams } from "./types";

const silentLog = {
	info: () => undefined,
	warn: () => undefined,
	error: () => undefined,
};

export function createTeamsRelayProvider(
	config: ChannelConfig,
	env: EnvSettings,
	{
		fetch,
		secret,
		sleep = abortableSleep,
		now = Date.now,
		random = Math.random,
		log = silentLog,
	}: ProviderSeams,
): ChatProvider {
	const client = createRelayClient({
		baseUrl: env.baseUrl,
		appName: config.relay.appName,
		secret,
		fetch,
	});
	const reactions = createReactions({ client, sleep, now });
	return {
		resolveChat: (query) => resolveChat(client, query, env.botName),
		subscribe: createSubscribe({ client, sleep, random, log, botName: env.botName }),
		react: reactions.react,
		unreact: reactions.unreact,
		reply: (request) => reply(client, config.owner.email, request),
		listReactions: reactions.list,
	};
}
