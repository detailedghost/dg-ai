import { isPwExtWebUrl } from "@dg/common";
import { isProtonMailOrigin } from "@/lib/features/inbox-proton-observer";

export const PW_EXT_BLOCKED_ERROR =
	"pw --ext does not read or change browser settings pages, extension pages, or other non-web pages. Switch to a web page tab and retry.";
export const PW_EXT_MAILBOX_ERROR =
	"pw --ext does not read or change the signed-in Proton Mail tab. Use dg-skills inbox.";
export const PW_EXT_PRIVATE_ERROR =
	"pw --ext never reads or changes a tab in a private window.";

const STORE_HOSTS = new Set([
	"chromewebstore.google.com",
	"chrome.google.com",
	"microsoftedge.microsoft.com",
]);

export function allowedPage(url: string | undefined): url is string {
	if (!url || !isPwExtWebUrl(url)) return false;
	return !STORE_HOSTS.has(new URL(url).hostname);
}

export function mailbox(url: string | undefined): boolean {
	try {
		return isProtonMailOrigin(new URL(url ?? "").origin);
	} catch {
		return false;
	}
}

const OUTLOOK_HOSTS = new Set([
	"outlook.live.com",
	"outlook.office.com",
	"outlook.office365.com",
	"outlook.cloud.microsoft",
]);

export function outlookWeb(url: string | undefined): boolean {
	try {
		return OUTLOOK_HOSTS.has(new URL(url ?? "").hostname);
	} catch {
		return false;
	}
}
