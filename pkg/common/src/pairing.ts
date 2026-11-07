import {
	fail,
	requireFiniteNumber,
	requireOneOf,
	requireRecord,
	requireString,
} from "./assert";
import {
	type SessionBootstrap,
	validateSessionBootstrap,
} from "./chat-format";

export const CHAT_PAIR_OFFER_PATH = "/pair/offer";
export const CHAT_PAIR_CLAIM_PATH = "/pair/claim";
export const PAIR_CODE_PATTERN = /^\d{6}$/;

export type PairOffer = {
	offerId: string;
	code: string;
	expiresAt: number;
};

export type PairOfferStatus =
	| { status: "pending"; expiresAt: number }
	| { status: "claimed"; bootstrap: SessionBootstrap }
	| { status: "expired" };

export type PairClaimRequest = {
	code: string;
	sessionId: string;
};

export type PairClaimResponse = {
	ok: true;
	agentIdentity: string;
};

function requirePairCode(
	value: unknown,
	path: string,
): asserts value is string {
	requireString(value, path);
	if (!PAIR_CODE_PATTERN.test(value)) {
		fail(`${path} must be exactly six digits`);
	}
}

export function validatePairOffer(value: unknown): PairOffer {
	requireRecord(value, "pair offer");
	requireString(value.offerId, "pair offer.offerId", { nonEmpty: true });
	requirePairCode(value.code, "pair offer.code");
	requireFiniteNumber(value.expiresAt, "pair offer.expiresAt");
	return {
		offerId: value.offerId,
		code: value.code,
		expiresAt: value.expiresAt,
	};
}

export function validatePairOfferStatus(value: unknown): PairOfferStatus {
	requireRecord(value, "pair offer status");
	requireOneOf(value.status, "pair offer status.status", [
		"pending",
		"claimed",
		"expired",
	]);
	if (value.status === "pending") {
		requireFiniteNumber(value.expiresAt, "pair offer status.expiresAt");
		return { status: "pending", expiresAt: value.expiresAt };
	}
	if (value.status === "claimed") {
		return {
			status: "claimed",
			bootstrap: validateSessionBootstrap(value.bootstrap),
		};
	}
	return { status: "expired" };
}

export function validatePairClaimRequest(value: unknown): PairClaimRequest {
	requireRecord(value, "pair claim request");
	requirePairCode(value.code, "pair claim request.code");
	requireString(value.sessionId, "pair claim request.sessionId", {
		nonEmpty: true,
	});
	return { code: value.code, sessionId: value.sessionId };
}
