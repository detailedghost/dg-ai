import { createInterface } from "node:readline";
import { CREDENTIAL_MAX_VALUE_BYTES } from "../credentials-format";
import { DgCliError, EXIT_GENERAL_FAILURE } from "../errors";
import { readCappedStdin } from "./process";

const ESCAPE_SEQUENCE = /\u001b(?:\[[0-?]*[ -/]*[@-~]|O[@-~]|.)?/g;

/** Writes `question` to stderr and resolves with the first line of stdin; resolves null when stdin ends first. */
export function readLine(question: string): Promise<string | null> {
	return new Promise((resolve) => {
		const rl = createInterface({ input: process.stdin, terminal: false });
		let answered = false;
		rl.once("close", () => {
			if (!answered) resolve(null);
		});
		rl.once("line", (answer) => {
			answered = true;
			rl.close();
			resolve(answer);
		});
		process.stderr.write(question);
	});
}

export type HiddenInput = {
	setRawMode(mode: boolean): unknown;
	setEncoding(encoding: "utf8"): unknown;
	resume(): unknown;
	pause(): unknown;
	on(event: "data", listener: (chunk: string) => void): unknown;
	off(event: "data", listener: (chunk: string) => void): unknown;
};

/** Reads one line from a raw-mode TTY without echoing it. */
export function promptHidden(
	prompt: string,
	stdin: HiddenInput = process.stdin,
	output: { write(text: string): unknown } = process.stderr,
): Promise<string> {
	output.write(prompt);
	stdin.setRawMode(true);
	stdin.setEncoding("utf8");
	stdin.resume();
	return new Promise((resolve, reject) => {
		let value = "";
		const finish = (error?: Error) => {
			stdin.off("data", onData);
			stdin.setRawMode(false);
			stdin.pause();
			output.write("\n");
			if (error) reject(error);
			else resolve(value);
		};
		const onData = (chunk: string) => {
			for (const char of chunk.replace(ESCAPE_SEQUENCE, "")) {
				if (char === "\r" || char === "\n") return finish();
				if (char === "\u0003" || char === "\u0004") return finish(new Error("Canceled."));
				if (char === "\u007f" || char === "\b") value = Array.from(value).slice(0, -1).join("");
				else if (char >= " ") value += char;
			}
		};
		stdin.on("data", onData);
	});
}

/** Reads the secret from piped stdin, or from a hidden prompt on a TTY; it is never echoed. */
export async function readCredentialValue(): Promise<string> {
	if (process.stdin.isTTY) return promptHidden("Credential value: ");
	const text = await readCappedStdin(CREDENTIAL_MAX_VALUE_BYTES + 2);
	if (text === undefined) {
		throw new DgCliError(
			`credential value is larger than ${CREDENTIAL_MAX_VALUE_BYTES} bytes`,
			EXIT_GENERAL_FAILURE,
		);
	}
	return text.replace(/\r?\n$/, "");
}
