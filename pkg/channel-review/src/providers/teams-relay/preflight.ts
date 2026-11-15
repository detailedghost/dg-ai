import { describeError } from "@dg/common";
import type { ChannelConfig, EnvSettings } from "../../config";
import { missingRelaySecretRemedy } from "../../credentials";
import { loadFunPool } from "../../fun";
import { resolveChat } from "./chats";
import { createRelayClient, type RelayClient } from "./client";
import { validateReactionIds } from "./reaction-id";
import { createReactions } from "./reactions";

type Check = "ok" | "skipped" | { error: string };

export type PreflightReport = {
	env: string;
	secret: Check;
	chats: ({ id: string; topic?: string } | { error: string })[] | "skipped";
	reactions: Check;
	funPool: "ok" | "skipped" | { dropped: string[] };
};

async function checkChats(
	client: RelayClient,
	config: ChannelConfig,
	botName: string,
): Promise<Exclude<PreflightReport["chats"], "skipped">> {
	return Promise.all(
		config.chats.map(async ({ id, topic }) => {
			try {
				return await resolveChat(client, { chatId: id, topic }, botName);
			} catch (error) {
				return { error: `${id ?? topic}: ${describeError(error)}` };
			}
		}),
	);
}

async function checkReactions(
	client: RelayClient,
	config: ChannelConfig,
): Promise<Pick<PreflightReport, "reactions" | "funPool">> {
	let listed: string[];
	try {
		listed = await createReactions({
			client,
			sleep: () => Promise.resolve(),
			now: Date.now,
		}).list();
	} catch (error) {
		return { reactions: { error: describeError(error) }, funPool: "skipped" };
	}
	const configured: Record<string, string> = {};
	for (const [key, id] of Object.entries(config.reactions)) {
		configured[`reactions.${key}`] = id;
	}
	let reactions: Check = "ok";
	try {
		validateReactionIds(configured, listed);
	} catch (error) {
		reactions = { error: describeError(error) };
	}
	const known = new Set(listed);
	const dropped = (config.fun.pool ?? loadFunPool()).flatMap((entry, index) =>
		entry.kind === "emoji" && !known.has(entry.reactionId)
			? [`fun.pool[${index}].reactionId ${entry.reactionId}`]
			: [],
	);
	return { reactions, funPool: dropped.length ? { dropped } : "ok" };
}

export async function preflight({
	config,
	env,
	fetch,
	secret: resolvedSecret,
}: {
	config: ChannelConfig;
	env: EnvSettings & { name: string };
	fetch: typeof globalThis.fetch;
	secret?: string;
}): Promise<PreflightReport> {
	if (!resolvedSecret) {
		return {
			env: env.name,
			secret: { error: missingRelaySecretRemedy(env.name) },
			chats: "skipped",
			reactions: "skipped",
			funPool: "skipped",
		};
	}
	const client = createRelayClient({
		baseUrl: env.baseUrl,
		appName: config.relay.appName,
		secret: resolvedSecret,
		fetch,
	});
	return {
		env: env.name,
		secret: "ok",
		chats: await checkChats(client, config, env.botName),
		...(await checkReactions(client, config)),
	};
}
