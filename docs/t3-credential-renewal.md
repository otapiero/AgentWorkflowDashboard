# Renewing the T3 Code credential

Mission Control's `t3` launcher talks to T3 Code with an access token that
**expires every 30 days**. This is the runbook for minting a new one.

> **Current token expires: 2026-09-06** (minted 2026-08-07, valid 30 days).

Nothing else in Mission Control is affected when it lapses. The `wt` and
`vscode` launchers do not use T3 at all, and the board keeps reconciling every
task to the correct phase — only T3 session liveness and approval detection go
quiet.

---

## The two-minute version

1. In T3: **Settings → This environment → Authorized clients → Create link**
2. Dropdown → **Pairing URLs → This machine**
3. Immediately paste it into the credential file:

```powershell
Set-Content -Path "$env:USERPROFILE\.mc\t3-credential" -NoNewline -Value "<paste the URL>"
```

4. Force the exchange and confirm:

```powershell
Remove-Item "$env:USERPROFILE\.mission-control\t3-token.json" -ErrorAction SilentlyContinue
cd c:\Users\ouriel\source\repos\otapiero\AgentWorkflowDashboard
npm run mc -- doctor
```

You want `- ok: reachable at http://127.0.0.1:3773, server version 0.0.31`.

**Do steps 2–4 without pausing.** The pairing link is single-use and expires
about three minutes after you create it.

---

## How to tell it has expired

`npm run mc -- doctor` says:

```
T3 Code
  - T3 rejected the credential.
    token exchange returned 401. A T3 pairing token is single-use and expires
    within minutes of being created, so this one is most likely spent.
    Fix: Settings -> This environment -> Authorized clients -> Create link,
    then replace ~/.mc/t3-credential with the new "This machine" URL.
```

On the board itself the symptom is quieter: cards launched through T3 stop
showing a live badge and stop moving into the attention rail when a session is
blocked on an approval. Nothing breaks; a signal just stops arriving. That is
why `doctor` is the thing to check, not the board.

---

## Why there are two files

This trips people up, so it is worth thirty seconds.

| File | What it is | Lifetime |
| --- | --- | --- |
| `~/.mc/t3-credential` | The pairing link you paste | **single use, ~3 min** |
| `~/.mission-control/t3-token.json` | The access token it buys | **30 days** |

The pairing link is a *bootstrap* credential — T3's own words: bootstrap
methods "are not the long-lived credential used for ordinary authenticated
traffic after pairing succeeds." It gets spent the first time Mission Control
uses it, within seconds, and is worthless thereafter.

The access token in `t3-token.json` is what every later request actually uses.
It is the one with the 30-day clock, and the one this runbook exists to renew.

So after a successful renewal, `t3-credential` contains a dead pairing token
and that is completely normal. Do not be alarmed by it and do not try to "fix"
it — the file only matters for the few seconds between pasting and the first
exchange.

**Deleting `t3-token.json` is what forces a fresh exchange.** If you paste a
new pairing link but leave the old token file in place, Mission Control will
keep using the cached token until it expires, and your new pairing link will
quietly go stale unused. Step 4 above deletes it for exactly this reason.

---

## If "Create link" is not in the T3 settings

The button only exists when T3 is reachable beyond loopback.

Check what T3 is advertising:

```powershell
curl -s http://127.0.0.1:3773/api/auth/session
```

- `"policy":"remote-reachable"` with `"one-time-token"` in `bootstrapMethods`
  → **Create link is available.**
- `"policy":"desktop-managed-local"` with only `"desktop-bootstrap"`
  → **it is not.** Turn on network access for the environment (T3 →
  Settings → This environment → Network access) and check again.

`desktop-bootstrap` is a private handoff T3 uses to authenticate its own
renderer. Mission Control cannot use it, which is why the manual pairing step
exists at all.

---

## Which dropdown option to pick

**This machine.** Mission Control connects to the `origin` recorded in
`~/.t3/userdata/server-runtime.json`, which is loopback.

| Option | Gives you | Use it? |
| --- | --- | --- |
| Pairing URL → **This machine** | `http://127.0.0.1:3773/pair#token=XXXX` | **Yes** |
| Pairing URL → Local network | `http://192.168.110.1:3773/pair#token=XXXX` | Works, but the LAN address is pointless here |
| Pairing code → Copy code | `QX7T5F72X89Q` | Works — paste the bare code |

All three are accepted. Mission Control reads the token out of the URL fragment
(`#token=`), out of a query string (`?token=`), or takes a bare code as-is, so
paste whatever you have without editing it.

There is no scope picker. T3 grants the client 6 scopes, which includes the
`orchestration:read` and `orchestration:operate` that Mission Control requests.

---

## Verifying, in more detail than `doctor`

Check what the stored token thinks:

```powershell
node -e "const t=require(process.env.USERPROFILE+'/.mission-control/t3-token.json'); console.log('expires', new Date(t.expiresAtMs).toISOString(), '| scope', t.scope)"
```

Hit the API with it directly:

```powershell
$tok = (Get-Content "$env:USERPROFILE\.mission-control\t3-token.json" | ConvertFrom-Json).accessToken
Invoke-RestMethod http://127.0.0.1:3773/api/orchestration/shell -Headers @{ Authorization = "Bearer $tok"; "x-t3-orchestration-protocol" = "2" } | Select-Object schemaVersion, snapshotSequence
```

A JSON response with `schemaVersion: 2` and a snapshot sequence confirms access.
`401` means renew. An HTML response indicates an unsupported route or API version;
re-pairing will not fix that. T3 0.1.0 replaced the old `/api/orchestration/snapshot` route.

---

## Troubleshooting

**`doctor` says "T3 Code is not running"** — T3's desktop app is closed, or it
crashed and left a stale `server-runtime.json`. Start T3. This is not a
credential problem; do not mint a link to fix it.

**Still 401 straight after pasting a fresh link** — you were probably slower
than the three-minute window, or the link had already been used. Mint another
and move faster. If it happens twice in a row, confirm you copied the *whole*
URL including the `#token=...` part; a URL truncated at the `#` contains no
token at all.

**`doctor` shows T3 ok but no agent instance lines** — that is a different
problem. Your `~/.mc/config.yaml` is missing `t3Instance` on the agents.
See [assets/config.example.yaml](../assets/config.example.yaml).

**An agent instance says "not installed"** — T3 has not provisioned that
provider's CLI. That is T3's business, not Mission Control's; open T3 and set
the provider up there.

---

## Revoking

Old clients accumulate in **Authorized clients** as separate entries. Each has
its own **Revoke** button, and there is a **Revoke others** at the top. Revoking
the client Mission Control is using kills its access token immediately, before
the 30 days are up — so if you revoke and the board goes quiet, come back to
this runbook and mint a new link.

---

## Background

Why the credential works this way, what the recorded token exchange looks like,
and the three ways the original plan got this wrong:
[2026-08-07-t3-pairing-flow-finding.md](superpowers/notes/2026-08-07-t3-pairing-flow-finding.md).
