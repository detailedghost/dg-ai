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

const EMAIL = {
	pattern: /(^|[^A-Z0-9._%+-])[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,
	replacement: `$1${REDACTED}`,
};

const SECRET_PATTERNS: ReadonlyArray<{ pattern: RegExp; replacement: string }> = [
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
			/\b(?:sk|pk|rk|ghp|gho|ghs|github_pat|glpat|xox[baprs]|AKIA)[-_A-Za-z0-9]{8,}\b/g,
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

const PATTERNS = [EMAIL, ...SECRET_PATTERNS];

function envSecrets(): string[] {
	const values: string[] = [];
	const env = typeof process === "undefined" ? undefined : process?.env;
	for (const [name, value] of Object.entries(env ?? {})) {
		if (!value || value.length < 8 || !SECRET_NAME.test(name)) continue;
		values.push(value);
	}
	return values;
}

const MIN_CLIPPED_START = 3;

function literalForms(secrets: readonly string[]): string[] {
	return [
		...new Set(
			secrets
				.filter((secret) => secret.length > 0)
				.flatMap((secret) => {
					const lowerHex = (text: string) => text.replace(/%[0-9A-F]{2}/g, (hex) => hex.toLowerCase());
					const encoded = encodeURIComponent(secret);
					const form = new URLSearchParams({ v: secret }).toString().slice(2);
					return [
						secret,
						secret.replace(/\s+/g, " "),
						JSON.stringify(secret).slice(1, -1),
						secret.replace(/[\r\n]/g, ""),
						encoded,
						lowerHex(encoded),
						encoded.replace(/%20/g, "+"),
						form,
						lowerHex(form),
					];
				}),
		),
	].filter((form) => form.length > 0);
}

/** Masks each given secret, its whitespace-collapsed, JSON-escaped, line-break-free and URL-encoded forms, and a clipped start of 3+ characters before an ellipsis. */
export function redactLiterals(message: string, secrets: readonly string[]): string {
	const literals = literalForms(secrets).sort((a, b) => b.length - a.length);
	const whole = literals.reduce((out, secret) => out.split(secret).join(REDACTED), message);
	return literals.reduce((out, secret) => {
		let clipped = out;
		for (let size = secret.length - 1; size >= MIN_CLIPPED_START; size--)
			clipped = clipped.split(`${secret.slice(0, size)}…`).join(`${REDACTED}…`);
		return clipped;
	}, whole);
}

/** A credential pattern and the replacement its match gets. */
export type RedactPattern = { pattern: RegExp; replacement: string };

/** Extra inputs for redactText and redactSecrets. */
export type RedactOptions = {
	/** Values masked at any length, with their redactLiterals forms. */
	literals?: readonly string[];
	extraPatterns?: readonly RedactPattern[];
};

function keptEnds(match: string, expanded: string): [number, number] {
	const at = expanded.indexOf(REDACTED);
	const before = at === -1 ? "" : expanded.slice(0, at);
	const after = at === -1 ? "" : expanded.slice(at + REDACTED.length);
	let head = 0;
	while (head < match.length && head < before.length && match[head] === before[head]) head++;
	let tail = 0;
	while (
		tail < match.length - head &&
		tail < after.length &&
		match[match.length - 1 - tail] === after[after.length - 1 - tail]
	)
		tail++;
	return [head, tail];
}

function redactWith(
	patterns: readonly RedactPattern[],
	message: string,
	secrets: readonly string[],
	{ literals = [], extraPatterns = [] }: RedactOptions = {},
): string {
	const masked = new Uint8Array(message.length);
	const values = [
		...[...secrets, ...notedSecrets, ...envSecrets()].filter((secret) => secret.length >= 8),
		...literalForms(literals),
	];
	for (const value of values)
		for (let at = message.indexOf(value); at !== -1; at = message.indexOf(value, at + 1))
			masked.fill(1, at, at + value.length);
	for (const { pattern, replacement } of [...patterns, ...extraPatterns])
		for (const match of message.matchAll(pattern)) {
			const expanded = replacement.replace(/\$(\d)/g, (_, group: string) => match[Number(group)] ?? "");
			const at = match.index ?? 0;
			const [head, tail] = keptEnds(match[0], expanded);
			masked.fill(1, at + head, at + match[0].length - tail);
		}
	const parts: string[] = [];
	let start = 0;
	for (let i = 1; i <= message.length; i++) {
		if (i < message.length && masked[i] === masked[start]) continue;
		parts.push(masked[start] ? REDACTED : message.slice(start, i));
		start = i;
	}
	return parts.join("");
}

/** Redacts credentials from a log line. Short explicit secrets are left alone. */
export function redactText(
	message: string,
	secrets: readonly string[] = [],
	options?: RedactOptions,
): string {
	return redactWith(PATTERNS, message, secrets, options);
}

/** Like redactText, but leaves email addresses in place, for a user-approved unmask. */
export function redactSecrets(
	message: string,
	secrets: readonly string[] = [],
	options?: RedactOptions,
): string {
	return redactWith(SECRET_PATTERNS, message, secrets, options);
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
