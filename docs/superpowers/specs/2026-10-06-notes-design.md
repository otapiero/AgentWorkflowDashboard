# Notes for Mission Control

Status: proposed design for review. Product implementation has not started.

## Intent and decisions

Give the operator a place to record reminders, findings, and things to follow
up on while managing agent tasks. Capture should take only a few clicks, and
the same note should be reachable from the dashboard and its task.

The requested behavior is:

- A dashboard Notes tab with note cards and a way to create and edit notes.
- A note can be general or linked to one task by its GitHub issue number.
- Every task view has access to that task's notes.
- Notes can be marked settled. They move below active notes into a collapsed
  section rather than disappearing permanently.
- Connected agents can create a note with or without a task number.

The user confirmed that notes belong to the selected repository. "All notes"
includes both general and task notes from that repository. "General" means
notes without a task link. There is no collection shared across repositories.

Recommended defaults for this proposal are explicit Save, plain text with
line breaks, an optional title, and the ability to reopen settled notes.
Completing a task does not automatically settle its notes.

## Approaches considered

| Approach | What it provides | Trade-off |
| --- | --- | --- |
| Notes API with a small local MCP adapter | The UI and different agents use the same validated operations; agents discover named tools | Requires a small adapter and client setup. Mission Control must be running |
| Notes API with CLI commands and a skill | Shell-capable agents can use documented commands | A useful fallback, but discovery and instructions depend on each client |
| Hosted MCP service and distributed plugin | Can reach cloud agents and package installation | Adds hosting, authentication, and remote access to a local application |

Use the first approach. Add a skill or plugin later when installation or
repeated workflows justify it. Do not make agents edit the notes data file.

## Dashboard and task flow

### Dashboard

Add `Board` and `Notes` navigation beside the repository identity. Keep the
existing header and connection status. The attention rail and lanes belong
to the Board view. Notes has its own content area and `+ New note` action.

```text
Mission Control   owner/repo       [Board] [Notes 7]       Agents   live

Notes                                                   + New note
[All notes 7] [General 2] [Task: All tasks v]       [Search notes...]

  Review deployment sequence       Ask about retry policy
  General                          #3131 Send xAPI usage events
  Compare the two release...        Check whether the endpoint...
  Updated 12 minutes ago            Updated 25 minutes ago
  Open                 Settle       Open                 Settle

  Confirm migration rollback
  #3377 Investigate migration flow
  Write down the recovery...
  Open                 Settle

> Settled notes 4
```

- All notes is the default. General selects only unlinked notes. Selecting a
  task selects that task's notes and clears General. These scopes are mutually
  exclusive. The task picker searches issue numbers and titles, including
  tasks in Done. Filter choices also include retained links to tasks no longer
  on the board; the editor offers current tasks for new associations.
- Search matches note titles, bodies, and linked task numbers or titles. It
  applies to active and settled sections within the current scope.
- Active cards sort by most recently updated, then ID for a stable tie-break.
  Settled cards sort by when they were settled, newest first.
- Use the existing dark colors, typography, borders, and corner radius.
  Cards use a responsive CSS grid with a minimum width near 280px. The task
  drawer and narrow screens use one column. Do not use masonry ordering.
- A card shows its title, a short body preview, task badge or General label,
  timestamp, Open, and Settle. Without a title, use the first nonempty body
  line as the display heading without saving an invented title.
- A task badge opens that task's drawer on Notes. Opening and settling are
  separate buttons in an article, so interactive controls are not nested.
- Counts refer to active notes in the scope, before search. Settled has its
  own count. Empty messages distinguish no notes, no active notes, and no
  search results.

### Task drawer

Extend the existing tabs to `Run | Plan | Notes 3 | History | Setup`.
The count includes active notes for that task only.

The Notes tab reuses the same card list, editor, and Settled section, filtered
to the task. `+ New note` preselects this task. `View in all notes` opens the
dashboard Notes view with the task filter selected. From there the operator
can switch to All or General.

An ordinary task-card click still opens Run. A note's task badge can pass
`initialTab: 'notes'` to the drawer. Keep notes counts in the UI's notes state;
they do not change task phase, gates, urgency, or GitHub polling.

### Creating and editing

Use one compact editor with an optional title, multiline body, and a
searchable task picker containing `General, no task`.

- New from All or General defaults to General. New from a task-filtered view
  defaults to that task. The operator can change the association before Save.
- Body is required and must contain non-whitespace text. Preserve entered
  whitespace. Title is optional, capped at 240 characters. Body is capped at
  64 KiB in UTF-8. Show validation beside the relevant field.
