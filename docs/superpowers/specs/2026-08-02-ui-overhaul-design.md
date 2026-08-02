# UI Overhaul: Board, Launch Flow, Drawer — Validated Design

## Problem

Mission Control's UI was built to prove the reconciler worked. It shows the
right facts, but it does not shape them: every surface weights everything
equally, so the operator does the sorting by eye.

Three concrete failures, in the order they cost the most:

**The launch flow is opaque.** The "Run a phase" section leads with a blank
62px textarea labelled "Extra instructions for this run (optional)", above a
row of five equal phase buttons. Text typed there is substituted into a
`{{customInstructions}}` placeholder at the bottom of a command file the
operator never sees (`prompt.ts:84`). The result is that the box goes unused:
you cannot tell what the agent was already told, so you cannot tell what is
worth adding. When you do want to write something substantial, the box is too
small to work in. And by sitting above the buttons, the optional input
outranks the action you actually came to perform.

**The board does not answer its own question.** Nine lanes (`inbox`, `plan`,
`implement`, `publish`, `ci`, `copilot_review`, `dev_review`, `merge`, `done`)
share the width equally at `flex: 1 1 0`, so on a 1080p screen each lane is
~210px whether it holds four cards or none. With 10–20 tasks in flight the
busy lanes truncate their titles while empty lanes hold open a fifth of the
screen. "What needs me?" — the only question a glance should have to answer —
is behind a filter button and a click.

**The drawer has no hierarchy.** Nine sections, one 480px scroll, identical
visual weight: Status, Run a phase, Pinned agent, Mark progress, Placement,
Plan, Artifacts, Sessions & usage, Workspace. Placement (set once a month)
shouts as loudly as Run a phase (every visit). "Open in VS Code" — a daily
action — is at the bottom, adjacent to two destructive buttons.

## Goals

- Make the resolved prompt visible before launch, and give instructions a
  writing surface that grows to fit the thought.
- Let a glance at the board answer "does anything need me?" with no clicks.
- Give the busy lanes the width, and stop empty lanes from taking a share.
- Rank the drawer by how often each thing is touched.

## Non-goals

- **No change to what gets spawned.** Prompt assembly, agent resolution,
  worktree handling and the reconciler are untouched. This is a UI change with
  one additive read-only endpoint.
- **No persistent per-task instructions.** `spawn.ts:270` falls back to
  `task.overrides.instructions`, a durable per-task instruction that no UI has
  ever set. It stays unreachable and the fallback stays as written: the
  operator's use is one-off context per run, and a standing instruction that
  silently rides along on every future spawn is a worse default than retyping.
  Recorded here so the dead branch is not mistaken for an oversight later.
- **No drag-and-drop, no auto-import, no search.** Unchanged from
  `2026-07-21`.
- **No new agent behaviour.** Nothing here asks an agent to do anything.

## Decisions

Reached by walking mockups; each was chosen against at least two alternatives.

| Area | Chosen | Rejected |
| --- | --- | --- |
| Board | Attention rail + dense 9-lane kanban | Stage grouping (4 columns); urgency-sorted list |
| Launch | Phase first, then compose | Inline box; always-on preview; split button |
| Preview | On demand, behind a button | Embedded in the compose view |
| Fast path | None — two clicks always | Ctrl+click launch; per-phase "launch now" |
| Drawer | Tabs, permanent header | Ranked scroll; two-column at 760px |
| Width | Drag-resizable, persisted, 620px default | Fixed 620px; fixed 760px |

---

## 1. The launch flow

The centrepiece. Replaces the "Run a phase" section with a two-step flow.

### Step 1 — choose the phase

The section shows only the spawnable phase buttons. The phase the task
currently sits in (`derived.derivedPhase`) is marked with an underline, as a
hint rather than a default — every phase stays clickable, per the existing
principle that the human is the manager and may re-run any step.

Clicking a phase does **not** launch. It opens the compose view for that
phase.

### Step 2 — compose

Replaces the section body in place (not a modal). Contains:

- A breadcrumb — `← Run a phase › Implement` — where the arrow returns to
  step 1.
