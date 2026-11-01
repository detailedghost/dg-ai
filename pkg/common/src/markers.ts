/** URL-fragment marker keys shared by the CLI (writer) and extension (reader). */
export const MARKER_KEY = "_tab_group";
export const MARKER_POS_KEY = "_tab_group_pos";
export const MARKER_BATCH_KEY = "_tab_group_batch";
export const DEMO_MARKER_KEY = "_demo";
export const EDIT_MARKER_KEY = "_edit";
export const PROTO_MARKER_KEY = "_proto";

export const BATCH_MAX_AGE_MS = 10 * 60 * 1000;
export const BATCH_MAX_SKEW_MS = 60 * 1000;

const BATCH_RANDOM_LENGTH = 4;
const BATCH_PATTERN = new RegExp(
	`^([0-9a-z]+)[0-9a-z]{${BATCH_RANDOM_LENGTH}}$`,
);

/** Batch id: issue time in base36 followed by four random base36 characters. */
export function newBatchId(now = Date.now()): string {
	const random = Math.random()
		.toString(36)
		.slice(2, 2 + BATCH_RANDOM_LENGTH)
		.padEnd(BATCH_RANDOM_LENGTH, "0");
	return `${now.toString(36)}${random}`;
}

/** Issue time of a batch id in epoch milliseconds, or undefined if unparseable. */
export function batchIssuedAt(batch: string | undefined): number | undefined {
	const time = batch && BATCH_PATTERN.exec(batch)?.[1];
	if (!time) return undefined;
	const ms = Number.parseInt(time, 36);
	return Number.isFinite(ms) ? ms : undefined;
}

/** True when the batch age is within BATCH_MAX_AGE_MS, allowing BATCH_MAX_SKEW_MS of clock skew. */
export function isBatchFresh(
	batch: string | undefined,
	now = Date.now(),
): boolean {
	const issuedAt = batchIssuedAt(batch);
	if (issuedAt === undefined) return false;
	const age = now - issuedAt;
	return age <= BATCH_MAX_AGE_MS && age >= -BATCH_MAX_SKEW_MS;
}
