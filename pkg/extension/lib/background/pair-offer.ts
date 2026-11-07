import {
	CHAT_PAIR_OFFER_PATH,
	type PairOffer,
	type PairOfferStatus,
	type SessionBootstrap,
	describeError,
	emitRedacted,
	validatePairOffer,
	validatePairOfferStatus,
} from "@dg/common";
import { MSG, type PairOfferState } from "@dg/pages/chat-messages";
import { findDaemonPort } from "@dg/pages/daemon-port";
import { browser } from "wxt/browser";
import { isPopupSender } from "./popup-sender";

const DEFAULT_POLL_INTERVAL_MS = 1500;
const POLL_FAILURE_GRACE_MS = 30_000;
const OFFER_KEY = "pairOffer";
const ADOPT_FAILED = "Pairing could not finish. Try again.";

type StoredOffer = { offerId: string; expiresAt: number };

type OfferRuntime = {
	onMessage: {
		addListener(
			listener: (
				message: unknown,
				sender: unknown,
				sendResponse: (response: unknown) => void,
			) => boolean | undefined,
		): void;
	};
	getURL(path: string): string;
};

type OfferStorage = {
	session: {
		get(key: string): Promise<Record<string, unknown>>;
		set(items: Record<string, unknown>): Promise<void>;
		remove(key: string): Promise<void>;
	};
};

export type RegisterPairOfferOptions = {
	runtime?: OfferRuntime;
	storage?: OfferStorage;
	fetch?: typeof fetch;
	findPort?: () => Promise<number | undefined>;
	adopt: (bootstrap: SessionBootstrap) => Promise<void>;
	pollIntervalMs?: number;
};

function asStoredOffer(value: unknown): StoredOffer | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const { offerId, expiresAt } = value as Partial<StoredOffer>;
	return typeof offerId === "string" &&
		offerId.length > 0 &&
		typeof expiresAt === "number"
		? { offerId, expiresAt }
		: undefined;
}

function isOfferRequest(
	message: unknown,
): message is { type: string; renew?: unknown } {
	return (
		typeof message === "object" &&
		message !== null &&
		(message as { type?: unknown }).type === MSG.pairOfferRequest
	);
}

