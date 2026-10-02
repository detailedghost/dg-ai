export function inboxProfile(overrides: Record<string, unknown> = {}) {
	return {
		provider: "gmail" as const,
		gmail: {
			clientId: "fixture-client-id",
			authMode: "browser" as const,
			redirectUri: "http://127.0.0.1:8765/oauth/callback",
			scopes: ["https://www.googleapis.com/auth/gmail.modify"],
			pageSize: 100,
			clientSecretEnv: "DG_INBOX_GMAIL_CLIENT_SECRET",
		},
		...overrides,
	};
}

export function inboxBrowserRequest(overrides: Record<string, unknown> = {}) {
	return { operation: "list-messages" as const, page: 0, pageSize: 100, ...overrides };
}

export function inboxCliRequest(overrides: Record<string, unknown> = {}) {
	return {
		type: "cli-inbox-request" as const,
		requestId: "inbox-request-a",
		operation: "browser" as const,
		request: inboxBrowserRequest(),
		...overrides,
	};
}
