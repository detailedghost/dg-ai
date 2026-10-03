export type CodexPacket = {
	kind: "message";
	id: string;
	sourceIdHash: string;
	fromDomain: string;
	subject: string;
	snippet: string;
	currentFolder: string;
	categories?: string[];
	folders: string[];
};
