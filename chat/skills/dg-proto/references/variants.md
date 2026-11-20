# UI variants

Generate **several radically different UI variants** of one page or component. The user
flips between them with the bar, picks one, or takes bits from each, and the rest are
thrown away.

## Count and names

- The default is **5 variants**, keyed `A` to `E`.
- `-n <count>` sets the number, 1 or more. Keys run `A`, `B`, …, `Z`, then `AA`, `AB`, ….
- `-o "<a>,<b>"` names the directions. Build exactly one variant per name, in the order
  given, with that name as its label. `-o` overrides `-n`. Two names mean two variants.

## Markup

```html
<section class="dg-item" data-key="A" data-label="Stacked form">
  <div data-verify-root="signup-form">…the feature…</div>
</section>
```

- One `.dg-item` per variant, with a unique `data-key` and a short `data-label`.
- Wrap the feature in exactly one element marked `data-verify-root="<prototype name>"`.
- Give every control that shows record data a `data-testid`.
- Scope each variant's CSS under its own section, such as `[data-key="A"] .card`, so
  variants can't restyle each other or the bar.

## Make them really different

Each variant keeps the page's purpose and data, but differs in **structure**: layout,
information hierarchy, and primary affordance. Changing only colors or copy is a tweak,
not a variant. If two drafts come out alike, redo one with an explicit constraint, such
as "no card grid".

Avoid sharing too much between variants. A shared header is fine, a shared layout defeats
the point.

## Fidelity

- **Host page.** When the thing being prototyped lives inside a page (a new card, a new step
  in a flow), rebuild the surrounding page once from what the user shared and put each
  variant inside it. A variant judged in an empty frame looks fine every time.
- **Seed data.** Use realistic names, numbers, statuses and the product's own vocabulary.
- **Read-only.** Interactions can change local state, but nothing is saved or sent anywhere.

## Motion variants

When the question is how something moves, the variants are timing and easing, not layouts:

- Add a **Replay** button in each variant. Reset to the start with the transition off,
  force a reflow, turn the transition back on, then trigger inside a double
  `requestAnimationFrame`.
- Honor `prefers-reduced-motion: reduce` with one global override in every variant.
- If the user shared a screenshot of the host page, use it as the stage background so the
  timing reads against real density.

## Next rounds

After `approve C: <note>`, the next round's variants all start from C and change **only**
what the note asks. Keep everything else in C exactly as it was. Don't apply "radically
different" to the parts the note didn't mention.
