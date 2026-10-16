export class RateLimitError extends Error {
	constructor(
		readonly retryAfterMs: number,
		message = `rate limited; retry in ${Math.ceil(retryAfterMs / 1000)} s`,
	) {
		super(message);
		this.name = "RateLimitError";
	}
}

export class AuthError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AuthError";
	}
}

export class ConfigError extends Error {
	constructor(readonly missing: string[]) {
		super(`missing environment variables: ${missing.join(", ")}`);
		this.name = "ConfigError";
	}
}
