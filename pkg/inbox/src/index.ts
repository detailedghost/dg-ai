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
export { isProtonMailOrigin } from "./protonmail/page-session";
export { ExtensionProtonMailClient } from "./protonmail/extension-client";
export {
	createPwBrowserRequest,
	protonProfilePaths,
	PROTON_MAIL_URL,
	PROTON_SESSION_NAME,
	PROTON_SIGN_IN_COMMAND,
	ProtonSignedOutError,
	type ProtonPwPage,
	type ProtonPwSession,
	type ProtonPwSessionSpec,
} from "./protonmail/pw-client";
export { GmailRestClient } from "./gmail/rest-client";
export { GraphRestClient } from "./outlook/graph-client";
export { redactPublicValue } from "./privacy/redact";