- The resolved agent for this phase as a chip (`claude · opus · high`) with a
  `change` affordance opening the existing one-time `AgentPicker`.
- The instructions textarea, empty and ~38px tall, **auto-growing** with its
  content to a maximum of 40% of the drawer's height, after which it scrolls
  and the `⛶ Full window` button is the intended escape.
- `⛶ Full window` and `👁 Preview prompt` on the left, below the box.
- `▶ Launch <Phase>` as the primary button on the right.
- A word count and a `Ctrl+Enter launches` hint.

**Two clicks to launch, always, with no shortcut.** This was chosen
deliberately over Ctrl+click and over a separate "launch now" button for the
current phase. A single consistent path is worth more than a saved click on a
tool used a few dozen times a day, and a phase button that sometimes launches
and sometimes composes is the kind of ambiguity that costs an accidental
spawn.

### Full window

A full-screen editor over the drawer, reusing the `PlanEditor` scrim pattern
already in the codebase. Header carries `👁 Preview`, `▶ Launch` and `Close`,
so the flow never forces a round trip back to the drawer. Escape closes;
unlike `PlanEditor` there is no dirty-state confirm, because the text is not
persisted anywhere and closing returns to the compose box with it intact.

### Preview prompt

Shows the **actual, fully-resolved text the agent will receive** — the command
file rendered with this task's issue, title, branch, plan path and worktree,
exactly as `buildPrompt` produces it. The operator's instructions are rendered
in place, highlighted, so it is visible both *that* they land and *where*.
Header shows the source command and a word count (`mc-implementer · 141
words`). A `← Back to editing` returns.

This is the fix for "too vague to trust". The reason the box goes unused is
that its relationship to the rest of the prompt is invisible; showing the
whole thing with the contribution highlighted makes the box's purpose
self-evident.

### New endpoint

```
POST /api/tasks/:issue/prompt   { phase, instructions? }  →  { text, command, words }
```

Read-only: resolves the phase, agent and command the same way `spawnPhase`
does, calls `buildPrompt`, returns the string. **Writes nothing** — no
`writePromptFile`, no `writePlanSnapshot`, no spawn record. The existing
resolution logic in `spawn.ts` is extracted into a small shared helper so
preview and spawn cannot drift apart; a preview that does not match what
launches is worse than no preview.

Errors surface in the preview pane rather than as a toast — a missing command
file is exactly the thing preview should reveal.

---

## 2. The board

### Attention rail

A permanent strip between the topbar and the lanes, holding only tasks where
`derived.needsYou` is true, at full card width with the reason spelled out
(`⚠ changes requested by @reviewer`) and a phase chip. Heading is
`Needs you — 3`.

When nothing needs attention the rail collapses to nothing. Its emptiness is
the signal: from across the room, no orange means no action. This is what
makes the board answer its question without a click.

Cards appear both in the rail and in their lane. That duplication is
intentional — the rail is a view of urgency, the lane is a view of position,
and a task genuinely has both.

The rail replaces the topbar's `Needs you · N` toggle, which becomes
redundant.

### Lane sizing

Lanes stop being uniform. An empty lane collapses to a fixed ~22px vertical
rail showing its rotated name. Non-empty lanes divide the remaining width by
`flex-grow: 1 + min(cardCount, 4) * 0.3` — so a lane holding four cards gets
roughly twice the share of a lane holding one, and the weighting saturates so
one busy lane can never starve the others. A collapsed lane still accepts a
click to open its phase default, and still shows in the same order — the
pipeline reads left to right exactly as before.

With the realistic distribution (most tasks pooled in `implement`, `ci` and
the two review lanes) this roughly doubles the working width of the lanes that
matter and stops titles truncating.

### Card density

One line of padding comes out; the issue number and agent chip share a row
with tighter leading. No information is removed — the left border colour and
single status line remain the whole state, per `Card.tsx`'s existing contract.

---

## 3. The drawer

### Permanent header

Never scrolls, never switches: issue number, issue/PR links, title, branch,
the agent chip, the status badges, `✎ VS Code`, and `Close`. Status is
therefore always visible regardless of which tab is open — the reason tabs are
affordable here at all.

