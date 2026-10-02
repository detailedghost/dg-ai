import type { AppConfig } from "../config/types";
import { inboxRuntimeFor } from "../runtime";
import { FileBackedProtonMailClient } from "./file-client";
import { ExtensionProtonMailClient } from "./extension-client";
export function createProtonMailClient(config: AppConfig) {
	if (config.provider !== "protonmail")
		throw new Error(
			"This Sieve filter operation requires the Proton Mail provider. Use provider-specific filter plans for Gmail or Outlook.",
		);
	if (config.protonmail.dataPath)
		return new FileBackedProtonMailClient({
			dataPath: config.protonmail.dataPath,
		});
	return new ExtensionProtonMailClient({
		config,
		browserRequest: async (request) => {
			const callback = inboxRuntimeFor(config).runtime.browserRequest;
			if (!callback)
				throw new Error(
					"Proton Mail requires a connected dg extension and signed-in mail tab. Start a dg session and sign in to Proton Mail.",
				);
			return callback(request);
		},
	});
}
