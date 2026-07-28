import {
	type MailboxCanonicalAction,
	validateCanonicalMailboxAction,
} from "@dg/common";
import {
	assertMailboxProviderPageReady,
	createGuardedMailboxExecutionProvider,
	guardedProviderCapture,
} from "./config";
import type {
	MailboxProviderCaptureRequest,
	MailboxProviderDispatchRequest,
	MailboxProvider,
} from "./contracts";

export type MailboxProviderConformanceStorage = Readonly<{
	read(key: string): Promise<unknown>;
	write(key: string, value: unknown): Promise<void>;
}>;

export type MailboxProviderConformanceDownloads = Readonly<{
	save(
		name: string,
		content: string,
	): Promise<Readonly<{ downloadId: string }>>;
}>;

export type MailboxProviderConformanceRestart = Readonly<{
	restart(): Promise<void>;
}>;

export type MailboxProviderConformanceSeams = Readonly<{
	now(): string;
	storage: MailboxProviderConformanceStorage;
	restart: MailboxProviderConformanceRestart;
	downloads: MailboxProviderConformanceDownloads;
}>;

export type MailboxProviderConformanceSubject = Readonly<{
	provider: MailboxProvider;
	captureRequest: MailboxProviderCaptureRequest;
	action: MailboxCanonicalAction;
	rawTargets: Readonly<Record<string, string>>;
}>;

export type MailboxProviderConformanceResult = Readonly<{
	providerId: string;
	locale: string;
	observedAt: string;
	verifiedAt: string;
	inboxCount: number;
	downloadId: string;
}>;

/**
 * Provider-neutral black-box journey. Adapter bundles supply only a provider
 * subject and deterministic platform seams; the assertions stay in core.
 */
export async function runMailboxProviderConformance(
	subject: MailboxProviderConformanceSubject,
	seams: MailboxProviderConformanceSeams,
): Promise<MailboxProviderConformanceResult> {
	const action = validateCanonicalMailboxAction(subject.action);
	const locale = await assertMailboxProviderPageReady(
		subject.provider,
		subject.captureRequest.surface,
	);
	await guardedProviderCapture(
		subject.provider,
		subject.captureRequest,
	);

	const provider = createGuardedMailboxExecutionProvider(subject.provider);
	const request: MailboxProviderDispatchRequest = {
		...subject.captureRequest,
		action,
		rawTargets: subject.rawTargets,
	};
	const preflight = await provider.preflight({
		...subject.captureRequest,
		actions: [action],
		rawTargets: subject.rawTargets,
	});
	if (
		preflight.status !== "ready" ||
		preflight.providerId !== subject.provider.id ||
		preflight.surface !== subject.captureRequest.surface ||
		preflight.accountAlias !== subject.captureRequest.accountAlias ||
		preflight.targets !== "available" ||
		!preflight.capabilities.includes(action.type)
	) {
		throw new Error("Provider conformance preflight failed");
	}
	await seams.storage.write("mailbox-provider-v1:capture", {
		schemaVersion: 1,
		providerId: subject.provider.id,
		locale,
		status: "captured",
	});
	await seams.storage.write("mailbox-provider-v1:accepted", action);
	if (
		(await seams.storage.read("mailbox-provider-v1:accepted")) ===
		undefined
	) {
		throw new Error("Conformance storage did not retain acceptance");
	}
	await seams.restart.restart();
	const dispatched = await provider.dispatch(request);
	if (dispatched.status !== "dispatched") {
		throw new Error("Provider conformance dispatch failed");
	}
	const observed = await provider.observe(request);
	if (observed.status !== "observed") {
		throw new Error("Provider conformance observation failed");
	}
	const verified = await provider.verifyFresh(request);
	if (
		verified.status !== "verified" ||
		verified.delta.actionAlias !== action.actionAlias
	) {
		throw new Error("Provider conformance verification failed");
	}
	const inbox = await provider.observeInbox(subject.captureRequest);
	if (inbox.status !== "observed") {
		throw new Error("Provider conformance inbox observation failed");
	}
	const report = Object.freeze({
		schemaVersion: 1 as const,
		providerId: subject.provider.id,
		generatedAt: seams.now(),
		observedAt: observed.observedAt,
		verifiedAt: verified.verifiedAt,
		inboxCount: inbox.count,
	});
	await seams.storage.write("mailbox-provider-v1:debrief", report);
	const download = await seams.downloads.save(
		"mailbox-provider-v1-debrief.json",
		JSON.stringify(report),
	);
	return Object.freeze({
		providerId: subject.provider.id,
		locale,
		observedAt: observed.observedAt,
		verifiedAt: verified.verifiedAt,
		inboxCount: inbox.count,
		downloadId: download.downloadId,
	});
}
