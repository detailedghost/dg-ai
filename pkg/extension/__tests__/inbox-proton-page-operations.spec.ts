import { expect, it } from "bun:test";
import * as shared from "../../inbox/src/protonmail/page-operations";
import * as extension from "../lib/features/inbox-proton";

it("the extension feature runs the shared page-operations implementation", () => {
	expect(extension.executeProtonPage).toBe(shared.executeProtonPage);
	expect(extension.redactInboxText).toBe(shared.redactInboxText);
	expect(extension.sanitizeInboxBrowserResponse).toBe(
		shared.sanitizeInboxBrowserResponse,
	);
});
