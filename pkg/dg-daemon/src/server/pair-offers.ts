import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { PairOffer, PairOfferStatus, SessionBootstrap } from "@dg/common";
import {
	generatePairingCode,
	hashPairingCode,
	PAIRING_MAX_ATTEMPTS,
	PAIRING_TTL_MS,
} from "../pairing";

type OfferRecord = {
	hash: Buffer;
	origin: string;
	expiresAt: number;
	expired: boolean;
	bootstrap?: SessionBootstrap;
};

type ClaimMemory = {
	hash: Buffer;
	offerId: string;
	expiresAt: number;
};

export type PairOffersOptions = {
	now?: () => number;
	ttlMs?: number;
	maxOutstanding?: number;
	maxFailures?: number;
};

type PairClaimOutcome =
	| { outcome: "claimed"; offerId: string }
	| { outcome: "no-match" }
	| { outcome: "expired" }
	| { outcome: "locked" };

export type PairOffers = ReturnType<typeof createPairOffers>;

export function createPairOffers({
	now = Date.now,
	ttlMs = PAIRING_TTL_MS,
	maxOutstanding = 8,
	maxFailures = PAIRING_MAX_ATTEMPTS,
}: PairOffersOptions = {}) {
	const salt = randomBytes(16).toString("base64url");
	const records = new Map<string, OfferRecord>();
	const lastClaimBySession = new Map<string, ClaimMemory>();
	let failures: number[] = [];

	const digest = (code: string) =>
		Buffer.from(hashPairingCode(salt, code), "hex");

	function prune(): void {
		const current = now();
		for (const [offerId, record] of records) {
			if (record.expiresAt <= current) records.delete(offerId);
		}
		for (const [sessionId, memory] of lastClaimBySession) {
			if (memory.expiresAt <= current) lastClaimBySession.delete(sessionId);
		}
	}

	function isPending(record: OfferRecord): boolean {
		return !record.expired && record.bootstrap === undefined;
	}

	function expirePending(origin?: string): void {
		for (const record of records.values()) {
			const inScope = origin === undefined || record.origin === origin;
			if (isPending(record) && inScope) record.expired = true;
		}
	}

	function trimTombstones(): void {
		const tombstones = [...records].filter(([, record]) => record.expired);
		for (const [offerId] of tombstones.slice(
			0,
			Math.max(0, tombstones.length - maxOutstanding),
		)) {
			records.delete(offerId);
		}
	}

	function collides(hash: Buffer): boolean {
		let found = false;
		for (const record of records.values()) {
			if (timingSafeEqual(record.hash, hash)) found = true;
		}
		return found;
	}

	function recentFailures(): number[] {
		const windowStart = now() - ttlMs;
		failures = failures.filter((at) => at > windowStart);
		return failures;
	}

	function recordFailure(): PairClaimOutcome {
		failures.push(now());
		if (recentFailures().length >= maxFailures) expirePending();
		return { outcome: "no-match" };
	}

	return {
		create({ origin }: { origin: string }): PairOffer | { outcome: "full" } {
			prune();
			expirePending(origin);
			trimTombstones();
			const outstanding = [...records.values()].filter(isPending).length;
			if (outstanding >= maxOutstanding) return { outcome: "full" };
			let code = generatePairingCode();
			let hash = digest(code);
			while (collides(hash)) {
				code = generatePairingCode();
				hash = digest(code);
			}
			const offerId = randomUUID();
			const expiresAt = now() + ttlMs;
			records.set(offerId, { hash, origin, expiresAt, expired: false });
			return { offerId, code, expiresAt };
		},

		status({
			offerId,
			origin,
		}: {
			offerId: string;
			origin: string;
		}): PairOfferStatus | undefined {
			const record = records.get(offerId);
			if (record === undefined || record.origin !== origin) return undefined;
			if (record.bootstrap !== undefined) {
				records.delete(offerId);
				return { status: "claimed", bootstrap: record.bootstrap };
			}
			if (record.expired || record.expiresAt <= now()) {
				records.delete(offerId);
				return { status: "expired" };
			}
			return { status: "pending", expiresAt: record.expiresAt };
		},

		claim({
			code,
			bootstrap,
		}: {
			code: string;
			bootstrap: SessionBootstrap;
		}): PairClaimOutcome {
			prune();
			if (recentFailures().length >= maxFailures) return { outcome: "locked" };
			const candidate = digest(code);
			let match: [string, OfferRecord] | undefined;
			for (const entry of records) {
				if (timingSafeEqual(entry[1].hash, candidate)) match = entry;
			}
			if (match === undefined) {
				const held = lastClaimBySession.get(bootstrap.sessionId);
				return held !== undefined && timingSafeEqual(held.hash, candidate)
					? { outcome: "claimed", offerId: held.offerId }
					: recordFailure();
			}
			const [offerId, record] = match;
			if (record.expired) return { outcome: "expired" };
			if (record.bootstrap !== undefined) {
				return record.bootstrap.sessionId === bootstrap.sessionId
					? { outcome: "claimed", offerId }
					: recordFailure();
			}
			record.bootstrap = bootstrap;
			record.expiresAt = now() + ttlMs;
			lastClaimBySession.set(bootstrap.sessionId, {
				hash: candidate,
				offerId,
				expiresAt: now() + ttlMs,
			});
			return { outcome: "claimed", offerId };
		},

		forget(sessionId: string): void {
			lastClaimBySession.delete(sessionId);
		},

		prune,
	};
}
