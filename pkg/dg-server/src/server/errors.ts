/**
 * A typed error carrying its own exit code, so src/index.ts's top-level
 * handler never forecloses a distinct code (e.g. slice 7's reserved timeout
 * exit) behind a blanket exit(1).
 */
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
