const ESCAPE_SEQUENCE =
	/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[P^_X][^\x1b]*\x1b\\|\x1b\[[0-?]*[ -/]*[@-~]|\x1b[ -/]*[0-~]/g;
const CONTROL_BYTES = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

/** Remove ANSI escape sequences and stray control bytes, keeping tabs and newlines. */
export function stripTerminalEscapes(text: string): string {
	return text.replace(ESCAPE_SEQUENCE, "").replace(CONTROL_BYTES, "");
}
