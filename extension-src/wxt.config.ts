import { defineConfig } from "wxt";

// Manifest name is prefixed dg-ai- so the loaded extension is identifiable as ours.
export default defineConfig({
	manifest: ({ browser }) => ({
		name: "dg-ai-extension",
		description: "Auto-groups GitHub PR/URL tabs into a named, colored tab group as they open.",
		permissions: ["tabs", "tabGroups", "storage"],
		// Firefox-only: ID is required for MV3; declare no-data-collection (Nov 2025 rule).
		...(browser === "firefox"
			? {
					browser_specific_settings: {
						gecko: {
							id: "dg-ai-extension@detailedghost",
							data_collection_permissions: { required: ["none"] },
						},
					},
				}
			: {}),
	}),
});
