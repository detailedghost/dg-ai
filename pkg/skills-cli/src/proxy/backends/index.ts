// Barrel: the only place outside this directory allowed to import a
// concrete backend module directly.

import { codex } from "./codex";
import { copilot } from "./copilot";
import { cortex } from "./cortex";
import { grok } from "./grok";
import { opencode } from "./opencode";
import { pi } from "./pi";
import type { Backend } from "./types";

/** Names of the supported backends. */
export type BackendName = "codex" | "copilot" | "pi" | "opencode" | "cortex" | "grok";

/** Registry of supported backend identities; selection is explicit and never falls back to another backend. */
export const BACKENDS: Record<BackendName, Backend> = {
	codex,
	copilot,
	pi,
	opencode,
	cortex,
	grok,
};

/** Look up a backend by user-supplied name; unknown names, including inherited object keys, return undefined. */
export function findBackend(name: string): Backend | undefined {
	return Object.hasOwn(BACKENDS, name) ? BACKENDS[name as BackendName] : undefined;
}