- Save and `Ctrl+Enter` submit the same operation. Disable repeat submission
  while it is pending. Success closes the editor and reveals the saved note
  in the scope matching its association, with search cleared if necessary.
  Saving a settled note also expands the settled section to reveal it.
- Use explicit Save rather than saving partial notes on every keystroke.
  A failed save keeps the editor and text intact. Do not show a saved state
  until the API acknowledges a durable write.
- Preserve drafts when switching views. Store them by repository and note ID
  in browser storage, with a separate key for a new note. Reopening offers to
  resume a draft. Persist the creation request ID with a new-note draft and
  reuse it after an uncertain save or reload. Save or explicit Discard clears it.
- Escape closes the innermost editor first. Closing dirty text offers Keep
  editing or Discard. Trap focus in the modal and return it to the opener.
  Inputs use `dir="auto"` for mixed Hebrew and English text.
- Notes are plain text in v1, rendered as text rather than injected HTML.
  Rich text, attachments, tags, folders, reminders, and collaboration are
  outside this version.

### Settled notes

Settle changes the note's status and records the settlement time. On a
successful save it leaves the active list and enters `Settled notes`, which
is collapsed by default and always sits below the active list. Use the same
scope and search rules for both sections.

Expanded settled cards have Open and Reopen actions. They remain readable and
editable, with a quieter appearance that still meets contrast requirements.
Reopen clears the settlement time and returns the note to the active list.
Neither action changes the task. Permanent deletion is deferred; settling is
the removal action requested for v1.

## Data and durable storage

Use a separate authoritative file:

```text
%USERPROFILE%\.mission-control\projects\<owner>__<repo>\notes.json
```

Respect `MC_ROOT`, `MC_PROJECT`, and `MC_HOME` when resolving the project at
startup. Pin the entire server process to that resolved home before loading
configuration or starting the poller, by setting its MC_HOME to the resolved
path. Existing path helpers then keep the board and notes on the same project
without refactoring the reconciler. Capture that home, repository identity,
and task-state path in the notes service. A project switch affects the next
server process, not requests already served by this one.

```ts
interface NoteRecord {
  id: string;                    // Server-generated UUID
  title: string | null;
  body: string;
  taskIssue: number | null;       // Issue number within this repository
  taskTitleAtLink: string | null; // Fallback if the task leaves the board
  status: 'active' | 'settled';
  createdAt: string;              // Server UTC timestamps
  updatedAt: string;
  settledAt: string | null;
  revision: number;               // Starts at 1
  clientRequestId: string;        // Stable across retries of this creation
  creationFingerprint: string;    // Stored privately, omitted from API results
}

interface NotesFile {
  version: 1;                    // Schema version
  revision: number;              // Increases after each committed mutation
  notes: NoteRecord[];
}
```

Keep this file separate from `state.json`, task artifacts, and worktrees.
Notes are authored data, not a cache derived from GitHub. The existing unused
`TaskRecord.notes?: string` is not the new collection. No current application
code reads or writes it. Preserve that legacy field and existing board data;
the notes feature does not repurpose or delete it.

- Missing file means an empty collection. Create it on the first mutation.
- Validate the stored schema on read. An unreadable or unsupported file
  disables notes operations with a useful error and leaves the file intact.
  Do not copy `loadState`'s corrupt-file-to-empty recovery behavior.
- Write a uniquely named temporary file in the same directory, flush it,
  close it, and rename it over the destination. Publish only after success.
  Failed writes leave the prior collection and revision intact.
- The Fastify notes service is the only supported writer. Acquire an
  exclusive project lease when the service starts. A second server attempting
  to own notes for that project reports `NOTES_ALREADY_OPEN` and disables its
  notes service, directing the operator to the existing server. Its task board
  can still run. Release the lease on shutdown and recover an abandoned
  lease only after confirming its owning process no longer exists. Record a
  random ownership token and process identity including start time, so PID
  reuse cannot grant ownership. Acquisition and abandoned-owner takeover must
  be serialized, and only the current owner can release the lease. Use an
  established locking implementation rather than a PID-only check/delete.
- Serialize mutations in that service. Compare the note revision inside the
  serialized operation before updating. Repeating a state transition already
  at its target is a no-op, provided the expected revision still matches.

Task links are optional. Creating or changing a link requires a task currently
on that repository's board. Reject unknown numbers; do not silently import a
GitHub issue or create a general note instead.

Forgetting a task preserves its notes, issue number, and last known title.
All notes and the task filter can still show them as `No longer on board`.
The badge can open the GitHub issue, while task-drawer navigation is unavailable.
Allow unlinking or assigning another task. Reimporting the same issue restores
the association. Mark Done and worktree cleanup never settle or delete notes.

