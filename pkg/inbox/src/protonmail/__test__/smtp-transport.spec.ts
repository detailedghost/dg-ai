import { describe, expect, test } from "bun:test";
import { X509Certificate } from "node:crypto";
import { createServer as createPlainServer, type Socket } from "node:net";
import { TLSSocket } from "node:tls";
import { createBridgeSmtpSender, type BridgeConnectionOptions } from "../bridge-adapter";
import { TEST_BRIDGE_CERT_PEM, TEST_BRIDGE_KEY_PEM } from "./fixtures/test-bridge-tls";

const PASSWORD = "fixture-bridge-password-9f21";
const MIME = Buffer.from(
	"Subject: Test\r\nFrom: alice@example.test\r\nTo: bob@example.test\r\n\r\nHello.\r\n",
);

function attachLineHandler(socket: Socket | TLSSocket, onLine: (line: string) => void): () => void {
	let buffer = "";
	const handler = (chunk: Buffer) => {
		buffer += chunk.toString("binary");
		let newlineIndex: number;
		while ((newlineIndex = buffer.indexOf("\n")) >= 0) {
			const line = buffer.slice(0, newlineIndex).replace(/\r$/, "");
			buffer = buffer.slice(newlineIndex + 1);
			onLine(line);
		}
	};
	socket.on("data", handler);
	return () => socket.off("data", handler);
}

/**
 * A minimal STARTTLS-capable SMTP submission server: greets, upgrades on `STARTTLS` using the
 * same throwaway certificate the IMAP pin tests use, then accepts `AUTH PLAIN`, `MAIL FROM`,
 * `RCPT TO`, and one `DATA` block. `postStartTlsCommands` only ever receives lines the server
 * read after the TLS upgrade, so a client that aborts the handshake on a fingerprint mismatch
 * leaves it empty — proof that no `AUTH` (or anything else) went out before the pin was checked.
 */
function startFakeBridgeSmtpServer(): {
	port: Promise<number>;
	postStartTlsCommands: string[];
	close(): void;
} {
	const postStartTlsCommands: string[] = [];
	const server = createPlainServer((socket) => {
		let secure: TLSSocket | undefined;
		let inData = false;
		let detachPlain = (): void => {};
		const write = (text: string) => (secure ?? socket).write(text);
		const onLine = (line: string): void => {
			if (secure) postStartTlsCommands.push(line);
			if (inData) {
				if (line === ".") {
					inData = false;
					write("250 2.0.0 Message accepted\r\n");
				}
				return;
			}
			const upper = line.toUpperCase();
			if (upper.startsWith("EHLO")) {
				write("250-bridge.test\r\n250 AUTH PLAIN\r\n");
			} else if (upper === "STARTTLS") {
				write("220 Ready to start TLS\r\n");
				detachPlain();
				secure = new TLSSocket(socket, {
					isServer: true,
					cert: TEST_BRIDGE_CERT_PEM,
					key: TEST_BRIDGE_KEY_PEM,
				});
				attachLineHandler(secure, onLine);
			} else if (upper.startsWith("AUTH PLAIN")) {
				write("235 Authentication successful\r\n");
			} else if (upper.startsWith("MAIL FROM")) {
				write("250 OK\r\n");
			} else if (upper.startsWith("RCPT TO")) {
				write("250 OK\r\n");
			} else if (upper === "DATA") {
				write("354 Start mail input\r\n");
				inData = true;
			} else if (upper === "QUIT") {
				write("221 Bye\r\n");
				(secure ?? socket).end();
			}
		};
		socket.write("220 bridge.test ESMTP\r\n");
		detachPlain = attachLineHandler(socket, onLine);
	});
	const port = new Promise<number>((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (!address || typeof address === "string") throw new Error("no port assigned");
			resolve(address.port);
		});
	});
	return { port, postStartTlsCommands, close: () => server.close() };
}

async function withFakeServer(
	run: (fixture: { port: number; postStartTlsCommands: string[] }) => Promise<void>,
): Promise<void> {
	const { port, postStartTlsCommands, close } = startFakeBridgeSmtpServer();
	try {
		await run({ port: await port, postStartTlsCommands });
	} finally {
		close();
	}
}

function optionsFor(port: number, certFingerprint: string | undefined): BridgeConnectionOptions {
	return {
		host: "127.0.0.1",
		imapPort: 1143,
		smtpPort: port,
		username: "alice@example.test",
		password: PASSWORD,
		certFingerprint,
		credentialName: "inbox/protonmail-bridge/work",
	};
}

describe("createBridgeSmtpSender against a real STARTTLS handshake", () => {
	const realFingerprint = new X509Certificate(TEST_BRIDGE_CERT_PEM).fingerprint256.replace(/:/g, "");

	test("a matching fingerprint sends through AUTH, MAIL, RCPT, and DATA", async () => {
		await withFakeServer(async ({ port, postStartTlsCommands }) => {
			const smtp = await createBridgeSmtpSender(optionsFor(port, realFingerprint));
			await smtp.send(MIME, { from: "alice@example.test", to: ["bob@example.test"] });
			expect(postStartTlsCommands.some((line) => line.toUpperCase().startsWith("AUTH PLAIN"))).toBe(
				true,
			);
			expect(postStartTlsCommands).toContain("MAIL FROM:<alice@example.test>");
			expect(postStartTlsCommands).toContain("RCPT TO:<bob@example.test>");
			expect(postStartTlsCommands).toContain("DATA");
		});
	});

	test("no fingerprint configured keeps today's behavior and still sends", async () => {
		await withFakeServer(async ({ port, postStartTlsCommands }) => {
			const smtp = await createBridgeSmtpSender(optionsFor(port, undefined));
			await smtp.send(MIME, { from: "alice@example.test", to: ["bob@example.test"] });
			expect(postStartTlsCommands.some((line) => line.toUpperCase().startsWith("AUTH PLAIN"))).toBe(
				true,
			);
		});
	});

	test("a mismatched fingerprint fails before AUTH and sends nothing", async () => {
		await withFakeServer(async ({ port, postStartTlsCommands }) => {
			const smtp = await createBridgeSmtpSender(optionsFor(port, "00".repeat(32)));
			await expect(
				smtp.send(MIME, { from: "alice@example.test", to: ["bob@example.test"] }),
			).rejects.toThrow("Proton Bridge certificate fingerprint does not match the profile");
			expect(postStartTlsCommands).toHaveLength(0);
		});
	});
});
