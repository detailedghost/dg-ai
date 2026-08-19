/**
 * Session-close seam: slice 9 contributes the real staged-asset cleanup here
 * via setAssetCleanupHook, so it never has to edit slice 2's merged files —
 * mirrors ./key-source.ts's setKeySourceProvider pattern.
 */
export type AssetCleanupHook = (sessionId: string) => void;

let hook: AssetCleanupHook = () => {};

export function setAssetCleanupHook(next: AssetCleanupHook): void {
	hook = next;
}

export function triggerAssetCleanup(sessionId: string): void {
	hook(sessionId);
}