/** Owns pair offer creation and polling so a claim lands while the popup is closed. */
export function registerPairOffer({
	runtime = browser.runtime as unknown as OfferRuntime,
	storage = browser.storage as unknown as OfferStorage,
	fetch: fetchFn = globalThis.fetch.bind(globalThis),
	findPort = () => findDaemonPort(),
	adopt,
	pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
}: RegisterPairOfferOptions): void {
	let live: PairOffer | undefined;
	let settled: PairOfferState | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let queue: Promise<unknown> = Promise.resolve();

	function serialize<T>(task: () => Promise<T>): Promise<T> {
		const next = queue.then(task);
		queue = next.catch(() => undefined);
		return next;
	}

	const offerUrl = (port: number, offerId?: string) =>
		`http://127.0.0.1:${port}${CHAT_PAIR_OFFER_PATH}${offerId === undefined ? "" : `/${encodeURIComponent(offerId)}`}`;

	function stopPolling(): void {
		if (timer !== undefined) clearTimeout(timer);
		timer = undefined;
	}

	async function readStored(): Promise<StoredOffer | undefined> {
		return asStoredOffer((await storage.session.get(OFFER_KEY))[OFFER_KEY]);
	}

	async function readStatus(
		port: number,
		offerId: string,
	): Promise<PairOfferStatus | undefined> {
		const response = await fetchFn(offerUrl(port, offerId));
		if (response.status === 404) return undefined;
		if (!response.ok) {
			throw new Error(
				`pair offer status request failed with HTTP ${response.status}`,
			);
		}
		try {
			return validatePairOfferStatus(await response.json());
		} catch {
			return undefined;
		}
	}

	async function adoptClaimed(
		bootstrap: SessionBootstrap,
	): Promise<PairOfferState> {
		try {
			await adopt(bootstrap);
		} catch (error) {
			emitRedacted(
				(line) => console.warn(line),
				`[dg-chat] adopting the claimed pairing failed: ${describeError(error)}`,
				[bootstrap.token],
			);
			return { status: "error", error: ADOPT_FAILED };
		}
		return { status: "claimed", agentIdentity: bootstrap.agentIdentity };
	}

	async function settle(
		offer: PairOffer,
		outcome: () => Promise<PairOfferState>,
	): Promise<void> {
		if (live !== offer) return;
		live = undefined;
		stopPolling();
		await storage.session.remove(OFFER_KEY);
		settled = await outcome();
	}

	async function poll(port: number, offer: PairOffer): Promise<void> {
		if (live !== offer) return;
		const status = await readStatus(port, offer.offerId);
		if (status?.status === "pending") {
			offer.expiresAt = status.expiresAt;
			return;
		}
		await serialize(() =>
			settle(offer, () =>
				status?.status === "claimed"
					? adoptClaimed(status.bootstrap)
					: Promise.resolve({ status: "expired" }),
			),
		);
	}

	function schedulePoll(port: number, offer: PairOffer): void {
		timer = setTimeout(() => {
			void poll(port, offer)
				.catch((error: unknown) => failPoll(error, offer))
				.finally(() => {
					if (live === offer) schedulePoll(port, offer);
				});
		}, pollIntervalMs);
	}

	async function createOffer(port: number): Promise<PairOfferState> {
		const response = await fetchFn(offerUrl(port), { method: "POST" });
		if (response.status !== 201) return failOffer(await response.text());
		const offer = { ...validatePairOffer(await response.json()) };
		stopPolling();
		live = offer;
		settled = undefined;
		await storage.session.set({
			[OFFER_KEY]: { offerId: offer.offerId, expiresAt: offer.expiresAt },
		});
		schedulePoll(port, offer);
		return { status: "pending", code: offer.code, expiresAt: offer.expiresAt };
	}

	async function forgetOffer(): Promise<void> {
		live = undefined;
		stopPolling();
		await storage.session.remove(OFFER_KEY);
	}

	async function failOffer(error: string): Promise<PairOfferState> {
		await forgetOffer();
		settled = { status: "error", error };
		return settled;
	}

	async function answer(renew: boolean): Promise<PairOfferState> {
		if (!renew && settled?.status === "expired") settled = undefined;
		if (!renew && settled) {
			const reply = settled;
			if (reply.status === "claimed") settled = undefined;
			return reply;
		}
		const port = await findPort();
		if (port === undefined) return { status: "daemon-down" };
		if (renew) return createOffer(port);
		if (live) {
			return {
				status: "pending",
				code: live.code,
				expiresAt: live.expiresAt,
			};
		}
		const stored = await readStored();
		if (stored) {
			const status = await readStatus(port, stored.offerId).catch(
				() => undefined,
			);
			if (status?.status === "claimed") {
				await storage.session.remove(OFFER_KEY);
				const outcome = await adoptClaimed(status.bootstrap);
				if (outcome.status === "error") settled = outcome;
				return outcome;
			}
		}
		return createOffer(port);
	}

	async function failPoll(error: unknown, offer: PairOffer): Promise<void> {
		console.warn(`[dg-chat] pair offer poll failed: ${describeError(error)}`);
		if (Date.now() <= offer.expiresAt + POLL_FAILURE_GRACE_MS) return;
		await serialize(() =>
			settle(offer, () => Promise.resolve({ status: "expired" })),
		);
	}

	runtime.onMessage.addListener((message, sender, sendResponse) => {
		if (!isOfferRequest(message)) return undefined;
		if (!isPopupSender(sender, runtime.getURL(""))) return undefined;
		void serialize(() => answer(message.renew === true)).then(
			sendResponse,
			(error: unknown) =>
				sendResponse({
					status: "error",
					error: describeError(error),
				} satisfies PairOfferState),
		);
		return true;
	});
}
