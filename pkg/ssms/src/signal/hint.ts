export function signalCliInstallHint(): string {
	return [
		"signal-cli is not installed.",
		"Install it yourself, then retry. dg will not install packages.",
		"On Arch Linux the package is signal-cli (for example: sudo pacman -S signal-cli).",
		"Set DG_SIGNAL_CLI to the binary path if it is not on PATH.",
	].join(" ");
}

export function resolveSignalBinary(
	env: NodeJS.ProcessEnv,
	which: (name: string) => string | null,
	exists: (path: string) => boolean,
): string {
	const override = env.DG_SIGNAL_CLI;
	if (override) {
		if (!exists(override)) throw new Error(signalCliInstallHint());
		return override;
	}
	const found = which("signal-cli");
	if (!found) throw new Error(signalCliInstallHint());
	return found;
}
