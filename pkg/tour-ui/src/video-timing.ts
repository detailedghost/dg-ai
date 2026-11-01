/**
 * How long each step holds on screen during a recorded video demo.
 *
 * Shared by the offscreen recorder (which owns the real computation, since only it
 * knows how long each synthesized clip runs) and the content script (which falls
 * back to it when no recorder-supplied duration has arrived yet).
 */

/** Hold for an unnarrated step with no authored timing. */
export const DEFAULT_VIDEO_MS = 3500;

/** Silence appended after a clip so the advance can't clip the narration's tail. */
export const TAIL_GAP_MS = 700;

/** The subset of a step this module needs — `advance` is untrusted marker input. */
export type TimedStep = { advance?: unknown };

/**
 * Hold duration in ms for one step.
 *
 * When a step is narrated, an authored numeric timing is **dwell time after the
 * voice finishes**, not a floor on the whole step: a `4s` timing on a 6s clip holds
 * for 6s + tail + 4s. Treating it as a floor (the previous `max(...)` behaviour)
 * silently discarded the timing on any step whose narration outran it, which is
 * most of them — authored pauses only took effect on the shortest lines.
 *
 * Without narration there is nothing to wait for, so the authored timing is the
 * whole hold, falling back to DEFAULT_VIDEO_MS.
 */
export function holdFor(
	step: TimedStep | undefined,
	audioMs: number | null,
): number {
	const authored = typeof step?.advance === "number" ? step.advance : null;
	if (audioMs == null) return authored ?? DEFAULT_VIDEO_MS;
	return Math.round(audioMs + TAIL_GAP_MS + (authored ?? 0));
}
