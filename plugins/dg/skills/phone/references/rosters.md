# Machines and rosters

One phone is one machine. Claude Code (`/dg:phone` or a skills-only install), Codex (this skill under `$CODEX_HOME/skills/phone`, or the pointer in `AGENTS.md`), and a Grok Bot all use the same commands. Setup names this agent from the session that is already running:

- Claude: a real title on the session file under `~/.claude/sessions` (`customTitle`, else `summary` / `aiTitle`, else `name`) for `CLAUDE_CODE_SESSION_ID` (or `CLAUDE_SESSION_ID`)
- Codex: a real title on the `CODEX_THREAD_ID` row of `$CODEX_HOME/session_index.jsonl` (`customTitle`, else `title`, else `summary` / `aiTitle`, else `thread_name` when that is a short title and not the prompt)
- Grok: `GROK_AGENT_NAME`, or else `GROK_BOT_NAME`, or a `title` / `name` on a JSON file under `~/.grok/agents`
- a dg session's `agentIdentity`, when none of those is set

A placeholder (`agent`, `default`) or no name at all leaves the self name `dg`. A prompt excerpt is not slugged into a handle. When the runtime stored a short summary, that is the handle. Otherwise it is `<runtime>-` plus the first letters and digits of the session id, such as `codex-019a3f2c1111`. `--as` still wins, and a self name already saved is kept. The handle is the name in lowercase, with spaces turned into dashes.

The roster lists agents that are live or active. The session this process is running is always included. Any other session needs activity within the last 24 hours (a Codex `updated_at`, or the session file's modification time). A row with no timestamp stays, because the runtime did not say it was old. When more than 16 qualify, the current one is kept and the rest are the most recently active, with a handle tie broken in alphabetical order. The same 16-agent wire cap applies.

On `accept`, while roster exchange is on, this machine sends that roster over the same encrypted NIP-17 channel. The invitee answers with its own roster. Each side saves the far machine's agents as contacts. A later new session is sent again, once, after a short quiet period, and only when the roster changed. An update is accepted only from a machine already in your contacts. `phone roster off` stops the send on accept, on an invite admit, and on that update, and drops incoming kind 25018 rosters without importing them or holding them. Texts still arrive. `phone roster` with no argument prints the setting. It is on by default, and `status` shows it as `roster`.

The roster is kind 25018, version 1: `{"v":1,"agents":[{"handle":"dante","npub":"npub1…","runtime":"claude"}]}`. `runtime` is `claude`, `codex`, `grok`, or `dg`. It is a label, not a credential. A peer that does not know kind 25018, including an older dg plugin, ignores it. Texts still flow. Cards and keys are not in the roster and are not logged.

```bash
dg phone close --with +box --clear   # drops contacts that +box's roster added; the listener stays up
```

`+box` is the machine you paired, or any agent that came from it. The command drops only contacts that arrived `via: "roster"` from that machine. The machine's own contact stays, whether you added it with `accept` or it arrived through your `invite`. Contacts you added yourself, and contacts from any other machine, stay. The next `accept` with that machine fetches a fresh roster when roster exchange is on. `phone roster off` does not change what `--clear` removes.

