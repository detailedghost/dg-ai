import { createInterface } from "node:readline";

/** Writes `question` to stderr and resolves with the first line of stdin; resolves null when stdin ends first. */
export function readLine(question: string): Promise<string | null> {
	return new Promise((resolve) => {
		const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: false });
		let answered = false;
		rl.once("close", () => {
			if (!answered) resolve(null);
		});
		rl.question(question, (answer) => {
			answered = true;
			rl.close();
			resolve(answer);
		});
	});
}
