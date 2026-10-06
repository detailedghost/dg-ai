/** Fixed diagnostics cross the page boundary without copying provider responses or credentials. */
export const PROTON_OPERATION_ERRORS = {
	"unsupported-response": "Proton API returned an unsupported response. Reload Proton Mail and retry.",
	"folder-membership": "Proton returned messages outside the requested folder scope or without trustworthy membership. Refresh the mailbox and retry the scan.",
	"invalid-origin": "Open an authenticated HTTPS Proton Mail origin to use inbox cleanup.",
	"empty-sieve": "Proton filter creation requires a reviewed non-empty Sieve policy.",
	"session-unobserved": "Sign in to Proton Mail, reload the mail tab, then retry so the extension observes its session.",
	"auth-expired": "Sign in to Proton Mail and reload its tab to restore the authenticated session.",
	"http-failure": "Proton API request failed. Check the mail tab and retry after any rate limit clears.",
	"api-rejected": "Proton API rejected the operation. Check the mail tab and reviewed settings before retrying.",
	"incomplete-action": "Proton API did not complete every reviewed message action. Refresh the mailbox state before retrying.",
	"timeout": "Proton request timed out. Check the mail tab and retry.",
	"network": "Proton API could not complete the operation. Reload its mail tab and retry.",
	"stale-page": "Proton message page is stale. Refresh the mail tab and retry the scan.",
	"incomplete-filter": "Proton returned an incomplete filter policy. Refresh the filter snapshot before retrying the reviewed update.",
} as const;

/** Only allowlisted codes and numeric status survive the MAIN execution boundary. */
export function protonOperationDiagnostic(value: Record<string, unknown>): string | undefined {
	const code = value.code;
	if (typeof code !== "string" || !Object.hasOwn(PROTON_OPERATION_ERRORS, code)) return;
	const message = PROTON_OPERATION_ERRORS[code as keyof typeof PROTON_OPERATION_ERRORS];
	const status = value.status;
	return typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599
		? `${message} (HTTP ${status}; ${code})`
		: `${message} (${code})`;
}

export class ProtonOperationError extends Error {
	constructor(readonly code: keyof typeof PROTON_OPERATION_ERRORS, readonly status?: number) {
		super(PROTON_OPERATION_ERRORS[code]);
	}
}