## Service, API, and updates

| Unit | Responsibility |
| --- | --- |
| `src/shared/notes.ts` | Note types and request validation contracts |
| `src/orchestrator/notes.ts` | Pinned project store, lease, validation, atomic mutations |
| `src/server/notes-routes.ts` | Notes HTTP routes and publication after writes |
| `src/web/notes-model.ts` | Scope, search, sorting, counts, and draft rules |
| `src/web/components/notes/*` | Notes page, reusable list/cards, filters, and editor |
| `src/web/components/drawer/NotesTab.tsx` | Task-filtered use of the same components |
| `src/mcp/*` | Stdio server and loopback API client, without filesystem writes |

Register notes routes from `src/server/routes.ts` without putting the
subsystem's implementation into that already large file. Extend `App.tsx`,
the drawer tab type, `api.ts`, and existing styles where they integrate notes.
Task lookup uses the same pinned home as the board. No broad refactor of the
reconciler is part of this feature.

| Route | Result |
| --- | --- |
| `GET /api/notes` | `{ projectId, serverSessionId, revision, notes }`, including both statuses |
| `GET /api/notes/tasks` | Minimal task choices from the pinned repository's board |
| `GET /api/notes/:id` | `{ projectId, serverSessionId, note }` |
| `POST /api/notes` | Create an active note; return `{ projectId, serverSessionId, note }` |
| `PATCH /api/notes/:id` | Edit content, association, or status; return the saved note |

Creation accepts `title?`, `body`, `taskIssue?`, `projectId`, and
`clientRequestId`. Omitted or null `taskIssue` means General. A repeated
creation ID with the same original creation payload returns the existing note
without duplicating it. Store the creation payload fingerprint with the record
to distinguish a true retry from reusing an ID for different input. Reuse with
different input returns a conflict. Hash the normalized original title, body,
and task number, not the note's current editable values. The fingerprint is
internal metadata, omitted from public note responses. Resolve a creation
retry before validating current task membership: a saved note still counts
as a successful creation after its task leaves the board.

PATCH accepts the fields being changed, `projectId`, and `expectedRevision`.
Omitted fields retain their values; explicit null clears title or task link.
Status is `active` or `settled`. The server maintains timestamps and revisions.
Reject unknown fields, invalid IDs, and invalid status values.

All writes require the expected repository identity. Agent reads also supply
that identity as a query parameter, including the task list. The server checks
it on each request. A server restart into a different repository must produce
a mismatch error rather than accepting the old agent connection's writes.

Use 400 for invalid input, 404 for an unknown note or task, 409 for a revision
or project conflict, 413 for excessive content, and 503 for unavailable notes
storage. Error bodies include a stable code and readable message. Revision
conflicts include the current note. The editor keeps the draft and offers to
reload the current version or copy the draft; it does not overwrite silently.

Use the existing SSE broadcaster with a separate `notes` event containing
the full `{ projectId, serverSessionId, revision, notes }` snapshot. Generate
serverSessionId once per server startup. Seed its replay cache at
startup, including an empty collection. Commit first, then send. Notes writes
must not call GitHub reconciliation. Keep note-loading errors separate from
the board so an unreadable notes file does not prevent viewing tasks. When
storage is unavailable, publish a separate `notes-status` event with the
error code rather than an empty collection. Valid storage publishes available
status and its real snapshot. Preserve `/api/events?replay=0` semantics.

The browser maintains one collection used by the Notes page, task tabs, and
counts. Fetch on initial load and reconnect, and subscribe to notes events.
Within the same serverSessionId ignore lower collection revisions, so a slower
initial fetch cannot replace a newer event. Reset the baseline after a server
restart or repository change, then load a fresh snapshot. HTTP mutation results
update the affected note only when its revision is at least the revision already
displayed, without advancing the collection baseline. The subsequent snapshot
supplies the collection revision. On reconnection, discard responses from
requests initiated before that reconnect, including mutation responses. Use a
client connection generation to identify those requests; a late response
from the old server must not reset the session baseline or overwrite a note.

## Agent integration

### What each technology does

