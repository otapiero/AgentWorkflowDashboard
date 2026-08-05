# Document Workbench — Validated Design

## Problem

Mission Control captures every file a planning run produces
(`2026-07-26-plan-artifact-capture-design.md`), but the board can only *read*
one of them. Two separate gaps, one root cause:

1. **The plan editor is cramped.** `PlanEditor` is a modal capped at
   `max-width: 1000px` with Edit and Preview as mutually exclusive toggles and a
   hardcoded 13px monospace body. A 40 KB plan is read through a keyhole, at a
   size the user cannot change.
2. **Artifacts have no viewer at all.** `PlanTab` lists them, but the only
   action is "Open", which shells out to VS Code via `openArtifactInEditor`.
   There is no `GET` route for artifact content, so nothing in the web UI can
   render one. To read a design doc the run produced, the user leaves the board.

The root cause is that plan.md is modelled as *the* document and everything else
as an opaque attachment. In truth they are all documents from the same run.

## Goals

- One surface that reads and edits plan.md and every captured artifact.
- Artifact names are arbitrary. Whatever the agent wrote is what appears; no
  code names `spec.md` or `design.md`.
- Editing an artifact changes the file the next agent will actually read.
- A window wide enough for real specs, and prose sized by the user.

## Non-goals

- A general file browser. Only plan.md and manifest-listed artifacts are
  reachable — the manifest stays the allowlist.
- Rich-text or WYSIWYG editing. Plain textarea plus rendered preview.
- Syntax highlighting for non-markdown artifacts. They are editable text; that
  is enough.
- Changing capture, reconciliation, or phase logic in any way.

## Decisions taken

Recorded because each closes a real fork in the road:

1. **Artifacts are editable, not read-only.** The user rejected a read-only
   viewer.
2. **Saves write through to the real file.** Not the snapshot copy. Rationale in
   §2.
3. **One component, not two.** plan.md is the first row in a document list, not
   a special case with its own modal.
4. **Markdown rendering keeps `dangerouslySetInnerHTML`.** This carries forward
   the existing, documented decision in `PlanEditor.tsx` — local single-user
   tool, locally-authored content. This design does not revisit it; it is called
   out only so the inheritance is deliberate rather than accidental.

## Architecture

Three units with clean boundaries:

| Unit | Responsibility | Depends on |
|---|---|---|
| `orchestrator/documents.ts` | Pure + fs: classify a name, read/write a document, resolve the write target | `artifacts.ts`, `plan.ts`, `paths.ts` |
| `server/routes.ts` (+2 routes) | HTTP surface over the above | `documents.ts` |
| `web/components/DocumentWorkbench.tsx` | The modal: rail, panes, modes, zoom | `api.ts` |

`DocumentWorkbench` replaces `PlanEditor.tsx`, which is deleted.

### 1. Document identity

A **document** is either the plan or one artifact:

```ts
type DocId = { kind: 'plan' } | { kind: 'artifact'; name: string };
```

The web client already receives `task.derived.artifacts` over SSE, so the rail
is built from state it holds. **No `/api/tasks/:issue/docs` list route is
added** — it would duplicate the board payload and give the rail a second,
staler source of truth.

Artifact lookup goes through the existing `resolveArtifactStoredPath`, which
resolves a name against the manifest rather than joining caller input onto a
path. Path traversal is therefore not reachable from the new routes; an unknown
name is a 404, not a filesystem probe.

### 2. Write-through, and why

An artifact exists twice: the snapshot under
`~/.mc/tasks/<issue>/artifacts/<name>`, and — for `origin: 'repo'` — the
real file at `originalPath` inside the MC-created worktree.

**`PUT` writes `originalPath` when it exists, then re-copies to the snapshot so
both agree.** The alternative (snapshot only) is a trap: the user edits a spec,
the board shows the edit, and the Implement agent reads the untouched worktree
file. Edits would be notes masquerading as changes.

**`GET` resolves the same way** — original when it exists, snapshot otherwise —
so read and write always address one file. Reading the snapshot unconditionally
would show stale text whenever the user had edited the real file in VS Code, and
the next save would silently overwrite that edit.

When `originalPath` is gone — the worktree was cleaned up, or the agent's
task-dir file was deleted — the write lands on the snapshot alone. The rule is
uniform across both origins: `origin` never enters the decision, only whether
the original path still resolves. (An earlier draft special-cased
`origin: 'taskdir'` to snapshot-only on the belief that the stored copy *was*
the file. It is not — `collectArtifacts` copies `taskDir/<name>` to
`taskDir/artifacts/<name>`, so they are two distinct files and the uniform rule
is both simpler and more truthful.) The response reports which happened:

```ts
type WriteTarget = 'original' | 'snapshot';
```

The header renders a quiet "snapshot only" note for `'snapshot'`, so the UI
never implies an edit reached a checkout it did not reach. This does not weaken
the zero-footprint guarantee: worktrees are created and destroyed by MC, and
`artifactRoots` are paths the user explicitly configured as writable.

Writes use `writeFileSync` with `mkdirSync(..., { recursive: true })`, matching
`writePlan`.

### 3. Content classification

Names are arbitrary, so extensions are too. Classification happens server-side
on read:

