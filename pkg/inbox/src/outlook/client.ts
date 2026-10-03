import type { AppConfig } from "../config/types";
import type { MailProviderClient } from "../providers/types";
import {
	EnvironmentMicrosoftTokenProvider,
	type MicrosoftTokenProvider,
} from "./auth";
import { FileBackedOutlookClient } from "./file-client";
import { GraphRestClient } from "./graph-client";

export function createOutlookProviderClient(
	config: AppConfig,
	input: { tokenProvider?: MicrosoftTokenProvider; fetch?: typeof fetch } = {},
): MailProviderClient {
	if (config.outlook.dataPath) {
		return new FileBackedOutlookClient({ dataPath: config.outlook.dataPath });
	}

	return new GraphRestClient({
		config,
		tokenProvider:
			input.tokenProvider ?? new EnvironmentMicrosoftTokenProvider(config),
		fetch: input.fetch,
	});
}
