import type { SmsCapability, SmsProviderId } from "./types";

export class UnsupportedCapability extends Error {
	readonly code = "unsupported";
	readonly provider: SmsProviderId;
	readonly capability: SmsCapability;

	constructor(provider: SmsProviderId, capability: SmsCapability) {
		super(`${provider} does not support ${capability}`);
		this.name = "UnsupportedCapability";
		this.provider = provider;
		this.capability = capability;
	}
}

export class ConfirmationRequired extends Error {
	readonly code = "confirmation-required";

	constructor() {
		super(
			"send requires an interactive yes on a terminal, or --approve TOKEN for this draft",
		);
		this.name = "ConfirmationRequired";
	}
}

export class HookSendRefused extends Error {
	readonly code = "hook-refused";

	constructor() {
		super("send is refused when invoked from a hook");
		this.name = "HookSendRefused";
	}
}

export class SendDeclined extends Error {
	readonly code = "send-declined";

	constructor() {
		super("send declined");
		this.name = "SendDeclined";
	}
}
