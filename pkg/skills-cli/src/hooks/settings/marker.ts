const BIN = String.raw`dg-skills(?:\.cmd|\.exe)?`;
const OWNED = new RegExp(
	String.raw`^(?:"[^"]*[\\/]${BIN}"|'[^']*[\\/]${BIN}'|(?:[^\s;&|\x60$<>()"']*[\\/])?${BIN}) hooks run ([a-z][a-z-]*)$`,
);
const SAFE_LAUNCHER = /^[\w.:/\\ @+~-]+$/;

function quoted(launcher: string): string {
	if (!SAFE_LAUNCHER.test(launcher))
		throw new Error(
			`launcher path ${launcher} has characters a hook command cannot carry`,
		);
	if (!/\s/.test(launcher)) return launcher;
	return /[\\]|^[A-Za-z]:/.test(launcher) ? `"${launcher}"` : `'${launcher}'`;
}

export const ownedCommand = (launcher: string, id: string): string =>
	`${quoted(launcher)} hooks run ${id}`;

export const ownedId = (command: string): string | undefined =>
	OWNED.exec(command.trim())?.[1];

export const isOwned = (command: string): boolean =>
	ownedId(command) !== undefined;
