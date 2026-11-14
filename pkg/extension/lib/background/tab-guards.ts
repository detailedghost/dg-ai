import { isPwExtWebUrl } from "@dg/common";
import { isProtonMailOrigin } from "@/lib/features/inbox-proton-observer";

export const PW_EXT_BLOCKED_ERROR =
	"pw --ext does not read or change browser settings pages, extension pages, or other non-web pages. Switch to a web page tab and retry.";
export const PW_EXT_MAILBOX_ERROR =
	"pw --ext does not read or change a signed-in mailbox tab. Proton Mail: use dg-skills inbox. Outlook: use its dg_ tools (pw --ext tools).";
export const PW_EXT_PRIVATE_ERROR =
	"pw --ext never reads or changes a tab in a private window.";

const STORE_HOSTS = new Set([
	"chromewebstore.google.com",
	"chrome.google.com",
	"microsoftedge.microsoft.com",
]);

const OUTLOOK_HOSTS = new Set([
	"outlook.live.com",
	"outlook.office.com",
	"outlook.office365.com",
	"outlook.cloud.microsoft",
]);

export function allowedPage(url: string | undefined): url is string {
	if (!url || !isPwExtWebUrl(url)) return false;
	return !STORE_HOSTS.has(new URL(url).hostname);
}

export function mailbox(url: string | undefined): boolean {
	try {
		const { origin, hostname } = new URL(url ?? "");
		return isProtonMailOrigin(origin) || OUTLOOK_HOSTS.has(hostname);
	} catch {
		return false;
	}
}
