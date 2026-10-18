import type { Backend } from "./backends/types";

/**
 * Hard-stop check that runs before any backend invocation. A missing
 * binary must never silently fall through to a spawn attempt.
 */
export function checkPreflight(
	backendName: string,
	backend: Backend,
): {
	available: boolean;
	missing?: {
		backend: string;
		bin: string;
		installHint: string;
		installCommand: string;
		installUrl?: string;
	};
} {
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
