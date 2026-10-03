import type { AppConfig } from "../config/types";
import type { MailProviderClient } from "../providers/types";
import {
	EnvironmentGoogleTokenProvider,
	type GoogleTokenProvider,
} from "./auth";
import { FileBackedGmailClient } from "./file-client";
import { GmailRestClient } from "./rest-client";

export function createGmailProviderClient(
	config: AppConfig,
	input: { tokenProvider?: GoogleTokenProvider; fetch?: typeof fetch } = {},
): MailProviderClient {
	if (config.gmail.dataPath) {
		return new FileBackedGmailClient({ dataPath: config.gmail.dataPath });
	}

	return new GmailRestClient({
		config,
		tokenProvider:
			input.tokenProvider ?? new EnvironmentGoogleTokenProvider(config),
		fetch: input.fetch,
	});
}
