import { afterAll, describe, expect, test } from "bun:test";
import { symlinkSync } from "node:fs";
import { join } from "node:path";
import {
	classifyEnvKey,
	extractCompose,
	extractDockerfile,
	extractEnv,
	extractRegistries,
	extractTerraform,
	extractToolchain,
	extractWorkflows,
	mergeRequirements,
	parseEnvFile,
	type Requirement,
	sniff,
	sortRequirements,
	walkFiles,
} from "../src/sniff";
import { readText } from "../src/sniff/walk";
import { FAKE, requirement, sniffWorld } from "./sniff-fixtures";

const world = sniffWorld();
afterAll(() => world.cleanup());

function scan(
	root: string,
	extract: (root: string, files: string[]) => Requirement[],
): Requirement[] {
	return extract(root, walkFiles(root));
}

describe("walkFiles", () => {
	test("does not follow symbolic links out of the tree", () => {
		const outside = world.tree({ "Dockerfile": "FROM alpine:3.20\n" });
		const root = world.tree({ "keep/Dockerfile": "FROM alpine:3.20\n" });
		symlinkSync(outside, join(root, "linked"), "dir");
		expect(
			walkFiles(root).filter((f) => f.endsWith("Dockerfile")),
		).toEqual([join(root, "keep", "Dockerfile")]);
	});

	test("skips dot-directories so nested worktrees are not counted twice", () => {
		const root = world.tree({
			Dockerfile: "FROM alpine:3.20\n",
			".claude/worktrees/feature/Dockerfile": "FROM alpine:3.20\n",
			".venv/lib/Dockerfile": "FROM alpine:3.20\n",
		});
		expect(
			walkFiles(root).filter((f) => f.endsWith("Dockerfile")),
		).toHaveLength(1);
	});

	test("still descends into .github", () => {
		const root = world.tree({ ".github/workflows/ci.yml": "on: push\n" });
		expect(walkFiles(root)).toHaveLength(1);
	});

	test.each([
		"node_modules",
		"venv",
		"__pycache__",
		"bin",
		"obj",
		"dist",
		"build",
		"target",
		"vendor",
	])("skips %s", (dir) => {
		const root = world.tree({ [`${dir}/inner/Dockerfile`]: "FROM alpine\n" });
		expect(walkFiles(root)).toEqual([]);
	});

	test("lists dot-files in visited directories", () => {
		const root = world.tree({ ".env": "A=1\n" });
		expect(walkFiles(root)).toHaveLength(1);
	});

	test("stops descending below six directory levels", () => {
		const six = "a/b/c/d/e/f/file.txt";
		const seven = "a/b/c/d/e/f/g/file.txt";
		const root = world.tree({ [six]: "x", [seven]: "x" });
		const found = walkFiles(root).map((path) => path.slice(root.length + 1));
		expect(found).toContain(six);
		expect(found).not.toContain(seven);
	});

	test("an unreadable or missing root yields no files instead of throwing", () => {
		expect(walkFiles(`${world.tree({})}/missing`)).toEqual([]);
	});
});

describe("classifyEnvKey", () => {
	test.each([
		["SERVICE_AUTH_TOKEN", "SECRET"],
		["SF_PRIVATE_KEY", "SECRET"],
		["ENTITY_DB_CONNECTION_STRING", "SECRET"],
		["ENTITY_DB_PASS", "SECRET"],
		["APP_WAREHOUSE_CONN_STR", "SECRET"],
		["SENTRY_DSN", "SECRET"],
		["PAYMENT_API_KEY", "SECRET"],
		["PAYMENT_APIKEY", "SECRET"],
		["DB_PASSWD", "SECRET"],
		["CLIENT_CREDENTIAL", "SECRET"],
		["FEATURE_CONTROLLER_ACTIVE", "CONFIG"],
		["APP_AUTH_DOMAIN", "CONFIG"],
		["ASPNETCORE_ENVIRONMENT", "CONFIG"],
		["DB_HOST", "CONFIG"],
		["PASSENGER_COUNT", "CONFIG"],
	])("%s is %s", (key, expected) => {
		expect(classifyEnvKey(key)).toBe(expected as "SECRET" | "CONFIG");
	});
});

