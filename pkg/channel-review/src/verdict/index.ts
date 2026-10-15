import { createGithubReader } from "./github";
import { createGitlabReader } from "./gitlab";
import type { CaptureFn } from "./cli";
import type { VerdictReader } from "./types";

export { createStackReader } from "./stack";

export function createVerdictReader({
	runCapture,
	which = Bun.which,
}: {
	runCapture: CaptureFn;
	which?: (name: string) => string | undefined | null;
}): VerdictReader {
	const readers = {
		github: createGithubReader(runCapture, which),
		gitlab: createGitlabReader(runCapture, which),
	};
	return {
		probe: ({ host, url }) => readers[host].probe({ host, url }),
		read: ({ url, host, since }) => readers[host].read(url, since),
	};
}
