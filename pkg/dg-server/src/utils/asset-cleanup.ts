/**
 * Session-close seam: slice 9 contributes the real staged-asset cleanup here
 * via setAssetCleanupHook, so it never has to edit slice 2's merged files —
 * mirrors ./key-source.ts's setKeySourceProvider pattern.
 */
export type AssetCleanupHook = (sessionId: string) => void;

const NO_CLEANUP: AssetCleanupHook = () => {};

let hook: AssetCleanupHook = NO_CLEANUP;

/** Last install wins; the returned disposer un-installs only its own hook. */
export function setAssetCleanupHook(next: AssetCleanupHook): () => void {
	hook = next;
	return () => {
		if (hook === next) hook = NO_CLEANUP;
	};
}

export function triggerAssetCleanup(sessionId: string): void {
	hook(sessionId);
}
