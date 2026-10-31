export interface AskStream {
	isTTY?: boolean;
	resume?: () => void;
	pause?: () => void;
	once: (event: "data", listener: (chunk: Uint8Array) => void) => void;
}

export function askSendApproval(
	draftId: string,
	stdin: AskStream,
	write: (text: string) => void,
): Promise<boolean> {
	write(`Send draft ${draftId}? [y/N] `);
	stdin.resume?.();
	return new Promise((resolve) => {
		stdin.once("data", (chunk) => {
			stdin.pause?.();
			const answer = new TextDecoder().decode(chunk).trim().toLowerCase();
			resolve(answer === "y" || answer === "yes");
		});
	});
}
