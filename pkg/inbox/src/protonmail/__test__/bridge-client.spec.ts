import { describe, expect, test } from "bun:test";
import type { InboxProfile } from "@dg/common";
import { defaultConfig } from "../../config/defaults";
import type { AppConfig } from "../../config/types";
import { hashId } from "../../privacy/hash";
import { bindInboxRuntime, type InboxRuntime } from "../../runtime";
import {
	connectionErrorFor,
	tlsOptionsFor,
	verifyFingerprint,
	type BridgeAppendResult,
	type BridgeConnectionOptions,
	type BridgeHeaderFetch,
	type BridgeImapSession,
	type BridgeMailboxInfo,
	type BridgeMailboxSummary,
	type BridgeMessageSummary,
	type BridgeSearchCriteria,
	type BridgeSmtpSender,
	type BridgeSource,
	type BridgeStructurePart,
} from "../bridge-adapter";
import {
	createProtonBridgeMailAccessClientWithFactories,
	type BridgeSessionFactories,
} from "../bridge-client";

const MAILBOXES: Record<string, { uidValidity: string; uidNext: number }> = {
	INBOX: { uidValidity: "1001", uidNext: 50 },
	Drafts: { uidValidity: "2002", uidNext: 10 },
	"Folders/Receipts": { uidValidity: "3003", uidNext: 5 },
	"Labels/Newsletters": { uidValidity: "4004", uidNext: 5 },
};

const PASSWORD = "fixture-bridge-password-9f21";

class FakeSession implements BridgeImapSession {
	selectCalls: { path: string; readOnly: boolean | undefined }[] = [];
	searchCalls: { path: string; criteria: BridgeSearchCriteria }[] = [];
	structureFetches: number[] = [];
	sourceFetches: number[] = [];
	appendCalls: { path: string; content: Buffer; flags: string[] }[] = [];
	deleteCalls: { path: string; uid: number }[] = [];
	closed = false;

	summaries: BridgeMessageSummary[] = [];
	headerFixture: BridgeHeaderFetch = { from: "", to: [], cc: [], subject: "" };
	sourceFixture = new Map<number, BridgeSource>();
	structureFixture: BridgeStructurePart = { type: "text/plain" };
	appendResult: BridgeAppendResult = { uid: 11, uidValidity: "2002" };
	mailboxes: BridgeMailboxSummary[] = [
		{ path: "Folders/Receipts" },
		{ path: "Labels/Newsletters" },
	];

	async listMailboxes(): Promise<BridgeMailboxSummary[]> {
		return this.mailboxes;
	}

	async select(path: string, options?: { readOnly?: boolean }): Promise<BridgeMailboxInfo> {
		this.selectCalls.push({ path, readOnly: options?.readOnly });
		const info = MAILBOXES[path];
		if (!info) throw new Error(`fake session has no mailbox ${path}`);
		return { path, uidValidity: info.uidValidity, uidNext: info.uidNext };
	}

	async search(path: string, criteria: BridgeSearchCriteria): Promise<BridgeMessageSummary[]> {
		this.searchCalls.push({ path, criteria });
		return this.summaries;
	}

	async fetchHeaders(_path: string, _uid: number): Promise<BridgeHeaderFetch> {
		return this.headerFixture;
	}

	async fetchSource(_path: string, uid: number): Promise<BridgeSource> {
		this.sourceFetches.push(uid);
		const fixture = this.sourceFixture.get(uid);
		if (!fixture) throw new Error(`fake session has no source for uid ${uid}`);
		return fixture;
	}

	async fetchStructure(_path: string, uid: number): Promise<BridgeStructurePart> {
		this.structureFetches.push(uid);
		return this.structureFixture;
	}

	async append(path: string, content: Buffer, flags: string[]): Promise<BridgeAppendResult> {
		this.appendCalls.push({ path, content, flags });
		return this.appendResult;
	}

	async deleteByUid(path: string, uid: number): Promise<void> {
		this.deleteCalls.push({ path, uid });
	}

	async close(): Promise<void> {
		this.closed = true;
	}
}

class FakeSmtp implements BridgeSmtpSender {
	sent: { mime: Buffer; envelope: { from: string; to: string[] } }[] = [];
	closed = false;
	failNextSend = false;

