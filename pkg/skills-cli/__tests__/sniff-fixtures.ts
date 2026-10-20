import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Requirement } from "../src/sniff";
import { git, scratchFixtures } from "./git-repo-fixtures";
import { mergeEnv } from "./module-call";

export const SNIFF_ENTRY = join(import.meta.dir, "../src/index.ts");

export const FAKE = {
	envSecret: "fake-env-secret-4f9a1c7e",
	envQuoted: "fake-env-quoted-8b2d6e30",
	envConfig: "fake-env-config-host-51c0.invalid",
	tfConfig: "fake-tf-config-region-9d41",
	tfSecret: "fake-tf-secret-arn-suffix-7a3e",
	dockerSecret: "fake-docker-secret-2e8f5b",
	dockerConfig: "fake-docker-config-mode-6c19",
	dockerBuildArg: "fake-docker-buildarg-3a7d",
	ciLiteral: "fake-ci-literal-password-b5e2",
	npmUser: "fake-npm-feed-user-7d20",
	npmPassword: "fake-npm-feed-password-c41e",
	nugetUser: "fake-nuget-feed-user-1b86",
	nugetPassword: "fake-nuget-feed-password-e9a3",
} as const;

export const FAKE_VALUES: string[] = Object.values(FAKE);

export interface SniffRun {
	stdout: string;
	stderr: string;
	exitCode: number;
}

export interface SniffJson {
	repo: string;
	total: number;
	gaps: number;
	counts: Record<string, number>;
	requirements: Requirement[];
}

export function secretBearingTree(): Record<string, string> {
	return {
		".env": [
			`SF_PRIVATE_KEY=${FAKE.envSecret}`,
			`DB_HOST=${FAKE.envConfig}`,
			`API_TOKEN="${FAKE.envQuoted}"`,
			`STRAY_FLAG=on`,
			"",
		].join("\n"),
		".npmrc": `registry=https://${FAKE.npmUser}:${FAKE.npmPassword}@npm.example.test/\n`,
		"nuget.config": `<add key="feed" value="https://${FAKE.nugetUser}:${FAKE.nugetPassword}@nuget.example.test/index.json?token=${FAKE.nugetPassword}" />\n`,
		".env.sample": "SF_PRIVATE_KEY=\nDB_HOST=\nAPI_TOKEN=\n",
		"terraform/deploy/main.tf": [
			"  container_environment = [",
			`    { name = "APP_REGION", value = "${FAKE.tfConfig}" },`,
			"  ]",
			"  container_secrets = [",
			`    { name = "DB_PASSWORD", valueFrom = "arn:aws:secretsmanager:us-east-1:000000000000:secret:${FAKE.tfSecret}" },`,
			"  ]",
			'resource "aws_secretsmanager_secret" "api" {',
			"}",
			"",
		].join("\n"),
		Dockerfile: [
			"FROM alpine:3.20",
			`ARG BUILD_PASSWORD=${FAKE.dockerBuildArg}`,
			`ENV SERVICE_TOKEN=${FAKE.dockerSecret}`,
			`ENV APP_MODE=${FAKE.dockerConfig}`,
			"EXPOSE 8080",
			"",
		].join("\n"),
		".github/workflows/ci.yml": [
			"env:",
			"  DEPLOY_TOKEN: ${{ secrets.DEPLOY_TOKEN }}",
			`  STATIC_PASSWORD: ${FAKE.ciLiteral}`,
			"jobs:",
			"  build:",
			"    steps:",
			"      - uses: docker/login-action@v3",
			"        with:",
			"          registry: registry.example.test",
			"          password: ${{ secrets.REGISTRY_PASSWORD }}",
			"",
		].join("\n"),
	};
}

export function requirement(overrides: Partial<Requirement> = {}): Requirement {
	return {
		type: "SECRET",
		name: "SAMPLE_KEY",
		phase: ["dev"],
		source: ".env",
		where: ".env:1",
		proven: true,
		gaps: [],
		...overrides,
	};
}

export function sniffWorld(
	command: string[] = [process.execPath, "run", SNIFF_ENTRY],
) {
	const fixtures = scratchFixtures();
	const home = fixtures.tmp("sniff-home-");

	function env(extra: Record<string, string | undefined> = {}) {
		return mergeEnv({
			HOME: home,
			XDG_STATE_HOME: undefined,
			GIT_CONFIG_GLOBAL: "/dev/null",
			GIT_CONFIG_NOSYSTEM: "1",
			LC_ALL: "C",
			...extra,
		});
	}

	function tree(files: Record<string, string>, prefix = "sniff-repo-") {
		const root = realpathSync(fixtures.tmp(prefix));
		for (const [path, body] of Object.entries(files)) {
			const full = join(root, path);
			mkdirSync(dirname(full), { recursive: true });
			writeFileSync(full, body);
		}
		return root;
	}

	function repo(files: Record<string, string>) {
		const root = tree(files);
		git(["init", "-q", "-b", "main"], root);
		return root;
	}

	async function sniff(
		args: string[],
		cwd: string,
		extra: Record<string, string | undefined> = {},
	): Promise<SniffRun> {
		const proc = Bun.spawn([...command, "sniff", ...args], {
			cwd,
			env: env(extra),
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		return { stdout, stderr, exitCode };
	}

	return {
		fixtures,
		home,
		env,
		tree,
		repo,
		sniff,
		tmp: fixtures.tmp,
		cleanup: () => fixtures.cleanup(),
	};
}
