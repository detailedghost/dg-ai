(() => {
	const context = document.modelContext;
	if (!context) throw new Error("dg-ai-extension did not inject the Web MCP shim before this script.");
	const object = { type: "object", properties: { id: { type: "string" } } };
	const tools = [
		{
			name: "dg_outlook_list",
			description: "Fixture: lists two fake messages. Read class on Outlook; asks each time on any other site.",
			inputSchema: { type: "object", properties: {} },
			execute: () =>
				JSON.stringify({
					messages: [
						{ id: "fixture-1", subject: "Fixture message one" },
						{ id: "fixture-2", subject: "Fixture message two" },
					],
				}),
		},
		{
			name: "dg_outlook_move",
			description: "Fixture: pretends to move a fake message. Session class on Outlook.",
			inputSchema: object,
			execute: (args) => `Fixture: moved ${args.id ?? "fixture-1"} to Archive. Nothing changed.`,
		},
		{
			name: "dg_outlook_delete",
			description: "Fixture: pretends to delete a fake message. Each class everywhere.",
			inputSchema: object,
			execute: (args) => `Fixture: deleted ${args.id ?? "fixture-1"}. Nothing changed.`,
		},
		{
			name: "dg_fixture_echo",
			description: "Fixture: returns its arguments. Each class everywhere.",
			inputSchema: { type: "object", properties: { text: { type: "string" } } },
			execute: (args) => `Fixture echo: ${JSON.stringify(args)}`,
		},
	];
	for (const tool of tools) context.registerTool(tool);
})();
