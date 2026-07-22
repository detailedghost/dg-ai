# @dg/skills-cli

Standalone CLI for dg AI skills. Single entry point registers all skill subcommands.

## Usage (from source)

```bash
bun pkg/skills-cli/src/index.ts --help
bun pkg/skills-cli/src/index.ts browser install
bun pkg/skills-cli/src/index.ts browser demo my-feature.demo.md --video
```

## Build standalone binary

```bash
cd pkg/skills-cli
bun run build       # produces dist/dg-skills (current platform)
```

Pre-built binaries for Linux x64, macOS arm64, and Windows x64 are published to [GitHub Releases](https://github.com/detailedghost/dg-ai/releases) as `skills-vX.X.X`.

## Dev Commands

```bash
bun run lint        # tsc --noEmit
bun test            # unit tests
```
