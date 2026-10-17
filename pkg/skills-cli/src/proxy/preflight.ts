import type { Backend } from "./backends/types";

/** Whether a backend binary is installed, with install guidance when it is missing. */
export interface PreflightResult {
	available: boolean;
	missing?: {
		backend: string;
		bin: string;
		installHint: string;
		installCommand: string;
		installUrl?: string;
	};
}

/**
 * Hard-stop check that runs before any backend invocation. A missing
 * binary must never silently fall through to a spawn attempt.
 */
export function checkPreflight(
	backendName: string,
	backend: Backend,
): PreflightResult {
	if (Bun.which(backend.bin)) {
		return { available: true };
	}

	return {
		available: false,
		missing: {
			backend: backendName,
			bin: backend.bin,
			installHint: backend.install.hint,
			installCommand: backend.install.command,
			installUrl: backend.install.url,
		},
	};
}
