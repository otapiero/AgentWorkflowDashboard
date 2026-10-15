# Stacked pull requests

Status: proposed for written-spec review.

## Outcome

Keep one board task per issue and represent every associated PR as a separate
layer. The operator can see the order, CI and review state of each layer, then
launch work against the intended branch and base. Merging one PR must not hide
unfinished layers. Discovery and polling must avoid a GitHub request per PR.

The approved conversational proposal covers discovery, display, completion
tracking and layer-specific actions. Automatic rebasing, retargeting, merging,
package release detection and creating future stack layers are outside this
change. External companion PRs can be recorded as links; they are not inferred
to be branch parents or polled automatically.

## Current behavior and affected boundaries

`github.ts` reduces issue-attached PRs to the newest open PR. `TaskRecord` stores
one PR identity alongside one issue branch. These can describe different layers.
`poller.ts` and `facts.ts` stop checking tasks after the selected PR merges.
`spawn-plan.ts`, `spawn/phase.ts`, the PowerShell launch path and prompt templates
use the issue checkout and repository base, regardless of the selected PR.

Preserve the issue-level plan, notes, artifacts, manual progress and history.
Add stack data and an explicit execution target rather than duplicating tasks.
All launchers must resolve the same target through the same planning function.

## Data model

Introduce a shared PR identity containing host, repository and number. A layer
contains that identity, URL, title, state, head repository and branch, base
repository and branch, head SHA, checks and review facts. Derived information
contains parent identity, per-layer phase and dependency warnings.

Persist known layer identities, last observed branch metadata and membership
provenance, either issue attachment, branch discovery or manual attachment.
Persist an optional selected layer identity. GitHub status remains cached facts,
not a user override. Preserve existing scalar PR fields as the current layer's
compatibility projection while API and extension consumers migrate.

Old records without stack fields load normally. Previously merged tasks require
one discovery pass before inheriting stack completion; the old scalar state
alone cannot prove the whole task is merged. Explicitly Done tasks remain Done.

## Discovery and GitHub request budget

Use the existing serialized poll loop and one batched GraphQL request per
ordinary poll. Do not make a GitHub request when rendering a card, opening a
drawer, selecting a layer or previewing a prompt.

The batched request combines these selections when needed:

- Issue-to-PR relationships for active issues. Include branch metadata and
  pagination information. Refresh membership every five minutes, at startup
  and after an explicit membership change. Do not duplicate full status fields
  here when the same PR already has a status alias.
- Status aliases for unique known PR identities, including their current
  branches. Request checks and review threads once per PR across the board.
- A lightweight repository index of open PRs, containing identity and branch
  metadata only. Refresh it every five minutes to find children that do not
  directly close the issue. Join it to known parents locally.

For an initial discovery response, the existing issue PR selection may include
full status so direct attachments render immediately. Newly discovered children
receive their full status in the next normal poll. Show status as unknown until
then. Selection itself must not trigger a follow-up request.

Paginate membership and the open-PR index with pages of at most 100. Carry the
cursor into the next serialized poll and put the next page in that poll's
batched request. Never drain an unbounded number of pages in one cycle. Publish
a completed index atomically; retain the previous complete index while building
the next. Expose incomplete discovery and do not claim complete membership while
pagination or an error leaves it unknown. Repeat this mechanism for truncated
review-thread and check connections before declaring their gates satisfied.

A query builder must cap its node/alias budget and split an oversized board
into bounded batches. Request count then scales with batch capacity, rather
than stack depth or UI interactions. Reuse existing rate-limit reporting and
last-good behavior. A partial alias error affects only the relevant layers.
Retain old membership on errors; an unavailable page is not evidence of removal.

Once all known layers merge, retain cheap membership discovery every five
minutes until the operator marks the task Done. Stop detailed polling for
terminal layers. This allows later published layers to reactivate the issue
without maintaining full CI/review polling for completed work.

## Ordering and completion

Match a child's base repository and branch to a parent's head repository and
branch. Branch names alone are insufficient for fork PRs. Traverse the connected
graph from attached or manually added PRs. Store discovered identities so a
parent's merge or a child's later retargeting does not erase stack membership.

