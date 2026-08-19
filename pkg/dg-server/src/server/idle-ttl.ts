/** Production default: linger a while after the last session closes. Tests override via DG_IDLE_TTL_MS. */
export const DEFAULT_IDLE_TTL_MS = 30 * 60 * 1000;

export type IdleTtlOptions = {
	ttlMs: number;
	/** Zero registered sessions AND zero open connections for the whole window. */
	isIdle(): boolean;
	onExpire(): void;
};

export type IdleController = {
	/** Call on every session/connection state change — pins the daemon while non-idle. */
	noteActivity(): void;
	stop(): void;
};

/**
 * A single rescheduled timer, not a polling loop: any activity cancels it,
 * and it is only (re)armed while the predicate holds continuously.
 */
export function createIdleController(options: IdleTtlOptions): IdleController {
	let timer: ReturnType<typeof setTimeout> | undefined;

	function clear(): void {
		if (timer !== undefined) {
			clearTimeout(timer);
			timer = undefined;
		}
	}

	function arm(): void {
		clear();
		if (!options.isIdle()) return;
		timer = setTimeout(() => {
			if (options.isIdle()) options.onExpire();
			else arm(); // activity landed between the check and the timeout firing
		}, options.ttlMs);
		timer.unref?.();
	}

	arm(); // predicate may already hold at construction time (a fresh __serve with no sessions yet)

	return {
		noteActivity: arm,
		stop: clear,
	};
}
