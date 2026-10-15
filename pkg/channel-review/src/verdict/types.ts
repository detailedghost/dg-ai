import type { CrCode } from "../errors";

export type PrHost = "github" | "gitlab";

export type Verdict = "approved" | "changes_requested" | "commented" | "none";

export class VerdictError extends Error {
	readonly code: CrCode;

	constructor(code: CrCode, message?: string) {
		super(message ?? code);
		this.name = "VerdictError";
		this.code = code;
	}
}

export type VerdictReader = {
	probe(request: { host: PrHost; url?: string }): Promise<{ ok: true } | { ok: false; code: Extract<CrCode, "CR-303"> }>;
	read(request: { url: string; host: PrHost; since: Date }): Promise<Verdict>;
};

export type StackReader = {
	descendants(request: {
		url: string;
		host: PrHost;
	}): Promise<{ number: number; url: string }[]>;
};
