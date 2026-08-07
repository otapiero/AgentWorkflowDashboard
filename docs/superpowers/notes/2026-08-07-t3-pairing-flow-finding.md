# How Mission Control actually authenticates to T3 Code

Verified end to end against a running T3 Code 0.0.31 on 2026-08-07, by
exchanging a real pairing token and fetching a real orchestration snapshot.

The plan's §2.2 got the shape of the OAuth exchange right and the operator
workflow around it wrong in three ways. All three produce the same symptom — a
`401` that reads as "your credential was revoked" — which is why they are
written down rather than merely fixed.

## 1. The UI is "Authorized clients → Create link", not "Create pairing link"

Plan text: *"minted once by hand from T3's own 'Create pairing link' UI"*.

Real path: **Settings → This environment → Authorized clients → Create link**.

The button offers a dropdown with three outputs:

| Option | Gives you |
| --- | --- |
| Pairing URL → **This machine** | `http://127.0.0.1:3773/pair#token=XXXX` |
| Pairing URL → Local network | `http://192.168.110.1:3773/pair#token=XXXX` |
| Pairing code → Copy code | the bare token, e.g. `QX7T5F72X89Q` |

"This machine" is the right one: Mission Control connects to the `origin` in
`server-runtime.json`, which is loopback.

There is no scope picker. The created client was granted 6 scopes, including
the `orchestration:read` and `orchestration:operate` the exchange asks for.

**The button only exists when T3 is reachable beyond loopback.** With the
server bound to `127.0.0.1`, `/api/auth/session` reports
`policy: desktop-managed-local` and `bootstrapMethods: ["desktop-bootstrap"]`.
After enabling network access (server bound to `0.0.0.0`), it reports
`policy: remote-reachable` and `bootstrapMethods: ["desktop-bootstrap",
"one-time-token"]`. `one-time-token` is the method behind Create link.

## 2. The token is in the URL fragment, not the query string

`http://127.0.0.1:3773/pair#token=QX7T5F72X89Q`

A `#` fragment is never transmitted to a server, so this keeps the token out of
access logs and referrers — good design by T3, and a silent trap for any client
that reaches for `searchParams`. `extractPairingCredential` reads the fragment
first, then the query string, and passes a bare token through untouched so the
"Copy code" output works too.

## 3. Two credentials, not one — and only one of them is long-lived

This is the substantive correction. The plan treated the pairing token as a
durable credential to store and re-exchange whenever the access token expired,
and said of the access token: *"cached in memory only and never written to
disk: it expires on its own, and a file would outlive the process that earned
it."*

That is backwards. Measured:

| Credential | Lifetime | Reuse |
| --- | --- | --- |
| Pairing token (`one-time-token`) | **~3 minutes** | **single use** |
| Access token (`bearer-access-token`) | **30 days** (`expires_in: 2591999`) | until expiry |

T3's own bundle states it plainly: bootstrap methods *"are for establishing
trust at the start of a connection or pairing flow. They are not the long-lived
credential used for ordinary authenticated HTTP / WebSocket traffic after
pairing succeeds."*

Under the plan's design the integration would work until the first board
restart, then try to re-exchange a token that was spent and expired minutes
after it was created — and demand a fresh pairing link on every launch, forever.

So the **access token** is persisted, to `~/.mc/t3-token.json`, and is
what `getToken` prefers. The pairing token is used exactly once, to buy it.
`invalidate()` deletes the persisted copy, because a `401` means that token is
dead and reloading it would loop.

## Recorded exchange

Request (form-urlencoded to `POST /oauth/token`) — the plan's grant shape,
which was correct:

```
grant_type=urn:ietf:params:oauth:grant-type:token-exchange
subject_token=<pairing token>
subject_token_type=urn:t3:params:oauth:token-type:environment-bootstrap
requested_token_type=urn:ietf:params:oauth:token-type:access_token
scope=orchestration:read orchestration:operate
client_label=Mission Control
```

Response `200`:

```json
{
  "access_token": "<jwt>",
  "issued_token_type": "urn:ietf:params:oauth:token-type:access_token",
  "token_type": "Bearer",
  "expires_in": 2591999,
  "scope": "orchestration:read orchestration:operate"
}
```

Decoded payload:

```json
{
  "v": 1, "kind": "session", "sid": "…", "sub": "one-time-token",
  "scopes": ["orchestration:read", "orchestration:operate"],
  "method": "bearer-access-token", "iat": …, "exp": …
}
```

A rejected credential returns `401` with a structured body, which is how an
expired pairing token was told apart from a wrong grant shape:

```json
{"_tag":"EnvironmentAuthInvalidError","code":"auth_invalid",
 "reason":"invalid_credential","traceId":"…"}
```

## Snapshot shape confirmed

`GET /api/orchestration/snapshot` with that bearer token returned `200` and
parsed cleanly against `snapshotSchema`. Top-level keys were
`snapshotSequence`, `projects`, `threads`, `updatedAt`; projects carried five
fields beyond the three the schema reads (`repositoryIdentity`,
`defaultModelSelection`, `scripts`, `createdAt`, `updatedAt`, `deletedAt`),
absorbed by `.loose()` exactly as intended.
