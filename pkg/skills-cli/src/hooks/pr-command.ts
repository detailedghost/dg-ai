const SHELL_C = String.raw`\b(?:ba|z|da)?sh\s+-\w*c\s+['"]`;
const ASSIGNMENTS = String.raw`(?:[A-Za-z_]\w*=\S*\s+)*`;
const WRAPPERS = String.raw`(?:(?:sudo|env|command|time|exec|nice)\s+(?:-\S+\s+)*${ASSIGNMENTS})*`;
const START = String.raw`(?:^|[;&|(\n\`]|\$\(|${SHELL_C})\s*${ASSIGNMENTS}${WRAPPERS}`;
const FLAGS = String.raw`(?:-\S+\s+(?:[^-\s]\S*\s+)?){0,20}`;

export type PrAction = "create" | "edit" | "update";

/** Index where the first GitHub or GitLab PR CLI call with one of the actions starts, or -1. */
export function prCommandIndex(
	command: string,
	actions: readonly PrAction[],
): number {
	const alt = actions.join("|");
	const pattern = new RegExp(
		`${START}(?:gh\\s+${FLAGS}pr\\s+${FLAGS}|glab\\s+${FLAGS}mr\\s+${FLAGS})(?:${alt})\\b`,
	);
	return pattern.exec(command)?.index ?? -1;
}

/** True when a shell command runs the GitHub or GitLab PR CLI with one of the actions at command position. */
export function invokesPrCommand(
	command: string,
	actions: readonly PrAction[],
): boolean {
	return prCommandIndex(command, actions) >= 0;
}