| Class | Test | Modes offered |
|---|---|---|
| `markdown` | extension `.md` / `.markdown`, or no extension | Edit · Split · Preview |
| `text` | decodes as UTF-8, no NUL byte in first 8 KB | Edit only |
| `binary` | NUL byte in first 8 KB | none |

`binary` returns **415** with `{ error, binary: true }`; the pane shows the path
and an "Open in VS Code" button, reusing the existing open route. Files larger
than **2 MB** return **413** rather than shipping megabytes into a textarea.

### 4. Routes

```
GET /api/tasks/:issue/artifacts/:name
  200 { content, class: 'markdown'|'text', writeTarget, originalPath }
  404 unknown task, or name not in the manifest
  410 manifest entry exists but the stored snapshot is gone from disk
  413 over 2 MB
  415 binary

PUT /api/tasks/:issue/artifacts/:name   body { content: string }
  200 { ok: true, writeTarget }
  400 content not a string
  404 unknown task or name
```

`GET`/`PUT /api/tasks/:issue/plan` are unchanged. The workbench calls them for
the plan document and the artifact routes for everything else; that asymmetry
lives in one adapter function in `api.ts` and is invisible to the component.

### 5. Layout

```
┌─ Docs · #3060 ───────────────────────────────────────┐
│ [Edit|Split|Preview]      A− 15px A+    Save   Close  │
├────────────┬────────────────┬─────────────────────────┤
│ plan.md  ● │ ## Phase 1     │  Phase 1                │
│ spec.md    │                │  ───────                │
│ design.md  │ Do the thing.  │  Do the thing.          │
│  in checkout│               │↔                        │
└────────────┴────────────────┴─────────────────────────┘
```

- Modal: `width: 96vw; max-width: 1600px; height: 94vh` (from `1000px`).
- Rail: 220px. plan.md first, then artifacts in manifest order. Each row carries
  a dirty dot and the existing "in checkout" badge for `origin: 'repo'`.
  Artifact rows also carry an open-in-VS-Code affordance (the existing
  `openArtifact` route); the plan row does not, since no such route exists for
  plan.md and inventing one is out of scope.
- Split divider is draggable; panes scroll-sync proportionally.

**The preview pane caps its text at a 78ch measure and centers it.** Wider is
not automatically more readable — full-bleed prose at 1600px is worse than
today's 1000px. Width buys the split; the measure keeps prose legible.

### 6. Zoom

One CSS custom property `--doc-font` on the modal root drives both panes.
Preview headings are sized in `em` so they scale from the same value.

- `A−` / value / `A+` in the header
- `Ctrl`/`Cmd` + `=` / `-` / `0` (reset)
- `Ctrl` + wheel over either pane

Clamped to **11–24px**, default 13px (today's size). Persisted to
`localStorage` under `mc.doc.*` alongside mode and split ratio — global, not
per-task, because it is a user comfort setting rather than task state.

### 7. Editing state

```ts
Map<string, { text: string; loaded: string; class: ContentClass }>
```

keyed by serialized `DocId`. Switching rail rows preserves unsaved edits.
`Save` writes only the active document. `Close` warns when **any** entry is
dirty, listing which — the current single-document confirm would silently
discard edits to a document that is not on screen.

Documents load lazily on first selection; the rail renders immediately from
board state.

### 8. PlanTab

The section becomes **Documents**: the inline `<pre class="plan">` glance at the
plan stays, and the primary button opens the workbench. Artifact rows open the
workbench at that document; their existing "Open" becomes a secondary
hand-off-to-VS-Code action rather than the only one.

## Error handling

| Failure | Behavior |
|---|---|
| Load fails | Inline error in the pane; rail row marked; other documents unaffected |
| Save fails | Error banner; document stays dirty; nothing is cleared |
| File vanished (410) | "No longer on disk" with the recorded path; pane read-only |
| Binary (415) | Placeholder card + Open in VS Code |
| Too large (413) | Message naming the size cap + Open in VS Code |

Every failure is per-document. One bad artifact never takes down the workbench.

## Testing

Unit (`test/documents.test.ts`), all against the pure core:

- classification: `.md`, `.markdown`, no extension, `.json`, NUL-bearing bytes
- write-target resolution: original present → `'original'`; original missing →
  `'snapshot'`; identical for both origins
- font-scale clamping at both bounds and reset
- dirty tracking across document switches

Server (`test/server-documents.test.ts`):

- 404 on a name absent from the manifest
- 415 on binary, 413 over cap, 410 when neither copy remains
- `GET` prefers the original over a stale snapshot, and falls back when it is gone
- `PUT` with a live original updates **both** files
- `PUT` with the original removed updates the snapshot and reports
  `writeTarget: 'snapshot'`

Existing `test/plan.test.ts` and `test/artifacts.test.ts` must stay green
unmodified — this design adds surfaces, it does not change capture.

No new e2e. `npm test` and `npm run typecheck` are the gate.

## Risks

- **Component size.** `DocumentWorkbench` risks becoming the next oversized
  file. Mitigation: the rail (`DocRail`) and the pane pair (`DocPanes`) are
  separate files from the start; the workbench owns state and mode only.
- **Write-through surprise.** A user may not expect a board edit to touch a
  worktree file. Mitigated by the header always naming the write target.
