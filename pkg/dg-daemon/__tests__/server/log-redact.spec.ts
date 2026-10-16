import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { clearNotedSecrets, noteSecret } from "@dg/common";
import { resolveDgPaths } from "@dg/common/node";
import { createLogger, logFileFor } from "../../src/server/log";
import { cleanupDgHome, freshTempDir } from "../utils/daemon-harness";

const TOKEN = "daemon-log-token-must-stay-out";
const EMAIL = "logs@example.com";

let dgHome: string;

afterEach(() => {
	clearNotedSecrets();
	cleanupDgHome(dgHome);
});

describe("daemon file log", () => {
	it("redacts tokens, bootstrap urls, and emails before they reach disk", async () => {
		dgHome = freshTempDir("dg-log-redact");
		const paths = resolveDgPaths({ env: { DG_HOME: dgHome } });
		noteSecret(TOKEN);
		const logger = createLogger(paths);
		logger.error(
			`session failed token ${TOKEN} for ${EMAIL} http://127.0.0.1:9/start#_chat=${TOKEN} Authorization: Bearer ${TOKEN}`,
		);
		await logger.flush();
		const text = readFileSync(logFileFor(paths.logDir, new Date()), "utf8");
		expect(text).not.toContain(TOKEN);
		expect(text).not.toContain(EMAIL);
		expect(text).toContain("[redacted]");
	});
});