	async send(mime: Buffer, envelope: { from: string; to: string[] }): Promise<void> {
		if (this.failNextSend) throw new Error("fake smtp connection dropped");
		this.sent.push({ mime, envelope });
	}

	async close(): Promise<void> {
		this.closed = true;
	}
}

function fixtureProfile(overrides: Partial<NonNullable<InboxProfile["protonmail"]>> = {}): InboxProfile {
	return {
		provider: "protonmail",
		protonmail: {
			bridgeUsername: "me@example.test",
			bridgeHost: "127.0.0.1",
			bridgeImapPort: 1143,
			bridgeSmtpPort: 1025,
			...overrides,
		},
	};
}

function buildClient(options: {
	profile?: InboxProfile | null;
	session?: FakeSession;
	smtp?: FakeSmtp;
	credential?: string | null;
}): {
	client: ReturnType<typeof createProtonBridgeMailAccessClientWithFactories>;
	session: FakeSession;
	smtp: FakeSmtp;
} {
	const session = options.session ?? new FakeSession();
	const smtp = options.smtp ?? new FakeSmtp();
	const config: AppConfig = { ...defaultConfig, provider: "protonmail" };
	const profile = options.profile === undefined ? fixtureProfile() : options.profile;
	const credential = options.credential === undefined ? PASSWORD : options.credential;
	const runtime: InboxRuntime = {
		profileGet: async () => profile,
		credentialGet: async () => credential,
	};
	bindInboxRuntime(config, runtime, "work");
	const factories: BridgeSessionFactories = {
		createSession: async () => session,
		createSmtp: async () => smtp,
	};
	const client = createProtonBridgeMailAccessClientWithFactories(config, runtime, factories);
	return { client, session, smtp };
}

describe("BridgeMailAccessClient.listMessages", () => {
	test("issues the expected criteria on INBOX and returns m_hash_ ids after hashing", async () => {
		const { client, session } = buildClient({});
		session.summaries = [
			{
				uid: 42,
				from: "Alice <alice@example.test>",
				subject: "Invoice",
				receivedAt: "2026-10-05T00:00:00.000Z",
				isRead: false,
				hasAttachments: false,
			},
		];
		const page = await client.listMessages({
			folderId: "inbox",
			unread: true,
			since: "2026-10-01T00:00:00.000Z",
			from: "example.test",
			limit: 20,
			page: 0,
		});
		expect(session.searchCalls).toHaveLength(1);
		expect(session.searchCalls[0]?.path).toBe("INBOX");
		expect(session.searchCalls[0]?.criteria.unread).toBe(true);
		expect(session.searchCalls[0]?.criteria.since).toEqual(new Date("2026-10-01T00:00:00.000Z"));
		expect(session.searchCalls[0]?.criteria.from).toBe("example.test");
		expect(page.messages).toHaveLength(1);
		expect(page.messages[0]?.id).toBe("INBOX:1001:42");
		expect(hashId(page.messages[0]?.id ?? "")).toMatch(/^m_hash_[0-9a-f]{12}$/);
	});

	test("page 2 with limit 20 on 45 summaries returns 5 messages and hasMore false", async () => {
		const { client, session } = buildClient({});
		session.summaries = Array.from({ length: 45 }, (_, index) => ({
			uid: index + 1,
			from: "sender@example.test",
			subject: `Message ${index + 1}`,
			receivedAt: new Date(2026, 9, index + 1).toISOString(),
			isRead: true,
			hasAttachments: false,
		}));
		const page = await client.listMessages({ folderId: "inbox", limit: 20, page: 2 });
		expect(page.messages).toHaveLength(5);
		expect(page.hasMore).toBe(false);
	});

	test("--folder Receipts resolves Folders/Receipts", async () => {
		const { client, session } = buildClient({});
		await client.listMessages({ folderId: "Receipts", limit: 20, page: 0 });
		expect(session.selectCalls[0]?.path).toBe("Folders/Receipts");
	});

	test("--folder Newsletters resolves Labels/Newsletters when no matching folder exists", async () => {
		const { client, session } = buildClient({});
		session.mailboxes = [{ path: "Labels/Newsletters" }];
		await client.listMessages({ folderId: "Newsletters", limit: 20, page: 0 });
		expect(session.selectCalls[0]?.path).toBe("Labels/Newsletters");
	});
});

