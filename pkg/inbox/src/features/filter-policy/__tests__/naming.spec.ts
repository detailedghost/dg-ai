import { describe, expect, test } from "bun:test";
import {
	compilePattern,
	segmentAllowed,
	suggestFilterRename,
	suggestFolderPath,
} from "../naming";

const policy = {
	folderSlugPattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$",
	folderExceptions: ["Notification", "Alerts"],
};

function plusAndDot(tag: string): string {
	return [
		'require ["fileinto"];',
		`if anyof (address :all :is "To" "owner+${tag}@example.test", address :all :is "To" "owner.${tag}@example.test") {`,
		'  fileinto "family";',
		"}",
	].join("\n");
}

describe("filter naming", () => {
	test("suggests plus-tags, capitalization, and a shared dot-address", () => {
		expect(suggestFilterRename("Bot - family")).toEqual({
			to: "+Family",
			reason: "Bot filters use a plus-tag name",
		});
		expect(suggestFilterRename("+school")).toEqual({
			to: "+School",
			reason: "Plus-tags use a capital letter",
		});
		expect(
			suggestFilterRename("+Family", { sieve: plusAndDot("family") }),
		).toEqual({
			to: "+Family & .family",
			reason: "Dot-address shares this plus-tag",
		});
		expect(
			suggestFilterRename("+Family & .family", { sieve: plusAndDot("family") }),
		).toBeUndefined();
	});

	test("expands Notif, plurals, and truncated subs", () => {
		expect(suggestFilterRename("Fin - Notif")).toEqual({
			to: "Fin - Notification",
			reason: "Notif expands to Notification",
		});
		expect(
			suggestFilterRename("Fin - Investment", {
				folderPaths: ["fin/investments"],
			}),
		).toEqual({
			to: "Fin - Investments",
			reason: "Use the folder's plural",
		});
		expect(
			suggestFilterRename("Fin - Bank", {
				sieve:
					'require ["fileinto"];\nif true {\n  fileinto "fin/banking";\n}\n',
			}),
		).toEqual({
			to: "Fin - Banking",
			reason: "Subname looks truncated",
		});
		expect(suggestFilterRename("Fin - Banking")).toBeUndefined();
	});

	test("uses the configured slug pattern and its exception list", () => {
		expect(suggestFolderPath("Fin/Banking", policy)?.to).toBe("fin/banking");
		expect(suggestFolderPath("Notification/Alerts", policy)).toBeUndefined();
		expect(segmentAllowed("Alerts", policy)).toBe(true);
		expect(segmentAllowed("fin", policy)).toBe(true);
		const caps = {
			folderSlugPattern: "^[A-Z]+$",
			folderExceptions: [],
		};
		expect(segmentAllowed("ALERTS", caps)).toBe(true);
		expect(suggestFolderPath("alerts", caps)?.to).toBe("alerts");
		expect(() => compilePattern("[")).toThrow(/regular expression/);
	});
});
