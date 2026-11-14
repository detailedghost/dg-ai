# Plan walkthrough

Build **one clickable walkthrough** that covers every workflow in a plan, with a screen
for each. The question isn't what one page looks like. It's whether the workflows hang
together as one product.

Use it when the input is a plan that spans several workflows: a plan or spec the user
pasted or uploaded, a design seed, or a feature description with several distinct user and
system flows.

## 1. Inventory the workflows

Read the plan and list its **distinct workflows**. Each becomes one screen. Take them from
the plan's own structure, its phases, slices, headings and actors, and don't invent any.
Put the list at the top of your reply, one line per screen, so coverage can be checked.

A typical set is the authoring flow, the list view, the processing or run view, and a short
**"how it maps to code"** screen. One screen per real workflow, no padding.

## 2. Build the screens

```html
<section class="dg-item" data-key="author" data-workflow="Workflows" data-label="Write a rule">…</section>
<section class="dg-item" data-key="list" data-workflow="Workflows" data-label="All rules">…</section>
<section class="dg-item" data-key="code" data-workflow="Reference" data-label="How it maps to code">…</section>
```

- Set `"kind": "walkthrough"` in the chain JSON.
- `data-workflow` groups screens in the bar's jump menu. `data-label` names the screen.
- The bar's arrows and the arrow keys walk the screens in order.

## 3. Give each screen real fidelity

- Plausible seed data in the plan's own vocabulary.
- Make the load-bearing interaction work: the create form fills in and shows the new record,
  and the run view animates and shows success or failure per item. Static mockups hide the
  coherence problems a walkthrough exists to find.
- The "how it maps to code" screen lists each workflow and the files and seams it lands on,
  taken from the plan.

## 4. Decisions

A walkthrough has no variants to pick between. The decision covers the whole plan:

- `approve`: the design holds. Offer to write the spec or PRD next, with any notes folded in.
- `tweak <screen key>: <note>`: change one screen in place.
- `reject: <note>`: rework the walkthrough against the notes. In the next round's chain
  history, note which screens changed, and say so in the reply.

The bar's note box carries the reaction to the screen being viewed, prefixed with that
screen's key.
