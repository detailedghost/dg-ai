import type { ChannelConfig } from "../config";
import { localSecretName } from "../credentials";
import type { Log } from "../engine";
import {
	createTeamsRelayProvider,
	fetchRelaySecret,
	RelayAuthError,
} from "../providers/teams-relay";
import type { Connection, DaemonSeams, ResolvedEnv } from "./shared";

export function authRemedy(config: ChannelConfig, env: ResolvedEnv): string {
	const { id, key } = config.relay.secret;
	return [
		"The relay rejected the secret.",
		`Check that the AWS secret ${id} (key ${key}) holds the ${env.name} API code,`,
		`and run: aws sso login --profile ${env.awsProfile}`,
	].join(" ");
}

export async function connect({
	config,
	env,
	overrides,
	seams,
	log,
}: {
	config: ChannelConfig;
	env: ResolvedEnv;
	overrides: { chatId?: string };
	seams: DaemonSeams;
	log?: Log;
}): Promise<Connection> {
	const fetchSecret =
		seams.fetchSecret ?? ((params) => fetchRelaySecret(params));
	const { region, id, key } = config.relay.secret;
	const local = (seams.env ?? process.env)[localSecretName(env.name)]?.trim();
	const secret =
		local ||
		(await fetchSecret({
			profile: env.awsProfile,
			region,
			id,
			key,
		}));
	const createProvider = seams.createProvider ?? createTeamsRelayProvider;
	const provider = createProvider(config, env, {
		fetch: globalThis.fetch,
		secret,
		log,
	});
	try {
		const targets = overrides.chatId
			? [{ id: overrides.chatId }]
			: config.chats;
		const [first, ...rest] = await Promise.all(
			targets.map(({ id, topic }) => provider.resolveChat({ chatId: id, topic })),
		);
		if (!first) throw new Error("No chat to watch.");
		const chats: Connection["chats"] = [first, ...rest];
		const duplicate = chats.find(
			({ id }, index) => chats.findIndex((chat) => chat.id === id) !== index,
		);
		if (duplicate) {
			throw new Error(`More than one configured chat resolves to ${duplicate.id}.`);
		}
		return { secret, provider, chats };
	} catch (error) {
		if (error instanceof RelayAuthError) {
			throw new Error(authRemedy(config, env), { cause: error });
		}
		throw error;
	}
}
