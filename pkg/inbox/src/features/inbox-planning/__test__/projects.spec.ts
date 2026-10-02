import { describe, expect, test } from "bun:test";
import { faker } from "@faker-js/faker/locale/en";
import { buildProjectCandidates } from "../projects";
import type { MessageWorkItem } from "../../../workspace/types";

describe("inbox project discovery", () => {
	test("extracts project candidates from redacted message metadata", () => {
		faker.seed(101);
		const incidentDomain = faker.internet.domainName();
		const tenant = faker.string.alpha({ length: 8, casing: "lower" });
		const projectDomain = `${tenant}.atlassian.net`;
		const companyDomain = faker.internet.domainName();
		const platformProject = `${title(faker.commerce.productAdjective())} Data Replication`;
		const portalProject = `${title(faker.commerce.department())} Portal Front End Architecture Options`;
		const candidates = buildProjectCandidates(
			[
				item(
					"1",
					incidentDomain,
					`Statuspage: Long-running incident (${platformProject} is unavailable)!`,
				),
				item(
					"2",
					incidentDomain,
					`Statuspage: scheduled maintenance set to 'Completed' (${platformProject} is unavailable)`,
				),
				item("3", projectDomain, `${portalProject} - commented`),
				item("4", projectDomain, `${portalProject} - updated`),
				item("5", companyDomain, "Lunch order"),
			],
			{ limit: 10, minCount: 2, sampleLimit: 1 },
		);

		expect(
			candidates.find(
				(candidate) => candidate.name === `${platformProject} is Unavailable`,
			),
		).toMatchObject({
			count: 2,
			signals: expect.arrayContaining(["parenthetical"]),
		});
		expect(
			candidates.find((candidate) => candidate.name === portalProject),
		).toMatchObject({
			count: 2,
			domains: [projectDomain],
		});
		expect(
			candidates.find((candidate) => candidate.name === "Lunch Order"),
		).toBeUndefined();
		expect(candidates[0]?.samples).toHaveLength(1);
	});

	test("collapses project-app activity into the named workstream and excludes account events", () => {
		faker.seed(202);
		const designDomain = `${faker.string.alpha({ length: 8, casing: "lower" })}.atlassian.net`;
		const sourceDomain = faker.internet.domainName();
		const actorOne = faker.word.words({ count: 2 });
		const actorTwo = faker.word.words({ count: 2 });
		const workstream = `${title(faker.commerce.productMaterial())} Management`;
		const candidates = buildProjectCandidates(
			[
				item(
					"1",
					designDomain,
					`${actorOne} Replied to a Thread in "${workstream}`,
				),
				item("2", designDomain, `${actorTwo} Mentioned you in "${workstream}`),
				item(
					"3",
					sourceDomain,
					"A Personal Access Token (classic) has been added to your account",
				),
			],
			{ limit: 10, minCount: 1, sampleLimit: 2 },
		);

		expect(candidates).toContainEqual(
			expect.objectContaining({
				name: workstream,
				count: 2,
				signals: expect.arrayContaining(["subject"]),
			}),
		);
		expect(
			candidates.find((candidate) =>
				candidate.name.includes("Personal Access Token"),
			),
		).toBeUndefined();
	});
});

function item(id: string, domain: string, subject: string): MessageWorkItem {
	return {
		kind: "message-work-item",
		id,
		sourceMessageId: id,
		sourceIdHash: `hash-${id}`,
		file: `messages/${id}.json`,
		status: "fetched",
		statusUpdatedAt: new Date(0).toISOString(),
		currentFolder: "Inbox",
		packet: {
			kind: "message",
			id,
			sourceIdHash: `hash-${id}`,
			fromDomain: domain,
			subject,
			snippet: "",
			currentFolder: "Inbox",
			folders: ["Inbox"],
			categories: [],
		},
	};
}

function title(value: string): string {
	return value
		.split(/\s+/)
		.map((word) => `${word.slice(0, 1).toUpperCase()}${word.slice(1)}`)
		.join(" ");
}