describe("BridgeMailAccessClient.getMessage", () => {
	test("fetches read-only and the fake session records no \\Seen flag change", async () => {
		const { client, session } = buildClient({});
		session.sourceFixture.set(42, {
			source: Buffer.from(
				"From: alice@example.test\r\nTo: me@example.test\r\nSubject: Hi\r\n\r\nBody.\r\n",
			),
			isRead: false,
		});
		const message = await client.getMessage("INBOX:1001:42");
		expect(session.selectCalls[0]?.readOnly).toBe(true);
		expect(message.isRead).toBe(false);
		expect(message.text.trim()).toBe("Body.");
	});

	test("a UID whose mailbox uidValidity changed fails with the unknown-id sentence", async () => {
		const { client } = buildClient({});
		await expect(client.getMessage("INBOX:9999:42")).rejects.toThrow(
			"unknown message id; run mail list or mail search first",
		);
	});
});

describe("BridgeMailAccessClient.listAttachments", () => {
	test("returns attachment fields and never fetches beyond BODYSTRUCTURE", async () => {
		const { client, session } = buildClient({});
		session.structureFixture = {
			type: "multipart/mixed",
			childNodes: [
				{ type: "text/plain" },
				{
					type: "application/pdf",
					disposition: "attachment",
					dispositionParameters: { filename: "doc1.pdf" },
					size: 1024,
				},
			],
		};
		const attachments = await client.listAttachments("INBOX:1001:42");
		expect(attachments).toEqual([
			{ id: "part-0", name: "doc1.pdf", contentType: "application/pdf", size: 1024, isInline: false },
		]);
		expect(session.structureFetches).toEqual([42]);
		expect(session.sourceFetches).toEqual([]);
	});
});

describe("BridgeMailAccessClient.createDraft", () => {
	test("appends to Drafts with \\Draft and the required headers", async () => {
		const { client, session } = buildClient({});
		const draft = await client.createDraft({
			to: ["dest@example.test"],
			cc: [],
			subject: "Draft subject",
			text: "Draft body.",
		});
		expect(session.appendCalls).toHaveLength(1);
		expect(session.appendCalls[0]?.path).toBe("Drafts");
		expect(session.appendCalls[0]?.flags).toEqual(["\\Draft"]);
		const text = session.appendCalls[0]?.content.toString("utf8") ?? "";
		for (const header of ["From:", "To:", "Subject:", "Message-ID:", "Date:", "MIME-Version:"]) {
			expect(text).toContain(header);
		}
		expect(text).toContain("Content-Type: text/plain; charset=utf-8");
		expect(draft.folderId).toBe("drafts");
		expect(draft.id).toBe("Drafts:2002:11");
	});
});

describe("BridgeMailAccessClient.createReplyDraft", () => {
	test("threads In-Reply-To and References, and adds --cc on top of reply-all", async () => {
		const { client, session } = buildClient({});
		session.headerFixture = {
			from: "Alice <alice@example.test>",
			to: ["me@example.test"],
			cc: ["other@example.test"],
			subject: "Original subject",
			messageId: "<original@example.test>",
			references: "<root@example.test>",
		};
		const draft = await client.createReplyDraft({
			messageId: "INBOX:1001:42",
			replyAll: true,
			cc: ["extra@example.test"],
			text: "Reply body.",
		});
		const text = session.appendCalls[0]?.content.toString("utf8") ?? "";
		expect(text).toContain("In-Reply-To: <original@example.test>");
		expect(text).toContain("References: <root@example.test> <original@example.test>");
		expect(text).toContain("To: Alice <alice@example.test>");
		expect(text).toContain("other@example.test");
		expect(text).toContain("extra@example.test");
		expect(draft.subject).toBe("Re: Original subject");
	});
});

