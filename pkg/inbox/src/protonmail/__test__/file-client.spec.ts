import { describe, expect, test } from "bun:test";
import { FileBackedProtonMailClient } from "../file-client";
import { emptyDataset } from "../fixtures";

function clientWith(folders: Array<{ id: string; name: string; path: string }>) {
	return new FileBackedProtonMailClient({
		dataset: {
			...structuredClone(emptyDataset),
			folders: folders.map((folder) => ({
				...folder,
				type: "folder" as const,
				total: 0,
				unread: 0,
			})),
		},
	});
}

describe("file-backed folder creation", () => {
	test("creates the requested path when only another path shares its leaf name", async () => {
		const client = clientWith([{ id: "fin", name: "invoices", path: "fin/invoices" }]);
		const created = await client.createFolder({
			name: "invoices",
			path: "shop/invoices",
		});
		expect(created.id).not.toBe("fin");
		expect(created.path).toBe("shop/invoices");
	});

	test("returns the folder whose full path matches", async () => {
		const client = clientWith([
			{ id: "fin", name: "invoices", path: "fin/invoices" },
			{ id: "shop", name: "invoices", path: "shop/invoices" },
		]);
		const found = await client.createFolder({
			name: "invoices",
			path: "shop/invoices",
		});
		expect(found.id).toBe("shop");
	});

	test("matches by name when no path is given", async () => {
		const client = clientWith([{ id: "fin", name: "invoices", path: "fin/invoices" }]);
		expect((await client.createFolder({ name: "Invoices" })).id).toBe("fin");
	});
});
