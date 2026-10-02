import type { AppConfig } from "../config/types";
import { createGmailProviderClient } from "../gmail/client";
import { createOutlookProviderClient } from "../outlook/client";
import { createProtonMailClient } from "../protonmail/client";
import type { MailProvider, MailProviderClient } from "./types";

export function resolveProvider(
	config: AppConfig,
	override = "",
): MailProvider {
	const provider = override || config.provider;
	if (
		provider === "protonmail" ||
		provider === "outlook" ||
		provider === "gmail"
	) {
		return provider;
	}
	throw new Error(`Unsupported provider: ${provider}`);
}

export function createMailProviderClient(
	config: AppConfig,
	override = "",
): MailProviderClient {
	const provider = resolveProvider(config, override);
	if (provider === "gmail") {
		return createGmailProviderClient(config);
	}
	if (provider === "outlook") {
		return createOutlookProviderClient(config);
	}
	return Object.assign(createProtonMailClient(config), {
		provider: "protonmail" as const,
	});
}

export function providerBatchSize(
	config: AppConfig,
	provider: MailProvider,
): number {
	if (provider === "outlook") {
		return config.outlook.batchSize;
	}
	return provider === "gmail"
		? config.gmail.batchSize
		: config.protonmail.batchSize;
}

export function providerSnippetLength(
	config: AppConfig,
	provider: MailProvider,
): number {
	if (provider === "outlook") {
		return config.outlook.snippetLength;
	}
	return provider === "gmail"
		? config.gmail.snippetLength
		: config.protonmail.snippetLength;
}