describe("BridgeMailAccessClient.sendDraft", () => {
	test("sends the draft source then deletes it by UID", async () => {
		const { client, session, smtp } = buildClient({});
		session.sourceFixture.set(11, {
			source: Buffer.from(
				"From: me@example.test\r\nTo: dest@example.test\r\nSubject: Draft\r\n\r\nBody.\r\n",
			),
			isRead: true,
		});
		await client.sendDraft("Drafts:2002:11");
		expect(smtp.sent).toHaveLength(1);
		expect(smtp.sent[0]?.envelope.to).toEqual(["dest@example.test"]);
		expect(session.deleteCalls).toEqual([{ path: "Drafts", uid: 11 }]);
	});

	test("does not delete the draft when SMTP throws", async () => {
		const { client, session, smtp } = buildClient({});
		session.sourceFixture.set(11, {
			source: Buffer.from(
				"From: me@example.test\r\nTo: dest@example.test\r\nSubject: Draft\r\n\r\nBody.\r\n",
			),
			isRead: true,
		});
		smtp.failNextSend = true;
		await expect(client.sendDraft("Drafts:2002:11")).rejects.toThrow("fake smtp connection dropped");
		expect(session.deleteCalls).toEqual([]);
	});
});

describe("BridgeMailAccessClient connection errors", () => {
	test("missing bridgeUsername fails before any connection", async () => {
		const { client } = buildClient({ profile: fixtureProfile({ bridgeUsername: undefined }) });
		await expect(client.listMessages({ folderId: "inbox", limit: 20, page: 0 })).rejects.toThrow(
			"Proton Bridge username is not configured",
		);
	});

	test("missing credential fails with the dg-skills credentials set sentence", async () => {
		const { client } = buildClient({ credential: null });
		await expect(client.listMessages({ folderId: "inbox", limit: 20, page: 0 })).rejects.toThrow(
			"store the Proton Bridge password first: dg-skills credentials set inbox/protonmail-bridge/work",
		);
	});

	test("the password never appears in a thrown error message", async () => {
		const { client } = buildClient({ profile: fixtureProfile({ bridgeUsername: undefined }) });
		let thrown: unknown;
		try {
			await client.listMessages({ folderId: "inbox", limit: 20, page: 0 });
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(Error);
		expect(String((thrown as Error).message)).not.toContain(PASSWORD);
	});
});

describe("bridge-adapter TLS and connection-error mapping", () => {
	const options: BridgeConnectionOptions = {
		host: "127.0.0.1",
		imapPort: 1143,
		smtpPort: 1025,
		username: "me@example.test",
		password: PASSWORD,
		credentialName: "inbox/protonmail-bridge/work",
	};

	test("rejectUnauthorized is false for a loopback host with no fingerprint", () => {
		const tls = tlsOptionsFor("127.0.0.1", undefined);
		expect(tls.rejectUnauthorized).toBe(false);
		expect(tls.checkServerIdentity("127.0.0.1", { fingerprint256: "AA:BB" } as never)).toBeUndefined();
	});

	test("a configured fingerprint that matches passes, and a mismatch throws", () => {
		const tls = tlsOptionsFor("127.0.0.1", "aabbcc");
		expect(tls.checkServerIdentity("127.0.0.1", { fingerprint256: "aa:bb:cc" } as never)).toBeUndefined();
		const mismatch = tls.checkServerIdentity("127.0.0.1", { fingerprint256: "dd:ee:ff" } as never);
		expect(mismatch?.message).toBe("Proton Bridge certificate fingerprint does not match the profile");
	});

	test("verifyFingerprint is a pure comparison", () => {
		expect(verifyFingerprint({ fingerprint256: "AA:BB:CC" }, "aabbcc")).toBeUndefined();
		expect(verifyFingerprint({ fingerprint256: "AA:BB:CC" }, "000000")?.message).toBe(
			"Proton Bridge certificate fingerprint does not match the profile",
		);
	});

	test("a non-loopback host throws even if the profile validator is bypassed", () => {
		expect(() => tlsOptionsFor("10.0.0.5", undefined)).toThrow("Proton Bridge host must be loopback");
	});

	test("connection refused maps to the reachability sentence with host and port", () => {
		const error = connectionErrorFor(options, 1143, { code: "ECONNREFUSED" });
		expect(error.message).toBe(
			"Proton Bridge is not reachable on 127.0.0.1:1143; start Proton Bridge and check the profile",
		);
	});

	test("an IMAP NO on login maps to the credential-update sentence", () => {
		const error = connectionErrorFor(options, 1143, new Error("Command failed: NO [AUTHENTICATIONFAILED] login failed"));
		expect(error.message).toBe(
			"Proton Bridge rejected the login; update the credential inbox/protonmail-bridge/work",
		);
	});
});
