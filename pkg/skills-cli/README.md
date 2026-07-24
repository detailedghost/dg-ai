# @dg/skills-cli

Standalone CLI for dg AI skills. One entry point registers all skill commands.

## Usage (from source)

```bash
bun pkg/skills-cli/src/index.ts --help
bun pkg/skills-cli/src/index.ts browser install
bun pkg/skills-cli/src/index.ts browser demo my-feature.demo.md --video
bun pkg/skills-cli/src/index.ts proto scrape https://app.example.test/page
bun pkg/skills-cli/src/index.ts proto plant /tmp/ai/proto/example/plan.json
bun pkg/skills-cli/src/index.ts proto cleanup example
```

The `proto` workflow requires the companion extension. `scrape` and `plant`
exchange local files through the browser's Downloads directory and block until
the extension responds. Run `plant` and `cleanup` from the target project root;
an approved answer is preserved under `.agents/prototype/<slug>/`.

## Build standalone binary

```bash
cd pkg/skills-cli
bun run build       # produces dist/dg-skills (current platform)
```

Pre-built binaries for Linux x64, macOS arm64, and Windows x64 appear in
[GitHub Releases](https://github.com/detailedghost/dg-ai/releases) as
`skills-vX.X.X`.

## Development commands

```bash
bun run lint        # tsc --noEmit
bun test            # unit tests
```
