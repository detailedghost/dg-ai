import { containsSecret, redactSecrets } from "./redact";

export const LOG_REASONS = [
	"link-uri",
	"linked",
	"not-linked",
	"list",
	"read",
	"receive",
	"archive",
	"block",
	"draft",
	"send",
	"send-refused",
	"unsupported",
	"dry-run",
	"missing-binary",
	"daemon-start",
	"daemon-stop",
	"cleanup",
	"redacted-secret",
] as const;

export type LogReason = (typeof LOG_REASONS)[number];

export interface LogEvent {
	id: string;
	reason: LogReason;
	provider?: string;
	verb?: string;
}

export function sanitizeLogLine(event: LogEvent): string {
	const id = redactSecrets(event.id);
	const leaked = containsSecret(event.id) || containsSecret(event.reason);
	return JSON.stringify({
		id,
		reason: leaked ? "redacted-secret" : event.reason,
		provider: event.provider,
		verb: event.verb,
	});
}

export type Logger = (event: LogEvent) => void;

export function createLogger(write: (line: string) => void): Logger {
	return (event) => {
		write(sanitizeLogLine(event));
	};
}