describe("parseEnvFile", () => {
	test("captures keys with line numbers and skips comments and blanks", () => {
		expect(
			parseEnvFile("# comment\nDB_HOST=localhost\n\nexport DB_PORT=5432\n"),
		).toEqual([
			{ key: "DB_HOST", line: 2 },
			{ key: "DB_PORT", line: 4 },
		]);
	});

	test("skips underscore-prefixed disabled twins", () => {
		expect(parseEnvFile("SVC_USER=a\n_SVC_USER=b\n__SVC_USER=c\n")).toEqual([
			{ key: "SVC_USER", line: 1 },
		]);
	});

	test("does not capture values", () => {
		const parsed = parseEnvFile("SF_PRIVATE_KEY=fake-pem-body-1a2b3c\n");
		expect(JSON.stringify(parsed)).not.toContain("fake-pem-body-1a2b3c");
	});

	test("skips an indented comment", () => {
		expect(parseEnvFile("   # A=1\nB=2\n")).toEqual([{ key: "B", line: 2 }]);
	});
});

describe("extractEnv", () => {
	test("flags keys present in .env but absent from the sample", () => {
		const root = world.tree({
			".env": "DB_HOST=x\nMIGRATION_URL=y\n",
			".env.sample": "DB_HOST=\n",
		});
		const undocumented = scan(root, extractEnv).filter((r) =>
			r.gaps.some((g) => g.kind === "undocumented"),
		);
		expect(undocumented.map((r) => r.name)).toEqual(["MIGRATION_URL"]);
	});

	test("never flags the sample itself", () => {
		const root = world.tree({
			".env": "DB_HOST=x\n",
			".env.sample": "DB_HOST=\nQUEUE_API_URL=\n",
		});
		const sample = scan(root, extractEnv).filter(
			(r) => r.source === ".env.sample",
		);
		expect(sample.length).toBeGreaterThan(0);
		expect(sample.every((r) => r.gaps.length === 0)).toBe(true);
	});

	test("stays silent about undocumented keys when no sample exists", () => {
		const root = world.tree({ ".env": "DB_HOST=x\nMIGRATION_URL=y\n" });
		expect(scan(root, extractEnv).every((r) => r.gaps.length === 0)).toBe(true);
	});

	test.each([".env.example", ".env.template"])(
		"treats %s as a committed sample",
		(sample) => {
			const root = world.tree({
				".env": "A_KEY=1\nB_KEY=2\n",
				[sample]: "A_KEY=\n",
			});
			const gapped = scan(root, extractEnv).filter((r) => r.gaps.length > 0);
			expect(gapped.map((r) => r.name)).toEqual(["B_KEY"]);
		},
	);

	test("reads suffixed env files such as .env.local", () => {
		const root = world.tree({ ".env.local": "LOCAL_ONLY=1\n" });
		expect(scan(root, extractEnv).map((r) => r.name)).toEqual(["LOCAL_ONLY"]);
	});

	test("records the line each key is declared on", () => {
		const root = world.tree({ ".env": "# top\nFIRST=1\nSECOND=2\n" });
		const where = Object.fromEntries(
			scan(root, extractEnv).map((r) => [r.name, r.where]),
		);
		expect(where).toEqual({ FIRST: ".env:2", SECOND: ".env:3" });
	});
});

