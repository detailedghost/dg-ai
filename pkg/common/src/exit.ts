const DRAIN_TIMEOUT_MS = 5_000;

const endStream = (stream: NodeJS.WriteStream): Promise<void> => {
	let onError: () => void = () => {};
	return new Promise<void>((resolve) => {
		onError = () => resolve();
		stream.write = (() => true) as typeof stream.write;
		stream.once("error", onError);
		stream.end(() => resolve());
	}).finally(() => {
		stream.off("error", onError);
	});
};

/** Flushes stdout and stderr for up to 5 s, then exits with `code`; later writes are dropped, so call it at most once per process. */
export async function exitAfterDrain(code: number): Promise<never> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const expired = new Promise<void>((resolve) => {
		timer = setTimeout(resolve, DRAIN_TIMEOUT_MS);
	});
	await Promise.race([
		Promise.all([endStream(process.stdout), endStream(process.stderr)]),
		expired,
	]).finally(() => clearTimeout(timer));
	process.exit(code);
}