Sort parent before child with stable PR-number ordering among siblings. Support
multiple roots and branching stacks. Detect cycles and ambiguous parents; show
an explicit warning and do not silently choose a dependency. Unrelated attached
PRs remain visible as separate roots.

Each layer retains its own pipeline phase. The issue summary uses the earliest
unmerged actionable layer in dependency order, while badges summarize failures
and unresolved reviews anywhere in the stack. An open ancestor prevents a child
from being described as ready to merge into the configured repository base.
CI failure and review work on children remain actionable while a parent is open.

The task reaches Merged only when discovery is complete, all included layers
are merged and no membership/status information is unavailable. A closed,
unmerged layer is an unresolved condition, not success. The operator can detach
a superseded layer explicitly. Task cleanup remains tied to manual Done.

After a parent merges, compare the child's actual base to the configured base
and the retained parent metadata. If it still targets the parent branch, show
that retargeting needs attention. Do not claim a rebase is required without git
evidence. Refresh these facts through normal polling.

## User interface

Show a compact card summary such as `3 PRs, 1 merged, 1 failing`. In the drawer,
show an ordered layer list with title, PR link, target branch, CI, review status
and dependency warnings. Distinguish the issue's overall phase from the selected
layer's phase.

With several layers, require explicit selection before launching a PR-specific
action. With one layer, select it automatically. Retain selection per task and
clear it if the layer is detached. Show the target PR, branch and base in launch
composition and prompt preview. Layer switching uses cached data.

Provide manual attachment by PR URL in the configured repository, removal of
manual/discovered membership, and optional external companion links. Validate
new attachment metadata in the next batched refresh, not one network operation
per keystroke. Suppress explicitly detached discoveries until reattached.

## Execution and checkouts

Pass an explicit execution target through API requests, prompt preview, spawn
planning, spawn records and all launchers. Revalidate that the target belongs to
the task and has usable metadata on the server. Reject unknown or stale targets
instead of falling back to the issue branch. Include the PR identity in history.

Use a writable per-layer worktree for PR-specific runs. Reuse an already managed
checkout of the exact branch when possible, including the legacy issue checkout
for its matching layer. Verify its actual branch before launch. Do not switch
an existing checkout to a different layer. Fail clearly when git reports that a
branch is checked out elsewhere or metadata cannot establish a writable local
branch. Fork layers remain visible but launching against an unsupported fork
must produce a clear error.

Pass the selected layer's actual base to publishing and review prompts. Include
its PR number and the surrounding dependency context. Issue planning and runs
without PR context retain the existing issue checkout. A raw custom prompt still
honors the explicitly selected checkout without silently injecting prompt text.

Keep issue-level run bookkeeping serialized: allow only one active issue run,
regardless of layer. Reject a second launch before writing shared prompt/spec
files or markers. Extend cleanup to every managed layer checkout using the
existing rescue mechanism; preserve checkouts belonging to other tasks.

## Verification

Test graph construction with reversed input, siblings, forks sharing branch
names, retargeted children, cycles and unrelated roots. Test that an earlier
merged layer cannot complete or freeze a task with another open layer, and that
unknown/truncated discovery cannot imply completion.

Exercise the actual fetch orchestrator with a recording gh boundary: a normal
multi-layer cycle uses one batch, two issues sharing a PR request its status
once, discovery observes the five-minute interval, pagination carries forward
without a request burst, and partial failures retain last-good membership.
These tests check scheduling and query composition decisions in our code.

Test that selecting the second layer makes preview, branch, base and execution
path agree for all launchers, and that unknown targets, occupied branches and
concurrent launches fail before shared files change. Test legacy records and
cleanup ownership/rescue. Use neutral fixtures only. For invariant tests,
temporarily break the source invariant, observe failure, then restore it.

Run `npm run typecheck && npm test` and
`npm --prefix vscode-extension run verify`. Process suites belong in
`PROCESS_SUITES` in `vite.config.ts`. Verify the drawer, selection and launch
preview in the shared T3 preview with a deterministic stack fixture. Do not
change timeouts to hide failures.

## Delivery

Implement on `feat/stacked-pull-requests` against `master`. Keep discovery,
reconciliation and execution-target resolution in focused modules. After the
required checks pass, push the feature branch and open a PR, then register its
URL with this thread. Report the measured request behavior and any unsupported
cases in the PR description.