describe("extractWorkflows", () => {
	test("captures workflow secrets, OIDC role, and login registry", () => {
		const root = world.tree({
			".github/workflows/deploy.yml": [
				"jobs:",
				"  deploy:",
				"    steps:",
				"      - uses: aws-actions/configure-aws-credentials@v4",
				"        with:",
				"          role-to-assume: arn:aws:iam::000000000000:role/github-actions-role",
				"      - uses: docker/login-action@v3",
				"        with:",
				"          registry: registry.example.test",
				"          password: ${{ secrets.REGISTRY_PASSWORD }}",
			].join("\n"),
		});
		const found = scan(root, extractWorkflows);
		expect(found.find((r) => r.type === "SECRET")?.name).toBe(
			"REGISTRY_PASSWORD",
		);
		expect(found.find((r) => r.type === "CLOUD_PERM")?.name).toBe(
			"github-actions-role",
		);
		expect(found.find((r) => r.type === "REGISTRY")?.name).toBe(
			"registry.example.test",
		);
	});

	test("skips an OIDC role given as an expression", () => {
		const root = world.tree({
			".github/workflows/ci.yml":
				"          role-to-assume: ${{ secrets.AWS_ROLE }}\n",
		});
		expect(
			scan(root, extractWorkflows).filter((r) => r.type === "CLOUD_PERM"),
		).toEqual([]);
	});

	test("ignores the ambient GITHUB_TOKEN", () => {
		const root = world.tree({
			".github/workflows/ci.yml": "token: ${{ secrets.GITHUB_TOKEN }}\n",
		});
		expect(scan(root, extractWorkflows)).toEqual([]);
	});

	test("reads every secret reference on one line", () => {
		const root = world.tree({
			".github/workflows/ci.yml":
				"run: x ${{ secrets.FIRST_KEY }} ${{ secrets.SECOND_KEY }}\n",
		});
		expect(scan(root, extractWorkflows).map((r) => r.name)).toEqual([
			"FIRST_KEY",
			"SECOND_KEY",
		]);
	});

	test("ignores yaml outside .github/workflows", () => {
		const root = world.tree({
			"ci/ci.yml": "run: ${{ secrets.OUTSIDE_KEY }}\n",
		});
		expect(scan(root, extractWorkflows)).toEqual([]);
	});
});

describe("extractTerraform", () => {
	test("splits container_secrets from container_environment", () => {
		const root = world.tree({
			"terraform/deploy/main.tf": [
				"  container_environment = [",
				'    { name = "APP_AUTH_DOMAIN", value = var.domain },',
				"  ]",
				"  container_secrets = [",
				'    { name = "SF_PRIVATE_KEY", valueFrom = "${arn}:SF_PRIVATE_KEY::" },',
				"  ]",
			].join("\n"),
		});
		const found = scan(root, extractTerraform);
		expect(found.find((r) => r.name === "APP_AUTH_DOMAIN")).toMatchObject({
			type: "CONFIG",
			source: "tfc-varset",
		});
		expect(found.find((r) => r.name === "SF_PRIVATE_KEY")).toMatchObject({
			type: "SECRET",
			source: "secrets-mgr",
		});
	});

	test("captures IAM resources and the terraform version pin", () => {
		const root = world.tree({
			"terraform/infra/main.tf": 'resource "aws_iam_role" "task_role" {\n}\n',
			"terraform/infra/versions.tf": '  required_version = ">= 1.9"\n',
		});
		const found = scan(root, extractTerraform);
		expect(found.find((r) => r.type === "CLOUD_PERM")).toMatchObject({
			name: "task_role",
			value: "aws_iam_role",
		});
		expect(found.find((r) => r.type === "TOOLCHAIN")).toMatchObject({
			name: "terraform",
			value: ">= 1.9",
		});
	});

	test("captures a secrets manager resource as a secret name", () => {
		const root = world.tree({
			"main.tf": 'resource "aws_secretsmanager_secret" "api_creds" {\n}\n',
		});
		expect(scan(root, extractTerraform)).toEqual([
			expect.objectContaining({
				type: "SECRET",
				name: "api_creds",
				source: "secrets-mgr",
			}),
		]);
	});

	test("ignores a name outside a container block", () => {
		const root = world.tree({ "main.tf": '  name = "NOT_AN_ENV_KEY"\n' });
		expect(scan(root, extractTerraform)).toEqual([]);
	});
});

