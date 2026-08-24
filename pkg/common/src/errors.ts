import { CHAT_MAX_ASSET_BYTES } from "./chat-format";

export class DgCliError extends Error {
	readonly exitCode: number;

	constructor(message: string, exitCode = 1) {
		super(message);
		this.name = "DgCliError";
		this.exitCode = exitCode;
	}
}

export const EXIT_GENERAL_FAILURE = 1;
export const EXIT_NO_PORT_AVAILABLE = 2;
export const EXIT_WSL_NAT_NETWORKING = 3;
export const EXIT_PROTOCOL_MISMATCH = 4;
export const EXIT_RECV_TIMEOUT = 5;
export const EXIT_RECV_SESSION_CLOSED = 6;

export class AssetTooLargeError extends Error {
	constructor(byteLength: number) {
		super(
			`asset of ${byteLength} bytes exceeds CHAT_MAX_ASSET_BYTES (${CHAT_MAX_ASSET_BYTES})`,
		);
		this.name = "AssetTooLargeError";
	}
}

export function describeError(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

export function isEnoent(err: unknown): boolean {
	return (
		typeof err === "object" &&
		err !== null &&
		(err as NodeJS.ErrnoException).code === "ENOENT"
	);
}
