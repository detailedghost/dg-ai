import { randomBytes, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:http";

export type EncryptedAuthCache = {
	get(): Promise<string | null>;
	set(value: string): Promise<void>;
};

export function oauthState(): string {
	return randomBytes(32).toString("base64url");
}

export function validateLoopbackRedirect(value: string): URL {
	const url = new URL(value);
	if (
		url.protocol !== "http:" ||
		!["localhost", "127.0.0.1"].includes(url.hostname) ||
		url.username ||
		url.password ||
		url.search ||
		url.hash
	) {
		throw new Error(
			"OAuth redirect must be an HTTP loopback URL on localhost or 127.0.0.1 without credentials, query, or fragment.",
		);
	}
	return url;
}

export async function listenForOAuthCode(
	redirectUri: string,
	state: string,
	timeoutMs = 120_000,
): Promise<{
	redirectUri: string;
	code: Promise<string>;
	close(): void;
}> {
	const requested = validateLoopbackRedirect(redirectUri);
	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 300_000) {
		throw new Error(
			"OAuth callback deadline must be between 1 and 300000 milliseconds.",
		);
	}
	let resolveCode!: (value: string) => void;
	let rejectCode!: (error: Error) => void;
	let settled = false;
	const code = new Promise<string>((resolve, reject) => {
		resolveCode = resolve;
		rejectCode = reject;
	});
	void code.catch(() => {});
	const server = createServer((request, response) => {
		const callback = new URL(request.url ?? "/", "http://127.0.0.1");
		if (request.method !== "GET" || callback.pathname !== requested.pathname) {
			response.writeHead(404).end("Unknown callback.");
			return;
		}
		const suppliedState = Buffer.from(callback.searchParams.get("state") ?? "");
		const expectedState = Buffer.from(state);
		const validState =
			suppliedState.length === expectedState.length &&
			timingSafeEqual(suppliedState, expectedState);
		if (
			!validState ||
			callback.searchParams.has("error") ||
			!callback.searchParams.get("code")
		) {
			response.writeHead(400).end("Login failed. Return to dg-ai.");
			finish(
				new Error(
					validState
						? "OAuth login was denied or returned no authorization code."
						: "OAuth callback state did not match.",
				),
			);
			return;
		}
		response
			.writeHead(200, {
				"Content-Type": "text/html; charset=utf-8",
				"Cache-Control": "no-store",
			})
			.end("<html><body>Login complete. Return to dg-ai.</body></html>");
		if (!settled) {
			settled = true;
			clearTimeout(timer);
			resolveCode(callback.searchParams.get("code")!);
		}
	});
	function finish(error: Error): void {
		if (!settled) {
			settled = true;
			clearTimeout(timer);
			rejectCode(error);
		}
	}
	const timer = setTimeout(() => {
		finish(new Error("OAuth login timed out. Retry the login command."));
		close();
	}, timeoutMs);
	function close(): void {
		clearTimeout(timer);
		finish(new Error("OAuth login was canceled."));
		server.close();
		server.closeAllConnections();
		server.unref();
	}
	try {
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(
				{ host: "127.0.0.1", port: Number(requested.port || 0) },
				resolve,
			);
		});
	} catch {
		close();
		throw new Error(
			"Could not open the local OAuth callback port. Check the configured redirect URI.",
		);
	}
	server.on("error", () => finish(new Error("OAuth callback server failed.")));
	const address = server.address();
	if (!address || typeof address === "string") {
		close();
		throw new Error("OAuth callback listener has no local address.");
	}
	requested.port = String(address.port);
	return { redirectUri: requested.toString(), code, close };
}

export async function openOAuthBrowser(
	url: string,
	command?: string,
): Promise<void> {
	const args = command?.trim()
		? [...command.trim().split(/\s+/), url]
		: process.platform === "darwin"
			? ["open", url]
			: process.platform === "win32"
				? ["rundll32", "url.dll,FileProtocolHandler", url]
				: ["xdg-open", url];
	const executable = args.shift()!;
	await new Promise<void>((resolve, reject) => {
		const child = spawn(executable, args, { detached: true, stdio: "ignore" });
		child.once("error", () =>
			reject(
				new Error(
					"Could not open the login browser. Configure the browser command.",
				),
			),
		);
		child.once("spawn", () => {
			child.unref();
			resolve();
		});
	});
}
