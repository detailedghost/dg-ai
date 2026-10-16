export const REDACTED = "[redacted]";

const SECRET_NAME =
	/SECRET|TOKEN|PASSWORD|API_KEY|COOKIE|CREDENTIAL|PRIVATE_KEY/i;

const notedSecrets = new Set<string>();

/** Remember a credential so later log lines redact it even without naming it. */
export function noteSecret(value: string): void {
	if (value.length >= 8) notedSecrets.add(value);
}

export function clearNotedSecrets(): void {
	notedSecrets.clear();
}

const PATTERNS: ReadonlyArray<{ pattern: RegExp; replacement: string }> = [
	{
		pattern: /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,
		replacement: REDACTED,
	},
	{
		pattern: /Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi,
		replacement: `Bearer ${REDACTED}`,
	},
	{
		pattern:
			/(?:authorization|cookie|set-cookie|x-api-key|api-key)\s*[:=]\s*[^\s,;]+/gi,
		replacement: REDACTED,
	},
	{
		pattern:
			/([?#&](?:token|access_token|refresh_token|id_token|code|session|api_key|apikey|key)=)[^&#\s]+/gi,
		replacement: `$1${REDACTED}`,
	},
	{
		pattern: /(#[A-Za-z0-9_-]*chat=)[A-Za-z0-9_-]+/gi,
		replacement: `$1${REDACTED}`,
	},
	{
		pattern:
			/\b([A-Z][A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|API_KEY|COOKIE|CREDENTIAL)[A-Z0-9_]*)=[^\s]+/g,
		replacement: `$1=${REDACTED}`,
	},
	{
		pattern:
			/\b(?:sk|pk|rk|ghp|gho|github_pat|xox[baprs]|AKIA)[-_A-Za-z0-9]{8,}\b/g,
		replacement: REDACTED,
	},
	{
		pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
		replacement: REDACTED,
	},
	{
		pattern:
			/"(token|accessToken|refreshToken|apiKey|authorization|password|secret|cookie)"\s*:\s*"[^"]{8,}"/g,
		replacement: `"$1":"${REDACTED}"`,
	},
];

function envSecrets(): string[] {
	const values: string[] = [];
	for (const [name, value] of Object.entries(process.env)) {
		if (!value || value.length < 8 || !SECRET_NAME.test(name)) continue;
		values.push(value);
	}
	return values;
}

function replaceLiteral(message: string, secret: string): string {
	if (secret.length < 8 || !message.includes(secret)) return message;
	return message.split(secret).join(REDACTED);
}

/** Redacts credentials from a log line. Short explicit secrets are left alone. */
export function redactText(
	message: string,
	secrets: readonly string[] = [],
): string {
	const literals = [...secrets, ...notedSecrets, ...envSecrets()].sort(
		(a, b) => b.length - a.length,
	);
	let redacted = message;
	for (const secret of literals) redacted = replaceLiteral(redacted, secret);
	for (const { pattern, replacement } of PATTERNS) {
		redacted = redacted.replace(pattern, replacement);
	}
	return redacted;
}

export function redactUnknown(value: unknown): unknown {
	if (typeof value === "string") return redactText(value);
	if (value instanceof Error) {
		const copy = new Error(redactText(value.message));
		copy.name = value.name;
		if (value.stack) copy.stack = redactText(value.stack);
		return copy;
	}
	return value;
}

export function emitRedacted(
	write: (line: string) => void,
	message: string,
	secrets?: readonly string[],
): void {
	write(redactText(message, secrets));
}

const CONSOLE_METHODS = ["log", "info", "warn", "error", "debug"] as const;

/** Routes one console through redactText. Used by the bun test preload. */
export function installRedactingConsole(target: Console = console): void {
	const marked = target as Console & { __dgRedacted?: boolean };
	if (marked.__dgRedacted) return;
	marked.__dgRedacted = true;
	for (const method of CONSOLE_METHODS) {
		const original = target[method].bind(target);
		target[method] = ((...args: unknown[]) => {
			original(...args.map(redactUnknown));
		}) as Console[typeof method];
	}
}
