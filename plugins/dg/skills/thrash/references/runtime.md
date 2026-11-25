# Runtime and skill paths

Every call works alone in a fresh shell, including delegated execution and
resumed commands. Use the
host's existing narrow approvals for the specific operation and honor permission
already granted in this session. Do not edit permission files or assume that the
compiled binary grants blanket approval to its subcommands.

Resolve cross-skill instructions from this installed tree: `../proxy/SKILL.md`
and `../address/SKILL.md` from this directory, `../../<skill>/SKILL.md` from
`references/`. An explicitly configured `DG_PERSONAL_SKILLS_DIR` may supply an
unmigrated skill. Pass real absolute paths to delegates and report missing
instructions. Resolve the `thrash` persona through the host's configured registry
or `DG_PERSONAS_DIR` / `DG_AGENTS_DIR`; never assume a private agent directory.
The plugin ships its personas in `agents/` (Claude Code loads them as
`dg:<name>`; `dg proxy` embeds them), so use those when the host has none.