describe("extractDockerfile", () => {
	test("captures port, env, base image, and registry host", () => {
		const root = world.tree({
			Dockerfile: [
				"FROM registry.example.test/base/runtime:10.0-alpine",
				"ENV ASPNETCORE_URLS=http://+:8080",
				"EXPOSE 8080",
			].join("\n"),
		});
		const found = scan(root, extractDockerfile);
		expect(found.find((r) => r.type === "NETWORK")).toMatchObject({
			name: ":8080 ingress",
			phase: ["run"],
		});
		expect(found.find((r) => r.type === "CONFIG")?.name).toBe(
			"ASPNETCORE_URLS",
		);
		expect(found.find((r) => r.type === "TOOLCHAIN")).toMatchObject({
			value: "10.0-alpine",
		});
		expect(found.find((r) => r.type === "REGISTRY")?.name).toBe(
			"registry.example.test",
		);
	});

	test("skips build-arg base images and bare-host images", () => {
		const root = world.tree({
			Dockerfile: "FROM ${BASE_IMAGE}\nFROM alpine:3.20\n",
		});
		const found = scan(root, extractDockerfile);
		expect(
			found.filter((r) => r.type === "TOOLCHAIN").map((r) => r.name),
		).toEqual(["alpine"]);
		expect(found.filter((r) => r.type === "REGISTRY")).toEqual([]);
	});

	test("matches suffixed Dockerfile names and classifies ENV by name", () => {
		const root = world.tree({
			"Dockerfile.dev": "FROM alpine\nENV SERVICE_TOKEN=x\n",
		});
		const found = scan(root, extractDockerfile);
		expect(found.find((r) => r.name === "SERVICE_TOKEN")?.type).toBe("SECRET");
		expect(found.find((r) => r.name === "alpine")?.value).toBeUndefined();
	});

	test("skips FROM flags and stage aliases and never reports a stage as an image", () => {
		const root = world.tree({
			Dockerfile: [
				"FROM --platform=$BUILDPLATFORM node:20 AS build",
				"FROM build AS test",
				"FROM --platform=linux/amd64 registry.example.test:5000/base/app@sha256:abc123 AS final",
				"FROM Build",
			].join("\n"),
		});
		const toolchain = scan(root, extractDockerfile).filter(
			(r) => r.type === "TOOLCHAIN",
		);
		expect(toolchain.map((r) => [r.name, r.value])).toEqual([
			["node", "20"],
			["registry.example.test:5000/base/app", undefined],
		]);
	});

	test("does not read a registry port as an image tag", () => {
		const root = world.tree({
			Dockerfile: "FROM localhost:5000/team/app\n",
		});
		expect(
			scan(root, extractDockerfile).find((r) => r.type === "TOOLCHAIN"),
		).toMatchObject({ name: "localhost:5000/team/app", value: undefined });
	});

	test("treats a localhost image prefix as a registry", () => {
		const root = world.tree({ Dockerfile: "FROM localhost:5000/team/app:1\n" });
		expect(
			scan(root, extractDockerfile).find((r) => r.type === "REGISTRY")?.name,
		).toBe("localhost");
	});
});

describe("extractCompose", () => {
	test("captures services and published ports, ignoring non-service blocks", () => {
		const root = world.tree({
			"docker-compose.yml": [
				"services:",
				"  db:",
				"    ports:",
				'      - "5432:5432"',
				"volumes:",
				"  pgdata:",
			].join("\n"),
		});
		const found = scan(root, extractCompose);
		expect(
			found.filter((r) => r.type === "SERVICE").map((r) => r.name),
		).toEqual(["db"]);
		expect(found.find((r) => r.type === "NETWORK")?.name).toBe(
			":5432 published",
		);
	});

	test("finds services in four-space and tab indented files", () => {
		const four = world.tree({
			"compose.yaml": "services:\n    web:\n        ports:\n            - \"80:80\"\n    db:\n",
		});
		expect(
			scan(four, extractCompose)
				.filter((r) => r.type === "SERVICE")
				.map((r) => r.name),
		).toEqual(["web", "db"]);
		const tabbed = world.tree({ "compose.yaml": "services:\n\tweb:\n" });
		expect(scan(tabbed, extractCompose).map((r) => r.name)).toEqual(["web"]);
	});

	test("reads compose.yaml as well as docker-compose.yml", () => {
		const root = world.tree({ "compose.yaml": "services:\n  cache:\n" });
		expect(scan(root, extractCompose).map((r) => r.name)).toEqual(["cache"]);
	});
});