`Open in VS Code` moves up from the Workspace section into this header; it is
a daily action currently buried beside `Remove worktree` and `Remove from
board`.

### Tabs

| Tab | Holds | Opens on |
| --- | --- | --- |
| **Run** | The launch flow (§1), Mark progress | always, on open |
| **Plan** | Plan (read + edit), Artifacts | — |
| **History** | Sessions & usage, spawn history | — |
| **Setup** | Pinned agent/model/effort, Placement, Workspace + destructive actions | — |

Tab state resets to **Run** on every task switch. The drawer's job on open is
"launch something"; remembering that you were last on History is not a
service.

`Plan` carries a `●` when a plan exists; `History` carries the run count.
Destructive actions (`Remove worktree`, `Remove from board`) sit at the bottom
of Setup, two tabs away from anything routine.

### Width

Drag-resizable from the left edge. Defaults to 620px (up from 480), persisted
to `localStorage` under `mc-drawer-width`, clamped to
`[420px, min(1100px, 90vw)]`. Restored on load.

---

## 4. The topbar

Tidying only, no new features.

- The `Needs you · N` toggle is removed — the rail supersedes it.
- `Refresh` becomes the `checked 8s ago` readout itself: it already means
  "freshness", so clicking it to force a reconcile is the obvious gesture, and
  it reclaims a button.
- Remaining controls group as: primary (`+ New from issue`), secondary
  (`Agents`, notification bell), then the status cluster (`checked …`, API
  budget, live lamp) pushed right and visually quieted.

---

## 5. Component structure

The drawer is 469 lines and will not survive absorbing a launch flow. It
splits along the tab seams:

```
components/
  Drawer.tsx          shell: header, tab strip, width drag, task-switch reset
  drawer/
    RunTab.tsx        phase list ⇄ compose view, mark-progress
    LaunchCompose.tsx compose box, grow behaviour, full-window + preview
    PromptPreview.tsx resolved prompt with instructions highlighted
    PlanTab.tsx       plan + artifacts
    HistoryTab.tsx    usage + spawn history
    SetupTab.tsx      pin, placement, workspace, destructive actions
  AttentionRail.tsx   needs-you strip
```

Each is small enough to hold in one view, and each has one reason to change.
`Board`, `Lane`, `Card`, `AgentPicker` and `PlanEditor` keep their current
responsibilities; `Lane` gains a collapsed rendering, `Card` gets denser
styling, neither changes its interface.

## Build order

Three stages, each independently shippable and independently useful. The
drawer split (§5) happens first inside stage 1, because the launch flow has
nowhere to live until it does.

1. **Drawer shell + launch flow** — split `Drawer.tsx`, add the tabs and the
   resizable width, build the phase→compose flow, add the preview endpoint.
   This is the bulk of the work and the thing that was actually asked for.
2. **Board** — attention rail, lane collapsing, card density.
3. **Topbar** — tidying, which is mostly deletion and depends on the rail
   existing.

## Testing

The reconciler is the tested surface and this change does not touch it.

- **Unit:** the prompt-resolution helper extracted from `spawn.ts` — same
  phase, agent and command for a given task under both preview and spawn.
- **Unit:** lane width allocation — empty lanes collapse, non-empty lanes
  divide the remainder, order preserved.
- **Unit:** attention-rail membership matches `derived.needsYou`, the same
  predicate `needsYouIssues` already uses for notifications.
- **Manual:** launch each phase from compose and confirm the spawned terminal
  receives exactly the text preview showed.

## Risks

- **Preview drifting from reality.** Mitigated by the shared helper; if the
  two ever diverge the preview becomes actively harmful. This is the one thing
  worth a test.
- **Two clicks becoming irritating.** Accepted explicitly. If it does grate,
  Ctrl+click is a one-line addition later — but shipping it now would
  undercut the consistency the flow was chosen for.
- **Rail eating vertical space** on a short window. It is bounded to one row
  of cards and scrolls horizontally past three.