MCP exposes callable tools with typed inputs and results. A skill supplies
instructions for a repeatable workflow. A plugin packages skills and MCP
connections for installation. These can complement each other. Current
[OpenAI plugin architecture documentation](https://developers.openai.com/plugins/concepts/plugins)
describes these roles and recommends starting with the smallest useful package.

For this use case, use MCP tools first. A server description and precise tool
schemas are enough for simple requests such as "Create a note for task 3131"
or "Save this as a general note". An optional future skill can explain when to
capture a finding, how to resolve an ambiguous task, and how to report a saved
note. It would call the same tools.

### Local transport

Add a headless `mc mcp --project <slug> --server-url <loopback-url>` command.
The agent host launches it as a stdio process. It uses the official TypeScript
SDK and translates tool calls into the notes API. It does not open a second
web server or write data itself.

Current primary documentation supports local stdio servers in
[Codex](https://learn.chatgpt.com/docs/extend/mcp?surface=cli),
[Claude Code](https://code.claude.com/docs/en/mcp), and
[GitHub Copilot CLI](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-servers).
The [official TypeScript SDK v2 documentation](https://ts.sdk.modelcontextprotocol.io/v2/)
currently identifies v2 as stable and shows `@modelcontextprotocol/server` with
Zod v4. Pin a compatible stable release during implementation and verify it
against the installed clients, including legacy protocol negotiation.

- Pin the project and URL at adapter startup. Allow only loopback HTTP URLs;
  reject redirects away from that address. Validate repository identity on
  every request, not only during discovery.
- Mission Control must be running for reads and writes. Closing the browser
  is fine; stopping the Fastify process makes tools report `MC_UNAVAILABLE`.
  Never fall back to direct file writes after a connection failure.
- Give the tools short descriptions that state General semantics and valid
  task identity. Task numbers are GitHub issue numbers, not PR numbers.
- stdout contains only MCP protocol messages. Diagnostics go to stderr.
- Register through user-scoped client settings or launch-time configuration
  outside managed project checkouts. Preserve the zero-footprint guarantee.
  Provide copyable setup examples; do not overwrite an agent's existing config.
- Check each launcher separately. Codex and Claude through T3 may reuse their
  provider configuration, but Copilot through T3 uses OpenCode and needs its
  own verified configuration. Native CLI support does not establish T3 support.

| Tool | Inputs and behavior |
| --- | --- |
| `tasks_list` | Optional search; returns valid task numbers and titles |
| `notes_list` | `scope: all/general/task`, optional task number, `status: active/settled/all`, optional search; active by default |
| `notes_get` | Note ID; returns full text, task link, status, and revision |
| `notes_create` | Body, optional title and task number, stable request ID; omission creates a general note |
| `notes_update` | Note ID, expected revision, changed title/body/task link |
| `notes_set_status` | Note ID, expected revision, status active or settled |

Return structured results and a short readable confirmation with note ID,
repository, association, and status. The adapter generates and retains a
request ID across automatic network retries. Expose an optional request ID
to the agent so it can retry an uncertain creation across tool calls. It must
reuse the same input and key rather than generating another creation.

If a task number is supplied but unknown, return `TASK_NOT_FOUND`. If a user
names a task without a number, use tasks_list and resolve ambiguity before
creating. Missing task number alone is never an error and never implicitly
attaches the note to the agent's current coding task.

Read tools are marked read-only. Create is not idempotent unless its request
ID is reused. Update and status tools require revisions. Approval behavior
belongs to the agent host's policy; the integration does not disable it.

Hosted browser agents are a separate deployment problem. A local stdio server
does not by itself make this PC reachable from a cloud session. Remote MCP,
authentication, and plugin distribution can be designed later if needed.

## Verification and delivery order

Implement the store and API first, then the shared UI and task entry points,
then the MCP adapter and setup documentation. All three are part of the
requested feature; this sequence does not defer agent creation indefinitely.

Verify the behavior with meaningful tests:

1. Persistence across restart, independent repositories, general and task
   creation, invalid links, edits, settle/reopen, and preservation after task
   removal or worktree cleanup.
2. Atomic-write failures and invalid files preserve prior data. Concurrent
   edits reject stale revisions. Duplicate creation retries return one note.
   A second notes owner cannot acquire the project lease.
3. API validation and project mismatch checks cover every route. SSE sends
   committed snapshots, replays empty and populated collections, and does not
   cause GitHub calls. Reconnect handles fetch/event ordering correctly.
4. UI model tests cover scopes, search, sorting, counts, settled separation,
   and drafts. Browser verification covers dashboard and task navigation,
   save failure, conflict handling, keyboard actions, and a narrow viewport.
5. MCP tests exercise the protocol boundary and exact create semantics with
   and without a task, invalid-task errors, unavailable-server errors, retry
   deduplication, and project switching. Smoke-test available clients rather
   than assuming all launcher integrations work identically.

Run the relevant Vitest tests, typecheck, and UI build when implementing.
Existing task and SSE contracts must remain compatible with the VS Code
extension. No product code or dependencies change as part of this design.
