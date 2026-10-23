import type { AppConfig } from "../config/types";
import type { InboxRuntime } from "../runtime";
import type { MailAccessClient } from "../mail/types";

/** Stub for this slice; a later slice replaces the body with a Microsoft Graph-backed client. */
export function createOutlookMailAccessClient(
	_config: AppConfig,
	_runtime: InboxRuntime,
): MailAccessClient {
	throw new Error("not implemented in this build");
}
