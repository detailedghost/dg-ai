import type { PeerCertificate } from "node:tls";
import { ImapFlow } from "imapflow";
import nodemailer from "nodemailer";

export type BridgeMailboxInfo = {
	path: string;
	uidValidity: string;
	uidNext: number;
};

export type BridgeMailboxSummary = {
	path: string;
	specialUse?: string;
};

export type BridgeSearchCriteria = {
	unread?: boolean;
	since?: Date;
	from?: string;
	subject?: string;
	text?: string;
};

export type BridgeMessageSummary = {
	uid: number;
	from: string;
	subject: string;
	receivedAt: string;
	isRead: boolean;
	hasAttachments: boolean;
};

export type BridgeSource = {
	source: Buffer;
	isRead: boolean;
};

export type BridgeHeaderFetch = {
	from: string;
	to: string[];
	cc: string[];
	subject: string;
	messageId?: string;
	references?: string;
};

export type BridgeStructurePart = {
	part?: string;
	type: string;
	disposition?: string;
	dispositionParameters?: { filename?: string };
	parameters?: { name?: string };
	size?: number;
	childNodes?: BridgeStructurePart[];
};

export type BridgeAppendResult = {
	uid?: number;
	uidValidity?: string;
};

/**
 * One mailbox's IMAP surface for the Bridge client, over a connected session. `search` returns
 * ready-to-summarize messages (not bare UIDs) because listing is the only caller and this keeps
 * the SEARCH-then-FETCH round trip inside one adapter call instead of two client calls.
 */
export interface BridgeImapSession {
	listMailboxes(): Promise<BridgeMailboxSummary[]>;
	select(path: string, options?: { readOnly?: boolean }): Promise<BridgeMailboxInfo>;
	search(path: string, criteria: BridgeSearchCriteria): Promise<BridgeMessageSummary[]>;
	fetchHeaders(path: string, uid: number): Promise<BridgeHeaderFetch>;
	fetchSource(path: string, uid: number): Promise<BridgeSource>;
	fetchStructure(path: string, uid: number): Promise<BridgeStructurePart>;
	append(path: string, content: Buffer, flags: string[]): Promise<BridgeAppendResult>;
	deleteByUid(path: string, uid: number): Promise<void>;
	close(): Promise<void>;
}

export interface BridgeSmtpSender {
	send(mime: Buffer, envelope: { from: string; to: string[] }): Promise<void>;
	close(): Promise<void>;
}

export type BridgeConnectionOptions = {
	host: string;
	imapPort: number;
	smtpPort: number;
	username: string;
	password: string;
	certFingerprint?: string;
	/** `inbox/protonmail-bridge/<slug>`, named in the login-rejected error so the human knows which to update. */
	credentialName: string;
};

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

export function requireLoopbackHost(host: string): void {
	if (!LOOPBACK_HOSTS.has(host)) {
		throw new Error("Proton Bridge host must be loopback");
	}
}

/** Pure so the plan's fingerprint-mismatch test can call it directly with a fake certificate. */
export function verifyFingerprint(
	cert: Pick<PeerCertificate, "fingerprint256">,
	expectedFingerprint: string,
): Error | undefined {
	const actual = (cert.fingerprint256 ?? "").replace(/:/g, "").toLowerCase();
	if (actual !== expectedFingerprint.toLowerCase()) {
		return new Error("Proton Bridge certificate fingerprint does not match the profile");
	}
	return undefined;
}

export function tlsOptionsFor(host: string, certFingerprint: string | undefined) {
	requireLoopbackHost(host);
	return {
		rejectUnauthorized: false,
		checkServerIdentity(_hostname: string, cert: PeerCertificate): Error | undefined {
			return certFingerprint ? verifyFingerprint(cert, certFingerprint) : undefined;
		},
	};
}

export function connectionErrorFor(options: BridgeConnectionOptions, port: number, error: unknown): Error {
	const code = (error as { code?: string } | undefined)?.code;
	if (code === "ECONNREFUSED" || code === "ECONNRESET") {
		return new Error(
			`Proton Bridge is not reachable on ${options.host}:${port}; start Proton Bridge and check the profile`,
		);
	}
	const message = error instanceof Error ? error.message : String(error);
	if (/\bNO\b/.test(message) && /login|auth/i.test(message)) {
		return new Error(
			`Proton Bridge rejected the login; update the credential ${options.credentialName}`,
		);
	}
	return error instanceof Error ? error : new Error(message);
}

/** Leaf MIME parts that are not the plain-text or HTML body; walks multipart nodes recursively. */
export function structureAttachmentParts(structure: BridgeStructurePart): BridgeStructurePart[] {
	const leaves: BridgeStructurePart[] = [];
	const walk = (node: BridgeStructurePart): void => {
		if (node.childNodes && node.childNodes.length > 0) {
			for (const child of node.childNodes) walk(child);
			return;
		}
		const isTextBody = node.type === "text/plain" || node.type === "text/html";
		if (!isTextBody) leaves.push(node);
	};
	walk(structure);
	return leaves;
}

function hasAttachmentParts(structure: BridgeStructurePart): boolean {
	return structureAttachmentParts(structure).length > 0;
}

function formatEnvelopeAddress(address: { name?: string; address?: string } | undefined): string {
	if (!address || !address.address) return "";
	return address.name ? `${address.name} <${address.address}>` : address.address;
}

class RealBridgeImapSession implements BridgeImapSession {
	constructor(private readonly client: ImapFlow) {}