describe("extractToolchain", () => {
	test("reads mise tools, global.json, .nvmrc, engines, and requires-python", () => {
		const root = world.tree({
			"mise.toml": '[tools]\ndotnet = "10.0.100"\n\n[env]\n_.file = ".env"\n',
			"global.json": '{\n  "sdk": {\n    "version": "10.0.100"\n  }\n}\n',
			".nvmrc": "v22.11.0\n",
			"package.json": '{\n  "engines": {\n    "node": ">=22"\n  }\n}\n',
			"pyproject.toml": 'requires-python = ">=3.12"\n',
		});
		const byName = Object.fromEntries(
			scan(root, extractToolchain).map((r) => [
				`${r.source}:${r.name}`,
				r.value,
			]),
		);
		expect(byName["mise:dotnet"]).toBe("10.0.100");
		expect(byName["global.json:dotnet"]).toBe("10.0.100");
		expect(byName["nvmrc:node"]).toBe("22.11.0");
		expect(byName["package.json:node"]).toBe(">=22");
		expect(byName["pyproject.toml:python"]).toBe(">=3.12");
	});

	test("ignores mise keys outside the tools table", () => {
		const root = world.tree({ "mise.toml": '[env]\n_.file = ".env"\n' });
		expect(scan(root, extractToolchain)).toEqual([]);
	});

	test("ignores package.json keys outside engines", () => {
		const root = world.tree({
			"package.json": '{\n  "scripts": {\n    "node": "node x.js"\n  }\n}\n',
		});
		expect(scan(root, extractToolchain)).toEqual([]);
	});

	test("reads a one-line engines block without leaking later keys", () => {
		const root = world.tree({
			"package.json":
				'{\n  "engines": { "node": ">=18" },\n  "scripts": {\n    "build": "tsc"\n  }\n}\n',
		});
		expect(
			scan(root, extractToolchain).map((r) => [r.name, r.value, r.where]),
		).toEqual([["node", ">=18", "package.json:2"]]);
	});

	test("skips an empty .nvmrc", () => {
		const root = world.tree({ ".nvmrc": "\n" });
		expect(scan(root, extractToolchain)).toEqual([]);
	});
});

describe("extractRegistries", () => {
	test("reduces nuget and npm feeds to hosts", () => {
		const root = world.tree({
			"nuget.config":
				'<add key="feed" value="https://nuget.example.test/example-org/index.json" />\n<add key="local" value="LocalPackages" />\n',
			".npmrc": "registry=https://registry.npmjs.org/\n",
		});
		expect(
			scan(root, extractRegistries)
				.map((r) => r.name)
				.sort(),
		).toEqual(["nuget.example.test", "registry.npmjs.org"]);
	});
});

describe("extractRegistries credentials", () => {
	test("drops feed userinfo and query strings from the value and keeps the host as the name", () => {
		const root = world.tree({
			"nuget.config": `<add key="feed" value="https://${FAKE.nugetUser}:${FAKE.nugetPassword}@nuget.example.test/index.json?token=${FAKE.nugetPassword}" />\n`,
			".npmrc": `registry=https://${FAKE.npmUser}:${FAKE.npmPassword}@npm.example.test/\n`,
		});
		const found = scan(root, extractRegistries);
		expect(found.map((r) => r.name).sort()).toEqual([
			"npm.example.test",
			"nuget.example.test",
		]);
		const serialized = JSON.stringify(found);
		for (const secret of [
			FAKE.npmUser,
			FAKE.npmPassword,
			FAKE.nugetUser,
			FAKE.nugetPassword,
		])
			expect(serialized).not.toContain(secret);
		expect(found.map((r) => r.value).sort()).toEqual([
			"https://npm.example.test/",
			"https://nuget.example.test/index.json",
		]);
	});
});

