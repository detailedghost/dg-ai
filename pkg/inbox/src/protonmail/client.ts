import type { AppConfig } from "../config/types";
import { inboxRuntimeFor } from "../runtime";
import { PROTON_SIGN_IN_COMMAND } from "./pw-client";
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
			const { runtime } = inboxRuntimeFor(config);
			if (runtime.ext) {
				if (!runtime.browserRequest)
					throw new Error(
						"Proton Mail requires a connected dg extension and signed-in mail tab. Start a dg session and sign in to Proton Mail.",
					);
				return runtime.browserRequest(request);
			}
			if (!runtime.pwBrowserRequest)
				throw new Error(
					`Proton Mail runs through the pw profile. Run ${PROTON_SIGN_IN_COMMAND}, or pass --ext to use the extension.`,
				);
			return runtime.pwBrowserRequest(request);
		},
	});
}