	async listMailboxes(): Promise<BridgeMailboxSummary[]> {
		const entries = await this.client.list();
		return entries.map((entry) => ({ path: entry.path, specialUse: entry.specialUse }));
	}

	async select(path: string, options?: { readOnly?: boolean }): Promise<BridgeMailboxInfo> {
		const mailbox = await this.client.mailboxOpen(path, {
			readOnly: options?.readOnly ?? true,
		});
		return {
			path: mailbox.path,
			uidValidity: mailbox.uidValidity.toString(),
			uidNext: mailbox.uidNext,
		};
	}

	async search(path: string, criteria: BridgeSearchCriteria): Promise<BridgeMessageSummary[]> {
		await this.select(path, { readOnly: true });
		const query: Record<string, unknown> = {};
		if (criteria.unread) query.seen = false;
		if (criteria.since) query.since = criteria.since;
		if (criteria.from) query.from = criteria.from;
		if (criteria.subject) query.subject = criteria.subject;
		if (criteria.text) query.text = criteria.text;
		if (Object.keys(query).length === 0) query.all = true;
		const uids = await this.client.search(query, { uid: true });
		if (!uids || uids.length === 0) return [];
		const messages = await this.client.fetchAll(
			uids,
			{ envelope: true, flags: true, bodyStructure: true },
			{ uid: true },
		);
		return messages.map((message) => ({
			uid: message.uid,
			from: formatEnvelopeAddress(message.envelope?.from?.[0]),
			subject: message.envelope?.subject ?? "",
			receivedAt: new Date(message.envelope?.date ?? Date.now()).toISOString(),
			isRead: message.flags?.has("\\Seen") ?? false,
			hasAttachments: message.bodyStructure ? hasAttachmentParts(message.bodyStructure) : false,
		}));
	}

	async fetchHeaders(path: string, uid: number): Promise<BridgeHeaderFetch> {
		await this.select(path, { readOnly: true });
		const message = await this.client.fetchOne(
			String(uid),
			{ envelope: true, headers: ["references"] },
			{ uid: true },
		);
		if (!message) throw new Error("Proton Bridge message was not found");
		const text = message.headers?.toString("utf8") ?? "";
		const match = /^references:\s*([\s\S]*?)(?:\r?\n(?!\s)|$)/im.exec(text);
		const references = match?.[1]?.replace(/\r?\n\s+/g, " ").trim();
		return {
			from: formatEnvelopeAddress(message.envelope?.from?.[0]),
			to: (message.envelope?.to ?? []).map(formatEnvelopeAddress),
			cc: (message.envelope?.cc ?? []).map(formatEnvelopeAddress),
			subject: message.envelope?.subject ?? "",
			messageId: message.envelope?.messageId,
			references: references || undefined,
		};
	}

	async fetchSource(path: string, uid: number): Promise<BridgeSource> {
		await this.select(path, { readOnly: true });
		const message = await this.client.fetchOne(String(uid), { source: true, flags: true }, { uid: true });
		if (!message || !message.source) throw new Error("Proton Bridge message was not found");
		return { source: message.source, isRead: message.flags?.has("\\Seen") ?? false };
	}

	async fetchStructure(path: string, uid: number): Promise<BridgeStructurePart> {
		await this.select(path, { readOnly: true });
		const message = await this.client.fetchOne(String(uid), { bodyStructure: true }, { uid: true });
		if (!message || !message.bodyStructure) throw new Error("Proton Bridge message was not found");
		return message.bodyStructure;
	}

	async append(path: string, content: Buffer, flags: string[]): Promise<BridgeAppendResult> {
		const result = await this.client.append(path, content, flags);
		if (!result) throw new Error("Proton Bridge did not accept the appended message");
		return {
			uid: result.uid,
			uidValidity: result.uidValidity !== undefined ? result.uidValidity.toString() : undefined,
		};
	}

	async deleteByUid(path: string, uid: number): Promise<void> {
		await this.select(path, { readOnly: false });
		const deleted = await this.client.messageDelete(String(uid), { uid: true });
		if (!deleted) throw new Error("Proton Bridge did not delete the draft");
	}

	async close(): Promise<void> {
		await this.client.logout();
	}
}

export async function createBridgeImapSession(
	options: BridgeConnectionOptions,
): Promise<BridgeImapSession> {
	const client = new ImapFlow({
		host: options.host,
		port: options.imapPort,
		secure: false,
		logger: false,
		auth: { user: options.username, pass: options.password },
		tls: tlsOptionsFor(options.host, options.certFingerprint),
	});
	try {
		await client.connect();
	} catch (error) {
		throw connectionErrorFor(options, options.imapPort, error);
	}
	return new RealBridgeImapSession(client);
}

export async function createBridgeSmtpSender(
	options: BridgeConnectionOptions,
): Promise<BridgeSmtpSender> {
	const transport = nodemailer.createTransport({
		host: options.host,
		port: options.smtpPort,
		secure: false,
		requireTLS: true,
		auth: { user: options.username, pass: options.password },
		tls: tlsOptionsFor(options.host, options.certFingerprint),
	});
	return {
		async send(mime: Buffer, envelope: { from: string; to: string[] }): Promise<void> {
			try {
				await transport.sendMail({ envelope, raw: mime });
			} catch (error) {
				throw connectionErrorFor(options, options.smtpPort, error);
			}
		},
		async close(): Promise<void> {
			transport.close();
		},
	};
}
