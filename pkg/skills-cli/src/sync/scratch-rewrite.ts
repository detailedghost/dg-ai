import { scratchRoot, stateRoot } from "@dg/common/node";

const SCRATCH_ROOTS = ["/tmp/ai", "/tmp/claude", "/tmp/codex", "/tmp/copilot", "/tmp/opencode", "/tmp/pi"];
const STATE_ROOTS = ["~/.local/state/ai", "$HOME/.local/state/ai"];

/**
 * Rewrite every known tool-specific scratch/state root to this process's own
 * (from `@dg/common/node`'s `AI_SCRATCH_DIR`/`AI_STATE_DIR` resolution), so a
 * copied skill or agent keeps the scratch/state distinction but points at the
 * target tool's actual roots. State roots go first: a state literal can embed
 * a scratch literal once overridden.
 */
export function rewriteScratchPaths(value: string, env: NodeJS.ProcessEnv = process.env): string {
	const state = stateRoot(env);
	const scratch = scratchRoot(env);
	const withState = STATE_ROOTS.reduce((out, root) => out.replaceAll(root, state), value);
	return SCRATCH_ROOTS.reduce((out, root) => out.replaceAll(root, scratch), withState);
}