describe("mergeRequirements", () => {
	const pin = (source: string, where: string, value: string): Requirement =>
		requirement({
			type: "TOOLCHAIN",
			name: "dotnet",
			value,
			source,
			where,
		});

	test("flags the same tool pinned across two files", () => {
		const [merged] = mergeRequirements([
			pin("mise", "mise.toml:2", "10.0.100"),
			pin("global.json", "global.json:3", "10.0.100"),
		]);
		expect(merged?.gaps[0]).toMatchObject({ kind: "drifted" });
		expect(merged?.gaps[0]?.detail).toContain("keep in sync");
	});

	test("calls out conflicting versions distinctly", () => {
		const [merged] = mergeRequirements([
			pin("mise", "mise.toml:2", "10.0.100"),
			pin("global.json", "global.json:3", "9.0.100"),
		]);
		expect(merged?.gaps[0]?.detail).toContain("conflicting pins");
	});

	test("treats a Docker tag and an .nvmrc pin of the same version as consistent", () => {
		const [merged] = mergeRequirements([
			pin("dockerfile", "Dockerfile:1", "20-alpine"),
			pin("nvmrc", ".nvmrc:1", "20"),
		]);
		expect(merged?.gaps[0]).toMatchObject({ kind: "drifted" });
		expect(merged?.gaps[0]?.detail).not.toContain("conflicting pins");
	});

	test("ignores repeated range constraints, which are expected per module", () => {
		const merged = mergeRequirements([
			{
				...pin("terraform", "terraform/infra/main.tf:2", "~> 1"),
				name: "terraform",
			},
			{
				...pin("terraform", "terraform/deploy/main.tf:2", "~> 1"),
				name: "terraform",
			},
		]);
		expect(merged[0]?.gaps).toEqual([]);
	});

	test("ignores untagged images that carry no version to sync", () => {
		const untagged = {
			...pin("dockerfile", "Dockerfile:1", ""),
			value: undefined,
		};
		const merged = mergeRequirements([
			untagged,
			{ ...untagged, where: "etl/Dockerfile:1" },
		]);
		expect(merged[0]?.gaps).toEqual([]);
	});

	test("does not flag one file pinning the same base twice", () => {
		const merged = mergeRequirements([
			pin("dockerfile", "Dockerfile:1", "10.0"),
			pin("dockerfile", "Dockerfile:9", "10.0"),
		]);
		expect(merged[0]?.gaps).toEqual([]);
	});

	test("unions phases and keeps the highest-priority source", () => {
		const [merged] = mergeRequirements([
			requirement({
				name: "SF_KEY",
				phase: ["dev"],
				source: ".env",
				where: ".env:3",
			}),
			requirement({
				name: "SF_KEY",
				phase: ["run"],
				source: "secrets-mgr",
				where: "terraform/deploy/main.tf:88",
			}),
		]);
		expect(merged?.source).toBe("secrets-mgr");
		expect(merged?.phase).toEqual(["dev", "run"]);
	});

	test("keeps same-named requirements of different types apart", () => {
		const merged = mergeRequirements([
			requirement({ type: "SECRET", name: "SHARED" }),
			requirement({ type: "CONFIG", name: "SHARED" }),
		]);
		expect(merged.map((r) => r.type).sort()).toEqual(["CONFIG", "SECRET"]);
	});

	test("deduplicates identical gaps raised by two sources", () => {
		const gap = { kind: "undocumented" as const, detail: "same" };
		const [merged] = mergeRequirements([
			requirement({ gaps: [gap] }),
			requirement({ source: "dockerfile", gaps: [gap] }),
		]);
		expect(merged?.gaps).toHaveLength(1);
	});
});

