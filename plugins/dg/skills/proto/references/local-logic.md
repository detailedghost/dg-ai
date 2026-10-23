# Logic prototype

A tiny interactive terminal app that lets the user drive a state model by hand. Use it when the question is about **business logic, state transitions, or data shape**: the kind of thing that looks reasonable on paper and only feels wrong once you push it through real cases.

## When this is the right shape

- "I am not sure this state machine handles the edge case where X then Y."
- "Does this data model let me represent the case where..."
- "I want to feel out what the API should look like before writing it."
- Anything where the user wants to press keys and watch state change.

If the question is what something should look like, use [local-ui.md](local-ui.md).

## Process

### 1. Pick the location and state the question

The default location is `.agents/prototype/<name>/` (see [local-build.md](local-build.md)). Under `--light` it is the scratch directory. On first use of `.agents/prototype/` in a project, make sure the path is gitignored before you write into it.

Inside `<name>/`, write a `NOTES.md` (or a top-of-file doc comment in the script) with one paragraph: which state model, what question, and what would count as an answer. A logic prototype that answers the wrong question is pure waste. Make the question explicit so it can be checked later, whether the user is watching or returns to it unattended.

### 2. Pick the language

Use whatever the host project uses. If it has no obvious runtime (a docs repo, for example), ask. Match the project's tooling. Do not add a package manager or runtime for the prototype.

### 3. Isolate the logic in a portable module

Put the logic that answers the question behind a small, pure interface that could be lifted into the real codebase later. The terminal app around it is throwaway. The logic module is not.

The right shape depends on the question:

- **A pure reducer**, `(state, action) => state`. Good when actions are discrete events and state is one value.
- **A state machine** with explicit states and transitions. Good when "which actions are legal right now" is part of the question.
- **A small set of pure functions** over a plain data type. Good when there is no implicit current state.
- **A class or module with a clear method surface** when the logic owns ongoing internal state.

Pick the shape that fits the question, not the one that is easiest to wire to a terminal. Keep it pure: no I/O, no terminal code, no `console.log` for control flow. The terminal app imports it and calls into it. Nothing flows the other direction. When the question is answered, the validated reducer, machine, or functions lift into the real module and the terminal shell is deleted.

### 4. Build the smallest terminal app that exposes the state

Build a lightweight terminal UI. On every tick, clear the screen (`console.clear()` or the equivalent) and re-render the whole frame. The user always sees one stable view, not growing scrollback.

Each frame has two parts, in this order:

1. **Current state**, pretty-printed and diff-friendly: one field per line, or formatted JSON. Use bold for field names and section headers and dim for less important context (timestamps, IDs, derived values). Native ANSI escapes are fine: `\x1b[1m` bold, `\x1b[2m` dim, `\x1b[0m` reset. Add no styling library unless the project already has one.
1. **Keyboard shortcuts** at the bottom: `[a] add user  [d] delete user  [t] tick clock  [q] quit`.

Behavior:

1. Initialize state as one in-memory object. Render the first frame on start.
1. Read one keystroke (or one line) at a time and dispatch to a handler that updates state.
1. Re-render the full frame after every action. Replace, never append.
1. Loop until quit.

The whole frame fits on one screen.

### 5. Make it runnable in one command

Add a script to the project's existing task runner (`package.json` scripts, `Makefile`, `justfile`, `pyproject.toml`) that points at the file under `.agents/prototype/<name>/`. The user runs `pnpm run <prototype-name>` or the equivalent and never needs the path. Under `--light`, skip the task runner and print the exact command to run, so the project's task list is not polluted with a path that vanishes on reboot. If the project has no task runner, put the command at the top of `NOTES.md`.

### 6. Hand it over

Give the user the run command. They drive it themselves. The interesting moments are "wait, that should not be possible" and "huh, I assumed X would be different". Those are the bugs in the idea, which is the whole point. If they want new actions, add them. Prototypes evolve.

### 7. Capture the answer

When the prototype has done its job, the answer is the only thing worth keeping. If the user is around, ask what it taught them. If not, leave a `NOTES.md` next to the prototype so the answer can be filled in before the prototype is deleted.

## Anti-patterns

- **Do not add tests.** A prototype that needs tests is no longer a prototype.
- **Do not wire it to the real database.** Use an in-memory store unless the question is specifically about persistence.
- **Do not generalize.** No "what if we wanted to support X later". The prototype answers one question.
- **Do not blur the logic and the terminal app.** If the reducer or state machine references `console.log`, prompts, or escape codes, it is no longer portable.
- **Do not ship the terminal shell into production.** It is built to be driven by hand. The logic module behind it is the part worth keeping.
