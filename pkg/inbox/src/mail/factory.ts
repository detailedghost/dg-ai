import type { AppConfig } from "../config/types";
import { createOutlookMailAccessClient } from "../outlook/mail-client";
import { createProtonBridgeMailAccessClient } from "../protonmail/bridge-client";
import type { InboxRuntime } from "../runtime";
import { FileMailAccessClient } from "./file-client";
import type { MailAccessClient } from "./types";

/** `--data-path` always wins, regardless of provider; gmail has no mail-command support in this release. */
export function createMailAccessClient(
	config: AppConfig,
	runtime: InboxRuntime,
): MailAccessClient {
	if (config.provider === "gmail") {
		throw new Error(
			"mail commands support outlook and protonmail; gmail is not supported in this release",
		);
	}
	if (config.mail.dataPath) {
		return new FileMailAccessClient({ dataPath: config.mail.dataPath });
	}
	if (config.provider === "outlook") {
		return createOutlookMailAccessClient(config, runtime);
	}
	return createProtonBridgeMailAccessClient(config, runtime);
}
