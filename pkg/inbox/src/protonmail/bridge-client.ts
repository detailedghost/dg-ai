import type { AppConfig } from "../config/types";
import type { InboxRuntime } from "../runtime";
import type { MailAccessClient } from "../mail/types";

/** Stub for this slice; a later slice replaces the body with a Proton Bridge IMAP/SMTP-backed client. */
export function createProtonBridgeMailAccessClient(
	_config: AppConfig,
	_runtime: InboxRuntime,
): MailAccessClient {
	throw new Error("not implemented in this build");
}
