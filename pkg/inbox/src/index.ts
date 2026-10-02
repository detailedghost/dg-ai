export { main } from "./cli/index";
export type { InboxRuntime } from "./runtime";
export type {
	MailProvider,
	MailProviderClient,
	MailMessageSummary,
	MailFolder,
	MailRule,
} from "./providers/types";
export type {
	InboxProfile,
	InboxProviderSettings,
	InboxBrowserRequest,
	InboxBrowserResponse,
} from "@dg/common";
export { ExtensionProtonMailClient } from "./protonmail/extension-client";
export { GmailRestClient } from "./gmail/rest-client";
export { GraphRestClient } from "./outlook/graph-client";
