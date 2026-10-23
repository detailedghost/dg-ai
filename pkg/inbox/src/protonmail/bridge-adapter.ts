import { connect as connectPlainSocket, type Socket } from "node:net";
import { connect as connectTlsSocket, type PeerCertificate, type TLSSocket } from "node:tls";
import {
	ImapFlow,
	type ImapTransport,
	type ImapTransportConnectOptions,
	type ImapTransportSocket,
} from "imapflow";

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

/**
 * A `secure:false` TLS option on `ImapFlow`/nodemailer only wires up Node's default
 * `checkServerIdentity`, and Node never calls that hook once chain validation has already
 * failed — which it always does for Bridge's self-signed certificate. `rejectUnauthorized:
 * false` is what lets the handshake proceed despite that, and nothing then re-checks the
 * cert; `checkServerIdentity` genuinely never runs. A fingerprint can only be enforced by
 * taking over the TLS upgrade ourselves, which ImapFlow's `transport` option allows and
 * nodemailer's SMTP transport does not (see `createBridgeSmtpSender`'s doc comment).
 *
 * This transport opens the cleartext socket, lets ImapFlow drive STARTTLS, then performs the
 * TLS handshake itself: `getPeerCertificate()` is read the moment the handshake completes,
 * before `onSecure()` is called, so a mismatch destroys the socket without ever calling it —
 * ImapFlow's LOGIN never goes out. No fingerprint configured skips the check and pins on
 * loopback alone, as today.
 */
