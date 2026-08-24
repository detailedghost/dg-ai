export type AssetCleanupHook = (sessionId: string) => void;

const NO_CLEANUP: AssetCleanupHook = () => {};

let hook: AssetCleanupHook = NO_CLEANUP;

export function setAssetCleanupHook(next: AssetCleanupHook): () => void {
	hook = next;
	return () => {
		if (hook === next) hook = NO_CLEANUP;
	};
}

export function triggerAssetCleanup(sessionId: string): void {
	hook(sessionId);
}