describe("sortRequirements", () => {
	const row = (type: Requirement["type"], name: string, gapped: boolean) =>
		requirement({
			type,
			name,
			phase: ["run"],
			gaps: gapped ? [{ kind: "undocumented", detail: "x" }] : [],
		});

	test("floats gapped rows above clean ones, then orders by type", () => {
		const sorted = sortRequirements([
			row("SECRET", "clean", false),
			row("REGISTRY", "gapped", true),
		]);
		expect(sorted.map((r) => r.name)).toEqual(["gapped", "clean"]);
	});

	test("orders the seven types as the skill renders them, then by name", () => {
		const shuffled: Requirement["type"][] = [
			"REGISTRY",
			"TOOLCHAIN",
			"NETWORK",
			"SERVICE",
			"CLOUD_PERM",
			"CONFIG",
			"SECRET",
		];
		const sorted = sortRequirements([
			...shuffled.map((type) => row(type, "b", false)),
			row("SECRET", "a", false),
		]);
		expect(sorted.map((r) => `${r.type}:${r.name}`)).toEqual([
			"SECRET:a",
			"SECRET:b",
			"CONFIG:b",
			"CLOUD_PERM:b",
			"SERVICE:b",
			"NETWORK:b",
			"TOOLCHAIN:b",
			"REGISTRY:b",
		]);
	});

	test("does not mutate its input", () => {
		const input = [row("REGISTRY", "z", false), row("SECRET", "a", false)];
		sortRequirements(input);
		expect(input.map((r) => r.name)).toEqual(["z", "a"]);
	});
});

describe("sniff", () => {
	test("never emits a value for a secret or config requirement", () => {
		const root = world.tree({
			".env":
				"SF_PRIVATE_KEY=fake-pem-body-1a2b3c\nDB_HOST=fake-host-0d9e.invalid\n",
			".env.sample": "SF_PRIVATE_KEY=\nDB_HOST=\n",
		});
		const found = sniff(root);
		const sensitive = found.filter(
			(r) => r.type === "SECRET" || r.type === "CONFIG",
		);
		expect(sensitive.length).toBeGreaterThan(0);
		expect(sensitive.every((r) => r.value === undefined)).toBe(true);
		expect(JSON.stringify(found)).not.toContain("fake-pem-body-1a2b3c");
		expect(JSON.stringify(found)).not.toContain("fake-host-0d9e.invalid");
	});

	test("returns nothing for a repo with no recognizable surfaces", () => {
		expect(sniff(world.tree({ "README.md": "# hi\n" }))).toEqual([]);
	});

	test("merges one key declared in .env, the sample and Terraform into one row", () => {
		const root = world.tree({
			".env": "SF_PRIVATE_KEY=x\n",
			".env.sample": "SF_PRIVATE_KEY=\n",
			"main.tf":
				'  container_secrets = [\n    { name = "SF_PRIVATE_KEY" },\n  ]\n',
		});
		const rows = sniff(root).filter((r) => r.name === "SF_PRIVATE_KEY");
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			source: "secrets-mgr",
			phase: ["dev", "run"],
		});
	});
});

