export const DEFAULT_IDLE_TTL_MS = 24 * 60 * 60 * 1000;

export type IdleTtlOptions = {
	ttlMs: number;
	isIdle(): boolean;
	onExpire(): void;
};

export type IdleController = {
	noteActivity(): void;
	stop(): void;
};

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
			else arm();
		}, options.ttlMs);
		timer.unref?.();
	}

	arm();

	return {
		noteActivity: arm,
		stop: clear,
	};
}
