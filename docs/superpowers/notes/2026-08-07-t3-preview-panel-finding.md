# Does the Mission Control board render inside T3 Code's preview panel?

Tested against T3 Code 0.0.31 on 2026-08-07.

## Result

DOES NOT WORK

## Observations

- Renders: **no** — there is no preview panel to render into. T3 0.0.31's
  project script settings expose a name and a command, but no icon picker, no
  preview URL field, and no auto-open-preview toggle. Running the script opens
  a terminal in the project and nothing else.
- SSE stays connected: **n/a** — never got a panel to test.
- Interaction works: **n/a**.
- Survives thread switching: **n/a**.

The script itself ran correctly in T3's terminal once the command was fixed
(see below), so the failure is specifically the absence of the preview
affordance, not a problem reaching the board.

## Correction to the plan's probe command

The plan specified `curl -sf http://127.0.0.1:4317/health`. That endpoint does
not exist. Mission Control serves health at **`/api/health`**
([routes.ts](../../../src/server/routes.ts)); `/health` falls through to the SPA
not-found handler in [index.ts](../../../src/server/index.ts), which returns
`index.html` with a 200 — so `curl -sf` reports success while proving nothing.

The correct probe, verified against a running board:

```
curl -sf http://127.0.0.1:4317/api/health || echo "Mission Control is not running"
```

`buildMissionControlScript` in `src/orchestrator/t3/commands.ts` uses
`/api/health` for this reason.

## Consequence for the plan

§5 of the spec is dead for T3 0.0.31: an integration that surfaces the board
inside T3 needs a preview panel, and this build has none. Nothing else is
affected — the preview panel was only ever a convenience, and it was never on
the path that makes `t3` a launcher.

Tasks 2–11 and 13 stand unchanged. Task 12 ships the launcher selector and the
per-run thread id, and **skips** Step 5's `project.meta.update` block that would
have pushed the Mission Control script into T3.

`buildMissionControlScript` and `buildProjectScriptsUpdateCommand` are still
built and still tested. They are cheap, they document the intended payload
shape against a schema read from T3's own bundle, and if a later T3 release
adds a preview panel the only change needed is to call them — the block to add
is written out verbatim in Task 12 Step 5 of the plan.
