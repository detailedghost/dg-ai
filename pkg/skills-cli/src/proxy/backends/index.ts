// Barrel: the only place outside this directory allowed to import a
// concrete backend module directly.

import { codex } from "./codex";
import { copilot } from "./copilot";
import { cortex } from "./cortex";
import { grok } from "./grok";
import { opencode } from "./opencode";
import { pi } from "./pi";
import type { Backend } from "./types";

export const BACKENDS: Record<string, Backend> = {
	codex,
	copilot,
	pi,
	opencode,
	cortex,
	grok,
};
