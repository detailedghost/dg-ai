# Logic model

An interactive page where the user drives a state model by hand. Use it when the question
is about **business logic, state transitions or data shape**: the kind of thing that looks
fine on paper and only feels wrong once you push it through real cases.

## 1. State the question

Write one paragraph at the top of the page: which model, what question, and what would count
as an answer. Put the same question in the chain JSON's `question`.

## 2. Keep the logic portable

Put the logic behind a small, pure interface in its own `<script>` block, so it could be
lifted into the real codebase later:

- **A reducer**, `(state, action) => state`, when actions are discrete events.
- **A state machine** with explicit states and transitions, when "which actions are legal
  right now" is part of the question.
- **A few pure functions** over a plain data type, when there's no current state.

No DOM code inside the logic block. The page calls into it, and nothing flows back.
When the user writes in a language other than JavaScript, mirror their names and shapes so
the port is mechanical.

## 3. Build the smallest page that shows the state

One `.dg-item` with `data-key="model"`, and `"kind": "logic"` in the chain JSON. On the page:

1. **Current state**, pretty-printed one field per line, with changed fields highlighted
   after each action.
2. **One button per action**, disabled when the action is illegal in the current state, with
   a short reason on hover.
3. **A log** of every action and the resulting state, newest first, with a Reset button.
4. **Preset scenarios** for the edge cases the question is about, such as "X then Y", that
   replay a sequence of actions one at a time.

Use the theme tokens and `--dg-mono` for state and log text.

## 4. Decisions

- `approve`: the model holds. Give the logic block back as a code block, ready to lift.
- `tweak: <note>`: change the model in place and keep the log.
- `reject: <note>`: rework the model against the note.
