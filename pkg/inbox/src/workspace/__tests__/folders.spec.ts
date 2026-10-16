import { describe, expect, test } from "bun:test";
import type { MailFolder } from "../../providers/types";
import { inferTargetFolder } from "../folders";

function mailFolder(name: string): MailFolder {
	return { id: name, name, type: "folder" };
}

function routingFolders(): MailFolder[] {
	return [mailFolder("credit-card"), mailFolder("bank")];
}

describe("inferTargetFolder", () => {
	test("routes a Capital One sender to the credit-card folder", () => {
		const target = inferTargetFolder(
			"From: alerts@notification.capitalone.com",
			routingFolders(),
		);

		expect(target?.folder.name).toBe("credit-card");
	});

	test("routes a plain bank sender to the bank folder", () => {
		const target = inferTargetFolder(
			"From: alerts@bank.example",
			routingFolders(),
		);

		expect(target?.folder.name).toBe("bank");
	});
});