describe("extractor edge cases", () => {
	test("ignores commented workflow lines", () => {
		const root = world.tree({
			".github/workflows/ci.yml":
				"# role-to-assume: arn:aws:iam::1:role/old\n  # key: ${{ secrets.OLD }}\n  key: ${{ secrets.LIVE }}\n",
		});
		expect(scan(root, extractWorkflows).map((r) => r.name)).toEqual(["LIVE"]);
	});

	test("reads every terraform name on one line", () => {
		const root = world.tree({
			"main.tf":
				'container_environment = [{ name = "A", value = "1" }, { name = "B", value = "2" }]\n',
		});
		expect(scan(root, extractTerraform).map((r) => r.name)).toEqual(["A", "B"]);
	});

	test("reads every ENV pair on a Dockerfile line and keeps quoted values out", () => {
		const root = world.tree({
			Dockerfile: [
				"ENV A=1 B_TOKEN=2",
				'ENV C="x y=z"',
				"ENV LEGACY value",
				"",
			].join("\n"),
		});
		expect(
			scan(root, extractDockerfile)
				.filter((r) => r.type !== "TOOLCHAIN")
				.map((r) => r.name),
		).toEqual(["A", "B_TOKEN", "C", "LEGACY"]);
	});

	test("does not report the scratch base as a toolchain", () => {
		const root = world.tree({ Dockerfile: "FROM scratch\nFROM alpine:3.20\n" });
		expect(scan(root, extractDockerfile).map((r) => r.name)).toEqual(["alpine"]);
	});

	test("reads published compose ports with a host address and ignores other list items", () => {
		const root = world.tree({
			"compose.yaml": [
				"services:",
				"  web:",
				"    ports:",
				'      - "127.0.0.1:8080:80"',
				"      - 9000-9010:90",
				"    volumes:",
				"      - 1:2",
				"",
			].join("\n"),
		});
		expect(
			scan(root, extractCompose)
				.filter((r) => r.type === "NETWORK")
				.map((r) => r.name),
		).toEqual([":8080 published", ":9000 published"]);
	});

	test("reads mise inline-table and quoted-key pins", () => {
		const root = world.tree({
			"mise.toml": [
				"[tools]",
				'node = { version = "20" }',
				'"npm:pnpm" = "9"',
				"",
			].join("\n"),
		});
		expect(
			scan(root, extractToolchain).map((r) => [r.name, r.value]),
		).toEqual([
			["node", "20"],
			["npm:pnpm", "9"],
		]);
	});

	test("writes a stderr note when package.json cannot be parsed", () => {
		const root = world.tree({ "package.json": "{ not json" });
		const write = process.stderr.write.bind(process.stderr);
		let seen = "";
		process.stderr.write = ((chunk: string) => {
			seen += chunk;
			return true;
		}) as typeof process.stderr.write;
		try {
			expect(scan(root, extractToolchain)).toEqual([]);
		} finally {
			process.stderr.write = write;
		}
		expect(seen).toContain("could not parse package.json");
	});

	test("writes a stderr note when a file cannot be read for a reason other than absence", () => {
		const root = world.tree({ ".env/inner": "A=1\n" });
		const write = process.stderr.write.bind(process.stderr);
		let seen = "";
		process.stderr.write = ((chunk: string) => {
			seen += chunk;
			return true;
		}) as typeof process.stderr.write;
		try {
			expect(readText(join(root, ".env"))).toBeNull();
			expect(readText(join(root, "missing"))).toBeNull();
		} finally {
			process.stderr.write = write;
		}
		expect(seen).toContain("could not read");
		expect(seen.match(/could not read/g)).toHaveLength(1);
	});
});

describe("mergeRequirements pins and permissions", () => {
	const pin = (where: string, value: string, source = "dockerfile") =>
		requirement({ type: "TOOLCHAIN", name: "node", value, source, where });

	test("keeps IAM resources that share a local name apart", () => {
		const merged = mergeRequirements([
			requirement({
				type: "CLOUD_PERM",
				name: "this",
				value: "aws_iam_role",
				source: "terraform",
				where: "main.tf:1",
			}),
			requirement({
				type: "CLOUD_PERM",
				name: "this",
				value: "aws_iam_role_policy",
				source: "terraform",
				where: "main.tf:5",
			}),
		]);
		expect(merged.map((r) => r.value).sort()).toEqual([
			"aws_iam_role",
			"aws_iam_role_policy",
		]);
	});

	test("flags conflicting stages inside one Dockerfile", () => {
		const [merged] = mergeRequirements([
			pin("Dockerfile:1", "18"),
			pin("Dockerfile:9", "20"),
		]);
		expect(merged?.gaps[0]?.detail).toContain("conflicting pins");
	});

	test("compares exact pins even when another source pins a range", () => {
		const [merged] = mergeRequirements([
			pin("Dockerfile:1", "20"),
			pin(".nvmrc:1", "18", "nvmrc"),
			pin("package.json:4", ">=18", "package.json"),
		]);
		expect(merged?.gaps[0]?.detail).toContain("conflicting pins");
	});

	test("sorts names by plain code point order", () => {
		const names = ["b", "B", "a"].map((name) =>
			requirement({ type: "SECRET", name }),
		);
		expect(sortRequirements(names).map((r) => r.name)).toEqual(["B", "a", "b"]);
	});
});