export function createPinnedImapTransport(
	host: string,
	certFingerprint: string | undefined,
): ImapTransport {
	requireLoopbackHost(host);
	return {
		connect(connectOptions: ImapTransportConnectOptions, onConnect: () => void): ImapTransportSocket {
			return connectPlainSocket({ host: connectOptions.host, port: connectOptions.port }, onConnect);
		},
		upgrade(
			socket: ImapTransportSocket,
			upgradeOptions,
			onSecure: () => void,
		): ImapTransportSocket {
			const tlsSocket = connectTlsSocket({
				socket,
				servername: upgradeOptions.servername,
				rejectUnauthorized: false,
			});
			tlsSocket.once("secureConnect", () => {
				if (certFingerprint) {
					const mismatch = verifyFingerprint(tlsSocket.getPeerCertificate(), certFingerprint);
					if (mismatch) {
						tlsSocket.destroy(mismatch);
						return;
					}
				}
				onSecure();
			});
			return tlsSocket;
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
	if ((error as { authenticationFailed?: boolean } | undefined)?.authenticationFailed) {
		return new Error(
			`Proton Bridge rejected the login; update the credential ${options.credentialName}`,
		);
	}
	const message = error instanceof Error ? error.message : String(error);
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
	requireLoopbackHost(options.host);
	const client = new ImapFlow({
		host: options.host,
		port: options.imapPort,
		secure: false,
		logger: false,
		auth: { user: options.username, pass: options.password },
		transport: createPinnedImapTransport(options.host, options.certFingerprint),
	});
	try {
		await client.connect();
	} catch (error) {
		throw connectionErrorFor(options, options.imapPort, error);
	}
	return new RealBridgeImapSession(client);
}

const SMTP_CLIENT_HOSTNAME = "localhost";
const SMTP_SOCKET_TIMEOUT_MS = 30_000;

type SmtpReply = { code: number; message: string };

/**
 * One command/response exchange at a time, matching the protocol: a reply is matched to
 * whichever `readReply()` call is waiting (queued if none is), so swapping the plaintext
 * socket for the upgraded TLS socket after STARTTLS just means building a second channel.
 */
function createSmtpChannel(socket: Socket): {
	readReply(): Promise<SmtpReply>;
	writeLine(line: string): void;
} {
	let buffer = "";
	const pendingReplies: SmtpReply[] = [];
	const pendingReaders: { resolve: (reply: SmtpReply) => void; reject: (error: Error) => void }[] = [];

	const deliver = (reply: SmtpReply) => {
		const reader = pendingReaders.shift();
		if (reader) reader.resolve(reply);
		else pendingReplies.push(reply);
	};
	const fail = (error: Error) => {
		const reader = pendingReaders.shift();
		if (reader) reader.reject(error);
	};

	socket.setTimeout(SMTP_SOCKET_TIMEOUT_MS, () => socket.destroy(new Error("Proton Bridge SMTP timed out")));
	socket.on("data", (chunk: Buffer) => {
		buffer += chunk.toString("binary");
		let newlineIndex: number;
		while ((newlineIndex = buffer.indexOf("\n")) >= 0) {
			const line = buffer.slice(0, newlineIndex).replace(/\r$/, "");
			buffer = buffer.slice(newlineIndex + 1);
			const match = /^(\d{3})([ -])(.*)$/.exec(line);
			if (match && match[2] === " ") deliver({ code: Number(match[1]), message: match[3] });
		}
	});
	socket.on("error", fail);
	socket.on("close", () => fail(new Error("Proton Bridge SMTP closed the connection")));

	return {
		readReply(): Promise<SmtpReply> {
			const buffered = pendingReplies.shift();
			if (buffered) return Promise.resolve(buffered);
			return new Promise((resolve, reject) => pendingReaders.push({ resolve, reject }));
		},
		writeLine(line: string): void {
			socket.write(`${line}\r\n`, "binary");
		},
	};
}

async function expectReply(
	channel: ReturnType<typeof createSmtpChannel>,
	okCode: number,
	onFailure?: (reply: SmtpReply) => Error,
): Promise<SmtpReply> {
	const reply = await channel.readReply();
	if (reply.code !== okCode) {
		throw onFailure
			? onFailure(reply)
			: new Error(`Proton Bridge SMTP replied ${reply.code} ${reply.message}`);
	}
	return reply;
}

function connectPlain(host: string, port: number): Promise<Socket> {
	return new Promise((resolve, reject) => {
		const socket = connectPlainSocket({ host, port });
		socket.once("connect", () => resolve(socket));
		socket.once("error", reject);
	});
}

/**
 * Checks the pin the instant the handshake completes, before any post-STARTTLS command can go
 * out. No `servername` (SNI): the host is always a loopback literal (`requireLoopbackHost`), SNI
 * does not accept an IP address, and identity is never checked by hostname here anyway — the
 * fingerprint (or, with none configured, `rejectUnauthorized: false` alone) is the whole trust
 * decision.
 */
function upgradeToPinnedTls(
	socket: Socket,
	options: Pick<BridgeConnectionOptions, "certFingerprint">,
): Promise<TLSSocket> {
	return new Promise((resolve, reject) => {
		const tlsSocket = connectTlsSocket({ socket, rejectUnauthorized: false });
		tlsSocket.once("secureConnect", () => {
			if (options.certFingerprint) {
				const mismatch = verifyFingerprint(tlsSocket.getPeerCertificate(), options.certFingerprint);
				if (mismatch) {
					tlsSocket.destroy(mismatch);
					return;
				}
			}
			resolve(tlsSocket);
		});
		tlsSocket.once("error", reject);
	});
}

function frameDataSection(mime: Buffer): Buffer {
	const lines = mime.toString("binary").replace(/\r\n|\r|\n/g, "\r\n").split("\r\n");
	if (lines[lines.length - 1] === "") lines.pop();
	const stuffed = lines.map((line) => (line.startsWith(".") ? `.${line}` : line));
	return Buffer.from(`${stuffed.join("\r\n")}\r\n.\r\n`, "binary");
}

async function sendOverPinnedStartTls(
	options: BridgeConnectionOptions,
	mime: Buffer,
	envelope: { from: string; to: string[] },
): Promise<void> {
	const plainSocket = await connectPlain(options.host, options.smtpPort);
	const plainChannel = createSmtpChannel(plainSocket);
	await expectReply(plainChannel, 220);
	plainChannel.writeLine(`EHLO ${SMTP_CLIENT_HOSTNAME}`);
	await expectReply(plainChannel, 250);
	plainChannel.writeLine("STARTTLS");
	await expectReply(plainChannel, 220);

	const tlsSocket = await upgradeToPinnedTls(plainSocket, options);
	const secureChannel = createSmtpChannel(tlsSocket);
	secureChannel.writeLine(`EHLO ${SMTP_CLIENT_HOSTNAME}`);
	await expectReply(secureChannel, 250);

	const authToken = Buffer.from(`\0${options.username}\0${options.password}`).toString("base64");
	secureChannel.writeLine(`AUTH PLAIN ${authToken}`);
	await expectReply(secureChannel, 235, (reply) =>
		Object.assign(new Error(`Proton Bridge SMTP auth failed: ${reply.code} ${reply.message}`), {
			authenticationFailed: true,
		}),
	);

	secureChannel.writeLine(`MAIL FROM:<${envelope.from}>`);
	await expectReply(secureChannel, 250);
	for (const recipient of envelope.to) {
		secureChannel.writeLine(`RCPT TO:<${recipient}>`);
		await expectReply(secureChannel, 250);
	}
	secureChannel.writeLine("DATA");
	await expectReply(secureChannel, 354);
	tlsSocket.write(frameDataSection(mime), "binary");
	await expectReply(secureChannel, 250);
	secureChannel.writeLine("QUIT");
	tlsSocket.end();
}

/**
 * nodemailer's SMTP transport has no equivalent to ImapFlow's pluggable `transport.upgrade`:
 * a pre-connected `options.connection` socket still makes nodemailer wait for a fresh 220
 * greeting line once secured, which a STARTTLS upgrade never sends (RFC 3207; only an
 * implicit-TLS connect on a dedicated port does). Pinning the STARTTLS handshake itself
 * therefore needs the same plaintext-socket-then-`tls.connect` takeover
 * `createPinnedImapTransport` uses, driving the minimal EHLO/STARTTLS/AUTH PLAIN/MAIL/RCPT/DATA
 * exchange by hand. `verifyFingerprint` runs the instant the handshake completes, before the
 * post-STARTTLS `EHLO` (let alone `AUTH`) goes out, so a mismatch fails closed with no
 * credential ever sent. No fingerprint configured keeps today's loopback-only trust.
 */
export async function createBridgeSmtpSender(
	options: BridgeConnectionOptions,
): Promise<BridgeSmtpSender> {
	requireLoopbackHost(options.host);
	return {
		async send(mime: Buffer, envelope: { from: string; to: string[] }): Promise<void> {
			try {
				await sendOverPinnedStartTls(options, mime, envelope);
			} catch (error) {
				throw connectionErrorFor(options, options.smtpPort, error);
			}
		},
		async close(): Promise<void> {},
	};
}
