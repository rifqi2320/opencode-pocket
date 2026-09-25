# Pocket Control — Technical Design

**Status:** First-release design, pending pinned-build integration validation  
**Date:** September 24, 2026  
**Companion:** `PRD.md`

## 1. Recommended architecture

A single mobile client connects directly to several existing OpenCode v2 servers over authenticated HTTPS. OpenCode remains the owner of sessions, execution, history, pending input, and permission/form decisions.

The only server-side addition is an optional **`@pocket/opencode-plugin` OpenCode v2 server plugin** when push notifications are desired. The plugin runs inside OpenCode, observes the server's own event stream, exposes a small typed RPC surface through the existing OpenCode HTTP server, stores minimal notification state through plugin storage, and sends push notifications through Firebase Cloud Messaging (FCM). It is not a controller backend and never proxies normal session reads or writes. [13][14]

No sidecar process, central controller backend, second HTTP port, message broker, event database, custom agent runtime, or cloud credential vault is required. HTTPS termination and any VPN are deployment prerequisites, not new services owned by the app.

### Platform choice

| Option | Decision |
|---|---|
| React Native + Expo + TypeScript | Recommend for a phone-first, two-platform release, assuming TypeScript familiarity; prove the network stack on real devices first |
| PWA | Credible alternative for a browser-first team with HTTPS/CORS already solved; do not build both clients in v1 |
| PWA plus aggregation gateway | Defer: adds a deployment, secret custody, and another failure domain |
| Separate Swift and Kotlin apps | Defer until a demonstrated platform need justifies two implementations |

Use the official **`@opencode/client`**, not the v1 SDK. Its documented client accepts custom fetch/authentication headers and supplies native event types; subscriptions require application-managed reconnection. Use `expo/fetch` for the mobile transport. Both capabilities are documented individually; their combined behavior still requires the physical-device spike. [3][7]

Use one server-state cache, such as TanStack Query, and component state for the composer/view. Use SecureStore for credentials and ordinary local key-value storage only for nonsecret connection settings, read markers, and content-free operation receipts. Do not add a second mirrored normalized store unless measured cache behavior requires it.

### Logical modules

- `connections`: saved endpoints, credentials, compatibility checks, one client/stream per server.
- `opencode`: thin calls around the pinned client; authentication, location, and error handling.
- `sync`: bootstrap, dirty-query scheduling, snapshot refresh, reconnect, lifecycle handling.
- `status`: pure evidence-to-view-model functions, relationship classification, attention rollups.
- `actions`: prompt/interrupt/reply lifecycle and receipt reconciliation.
- `screens`: sessions, session detail, server settings; shared tool/form renderers.
- `notifications`: plugin capability discovery, FCM device registration, notification preferences, deep-link handling, and refresh-on-open.
- `@pocket/opencode-plugin`: one small OpenCode server plugin containing event observation, notification policy, dedupe, durable registration state, FCM delivery, and the typed RPC contract consumed by the phone.

The mobile items above are folders in one app, not independent services. The OpenCode plugin is the only additional runtime component and shares the OpenCode server's process, HTTP/authentication boundary, lifecycle, and plugin storage. [13][14]

## 2. Contract boundary

Target the public OpenCode v2 HTTP API. Pin the exact server build and `@opencode/client` version together, record them in a compatibility fixture, and commit the relevant generated type/fixture snapshot. Do not infer the binary version from the OpenAPI document's own version field. [1][2]

The publicly reviewed OpenAPI represents some event payloads opaquely. Prefer the pinned official client's native event types over inventing v1-style event names or manually guessing SSE decoding. Integration fixtures must include real event envelopes from that exact server/client pair. [2][3]

The app has one supported adapter, not a universal “coding agent provider” interface. An unrecognized major contract is read-only only where decoding is demonstrably safe; otherwise show an incompatible-server state. Never optimistically enable writes against an unknown API.

### First-release endpoint map

Notation below uses `{s}` for `sessionID`, `{m}` for `messageID`, `{r}` for `requestID`, and `{f}` for `formID`. These are documentation abbreviations, not literal parameter names. [1][2]

| Purpose | HTTP surface |
|---|---|
| Identity/version | `GET /api/info` |
| Session metadata/discovery | `GET /api/session`; `GET /api/session/{s}` |
| Active execution | `GET /api/session/active` |
| Loaded locations | `GET /api/debug/location` |
| Messages | `GET /api/session/{s}/message`; `GET /api/session/{s}/message/{m}` |
| Live invalidation | `GET /api/event` |
| Prompt | `POST /api/session/{s}/prompt` |
| Pending input | `GET /api/session/{s}/inbox` |
| Interrupt | `POST /api/session/{s}/interrupt` |
| Permission discovery/reply | `GET /api/permission/request`; `GET /api/session/{s}/permission`; `POST /api/session/{s}/permission/{r}/reply` |
| Form discovery/reply | `GET /api/form`; `GET /api/session/{s}/form`; `GET /api/session/{s}/form/{f}`; `POST /api/session/{s}/form/{f}/reply` |
| Background shell evidence | `GET /api/shell`; `GET /api/shell/{id}`; `GET /api/shell/{id}/output` |
| Terminal status evidence | `GET /api/pty`; appropriate persistent-PTY metadata routes from the pinned client when used by the target build |
| Notification plugin capability/device registration | typed plugin RPC through `POST /api/rpc/pocket/{method}` when `@pocket/opencode-plugin` is installed |

The durable experimental per-session log is deliberately not the app's state database. The first release uses projected messages for readable history and snapshots for current truth; exact reconstruction of every transient event is out of scope. [1]

## 3. Identity, scope, and local data

Every session-owned record is keyed by **local server profile ID + session ID**. Location-scoped records additionally include the server-returned location. A title, path, or remote session ID alone is never a globally unique application key.

The local server ID is an app-generated UUID. Bind the profile to the explicitly configured origin/base path and a connection generation. Changing the endpoint or credentials cancels old work, increments the generation, and prevents late responses from populating a new connection's cache. Treat a reported PID change as a reason to resynchronize, not as proof of a globally unique server identity.

Example application-owned types:

```ts
type SessionKey = {
  serverId: string;
  sessionId: string;
};

type Observed<T> = {
  value: T;
  observedAt: number; // device time of successful observation
  freshness: "fresh" | "syncing" | "stale" | "offline";
};

type SessionView = {
  key: SessionKey;
  parent?: SessionKey;
  relationship?: "subagent" | "fork" | "child-unknown";
  execution: Observed<"running" | "inactive" | "unknown">;
  lastOutcome?: "succeeded" | "failed" | "interrupted";
  phase?: { kind: string; label: string; evidenceId?: string };
  attention: Array<{
    kind: "permission" | "form" | "failure" | "unsupported";
    owner: SessionKey;
    id: string;
  }>;
  children: {
    running: number;
    waiting: number;
    unknown: number;
    discovered: number;
    complete: boolean;
  };
  pendingInputCount?: number; // undefined means not yet known
};
```

The types above are a UI projection, not copied SDK interfaces. Keep raw typed responses in the query cache and derive these values. Never persist derived “running” booleans as authoritative truth.

Persist endpoint aliases, read boundaries, and mutation receipt identifiers. Keep transcripts and draft text in memory in v1. Drafts survive navigation and reconnect but not guaranteed process death. Persistent encrypted drafts can be added independently if the pilot proves they matter; do not force a local database into the first release.

## 4. Complete discovery without downloading every transcript

On connecting each server, start consuming its event subscription, then fetch server info, active-session IDs, loaded locations, and the first page of session metadata. Render useful partial results immediately.

Continue metadata pagination rather than treating the default first page as the whole server. Fetch any active session absent from the page directly by ID; follow its parent chain. Query pending permissions/forms for every loaded location with explicit location scope. Requests referencing missing sessions trigger direct metadata fetches. This makes old but active/blocked work visible before a long historical scan finishes.

Use the session metadata's locations and live events to supplement the loaded-location inventory. Do not eagerly initialize every historical directory just to poll it. If loaded-location discovery is unavailable, use known locations and per-session requests as a degraded path, clearly mark coverage partial, and do not show “nothing needs you” as a complete-server assertion.

Build the relationship index from explicit IDs. Classify a fork separately from agent delegation using the contract's relationship information and typed subagent linkage when supplied. Do not parse prose for session IDs. Unknown relationships remain navigable child sessions, not invented subagents. Forks should not silently count as workers still executing the parent's task.

Inspect all discovered metadata, but load transcripts only for the open session, relevant visible cards, and workers needed for current activity. Historical messages load on demand. The inventory is comprehensive; the transcript cache is intentionally bounded.

For background execution, discover running shell/terminal metadata by loaded location. Use exposed owner IDs or typed linkage to associate it with a session. Otherwise show a location-level “unattributed background work” row. Persistent terminals and detached work need separate status evidence; parent idleness is insufficient. Do not equate a terminal remaining open with an unfinished task.

## 5. Synchronization: events as hints, snapshots as truth

The global stream is live-only. The documented client does not automatically reconnect or replay missed events. [3]

**Do not implement an event-sourced replica of OpenCode.** Use events to invalidate the smallest relevant query, then refetch authoritative snapshots. This avoids rebuilding the server's reducers, handling every historical event, and appending token deltas incorrectly after reconnect.

### Initial synchronization and race handling

Start consuming the stream before taking snapshots. The consumer performs cheap event classification and increments a dirty counter for affected cache keys. It does not await network refreshes, markdown layout, or storage writes.

For each snapshot fetch, capture its dirty counter and connection generation. Discard results from obsolete generations. When the result arrives, replace the cached snapshot. If its dirty counter changed while the request was in flight, leave the key dirty and schedule another fetch. Allow only one in-flight refresh per key.

This is not a transactional cross-resource snapshot. Display resource-specific freshness and a reconciling state when facts temporarily disagree. The design promises convergence and honest uncertainty, not a fictitious atomic view of many servers.

Initial proposed scheduling constants, to tune under the reference workload:

| Work | Budget |
|---|---|
| Open-session changed message/state refresh | Coalesce to approximately 750 ms while dirty |
| Visible session-card details | Approximately 1–2 seconds while dirty |
| Safety reconciliation of active/location/blocker/background-work inventory | Approximately 15 seconds while foregrounded |
| Degraded polling when events are unavailable | Approximately 5 seconds; label the transport as polling |
| Metadata/message pages | 50 items initially, using returned cursors |
| Per-server read concurrency | Four; user actions get priority over historical reads |

Always do a targeted refresh after a mutation. Use periodic reconciliation to recover missed classifications and silent stream failures. A current HTTP snapshot can be accurate while the live transport is degraded; expose both facts rather than one “connected” boolean.

### Event handling

Create an exhaustive switch over execution-relevant event variants from the pinned native client types. Known variants invalidate session metadata, messages, inputs, requests, or background-work queries as appropriate. A new variant must not crash the app or be coerced into “idle.” Route it to a bounded diagnostic/detail fallback and invalidate a broader relevant scope.

For the first release, update readable output through coalesced message snapshots, not a bespoke per-token renderer. A 0.75–2 second update cadence is acceptable if interruption stays responsive. Optimize deltas only after measurement shows snapshot payloads are a real bottleneck.

A bounded in-memory raw-event view may assist diagnostics, but label it “observed on this connection,” not complete history. Do not retain unbounded event payloads or tool output on disk.

### Reconnection and lifecycle

On stream failure or EOF, mark the transport degraded and reconnect with jittered backoff, starting around 1 second and capping around 30 seconds. Stop retries on rejected credentials until the user updates them. After reconnection, rerun current-state discovery and refresh the open session, unresolved receipts, blockers, previously active children, and background work.

On app background, stop the phone's foreground polling and close its subscriptions according to the app's lifecycle policy. On return, treat observations as stale until refreshed. If the optional server plugin is configured, FCM may alert the user while the app is suspended; push remains a non-authoritative hint and is never required for correctness.

Do not infer a stalled agent from a quiet stream. Show elapsed time since the last confirmed activity; only explicit server errors justify an error state.

## 6. Status derivation and coverage

The execution reducer is deliberately a pure function over observed evidence. It does not make network calls or run a model.

| Evidence category | Presentation rule |
|---|---|
| Active-process membership | Running foreground execution; absence is inactive only for that process's foreground execution scope |
| Session outcome / idle record | Latest reported outcome, not proof of present inactivity or correctness of generated code |
| Assistant text/reasoning content | Render what is exposed; infer no hidden thought content or completion from prose |
| Tool states | Show argument streaming, running, completed, or error without collapsing parallel calls |
| Retry data | Backoff/retry label with exposed attempt/error and next-attempt time |
| Compaction message | Dedicated context-maintenance activity/outcome, not normal assistant prose |
| Pending requests | Needs-you attention attached to the exact owning session; propagate a count to its known ancestors |
| Child and background evidence | Separate activity from the parent's execution and last outcome |
| Unknown or incomplete observations | Unknown/partial, with an inspectable reason, rather than a guessed healthy state |

The separate outcome, retry, tool-state, and compaction structures in v2 are the contract basis for this mapping. [2]

Current execution takes precedence over an older last-run outcome in the headline, but the old outcome remains available in history. Child failure does not automatically become parent failure. A background launch tool can complete while its launched work continues. Structured ownership is required for any cross-session rollup. [4]

Implement a coverage test that enumerates every execution-relevant variant in the pinned client fixtures and verifies either a dedicated renderer or an explicit generic fallback. The product's coverage claim is scoped to exposed, supported API data—not hidden plugin internals.

## 7. Mutation safety

All writes have three separate concepts: **user intent**, **HTTP/transport result**, and **observed server state**. Do not collapse them into a success toast.

### 7.1 Prompt submission

Create a valid client-generated message ID in the pinned format before sending. Keep a content-free local receipt with the server/session IDs, message ID, delivery mode, submission time, and lifecycle state. Use the message ID for correlation; its existence alone does not prove idempotency.

Illustrative v2 request shape: [1][2]

```http
POST /api/session/{sessionID}/prompt
Content-Type: application/json

{
  "id": "msg_<valid-client-generated-id>",
  "text": "Keep the public API unchanged. Fix only the failing tests.",
  "delivery": "steer",
  "resume": true
}
```

The response confirms admission to the server's input system, not task completion. `steer` and `queue` are the documented delivery choices. Validate their actual timing against the pinned server before finalizing user-facing promises. [1][2]

Receipt states:

```text
draft → sending → accepted → observed in conversation
              ↘ rejected
              ↘ outcome unknown → reconcile
```

Only clear the exact draft revision that was submitted. Never clear a newer draft because an earlier request finally returned.

On timeout, connection loss, or ambiguous server failure, look up the same ID in pending input and the projected message endpoint. If found, reconcile as accepted/observed. Absence from one snapshot is not conclusive proof of non-admission; keep the result unknown until the target contract can resolve it.

No automatic mutation retries. A manual retry reuses the same ID and immutable body only after the server's duplicate-ID semantics have been tested. If that guarantee is unavailable, require the user to inspect current state and explicitly create a new intent, warning of duplication risk. No offline outbox and no queue flushing on reconnect.

### 7.2 Running-session delivery

Use the server's inbox rather than inventing a second queue. Fetch pending input while the session is open and include its count on relevant cards. “Guide next step” uses `steer`; “Queue next turn” uses `queue`, subject to pinned-build validation.

A successful HTTP response means the input was accepted, not that the model has consumed it. Pending, consumed, cancelled, and unknown remain distinct. Pending-input editing, cancellation, and promotion controls are deferred; the first release observes the server inbox and never reorders it in local memory.

### 7.3 Interruption

Request interruption with an explicit `resume=false` query value. This is a selected-session operation, not a guaranteed stop of an entire execution tree. The API reports whether active execution was interrupted or the request was an idle no-op. [1]

After acknowledgement, refresh that session, its pending input, known children, and associated background work. Show any activity that remains. An acknowledged interrupt does not roll back file changes. Do not automatically retry an interrupt: a later retry could interrupt new work started by another client.

Do not implement a combined interrupt-then-send saga. In v1 the user performs two explicit steps. This removes an avoidable two-request partial-failure problem.

The documented route does not provide a run-specific conditional cancellation token in the reviewed contract. Preflight reads therefore cannot make interruption atomic with concurrent desktop activity. Label it session-scoped and make the server response/current state authoritative. [1][2]

### 7.4 Permissions and forms

Reply to the exact server/session/request tuple after showing its current payload. Use one-time approval or rejection initially; do not expose persistent policy mutation. Render the pinned form schema with local required/type/range checks and server validation as final authority.

Basic text, numeric, boolean, selection, and multiple-selection inputs can share a small renderer. Respect conditional/hidden-field rules from the pinned schema rather than sending invented answers. External forms open only through an explicit user action. Unsupported fields retain a visible blocked state and an intentional handoff.

Handle resolved/cancelled/deleted request conflicts by refreshing; never replay a stale decision. A network failure leaves decision delivery unknown until a request-state read resolves it. Editing a chat draft is never treated as answering a form.

### 7.5 Concurrent clients and local locks

Prevent duplicate concurrent prompt submissions per session and duplicate replies per request card. Give interruption its own guarded, high-priority action path: a hanging prompt request or historical read must not disable an urgent interrupt. Freeze the destination when each action is initiated. A navigation change cannot retarget an in-flight request.

An interrupt racing with an unacknowledged prompt still has server-defined ordering. Do not report that the pending prompt was cancelled; reconcile both receipts and the inbox afterward. Blocking a second local interrupt while the first is unresolved is not permission to retry it automatically.

These are local protections, not distributed locks. The desktop client remains free to act. Do not overwrite the server's message order or pending-input state with optimistic assumptions. Revalidate changed directory/agent/model context before a new action when practical; do not promise that this removes all concurrent changes.


## 8. Push notifications through an OpenCode plugin + FCM

### 8.1 Why the plugin is the right boundary

Foreground monitoring remains phone-to-OpenCode. Push cannot depend on the phone staying alive: iOS and Android may suspend the application, and FCM sender credentials must never ship in the mobile bundle. The server therefore needs a notification producer that remains active with OpenCode.

For v1, make that producer an OpenCode v2 server plugin: **`@pocket/opencode-plugin`**. V2 plugins can subscribe to the connected server's public event stream, access the same session/permission APIs as a server client, persist JSON through plugin-scoped storage, and register typed RPC methods that external clients can call over OpenCode's existing HTTP server. The generic RPC route is `POST /api/rpc/{rpcID}/{method}`. [13][14][15]

This is materially simpler than a sidecar:

- no second process, port, health check, or reverse-proxy route;
- no duplicate OpenCode authentication configuration;
- no SQLite database: use `ctx.storage`;
- no separate registration API: use plugin RPC;
- the plugin automatically follows OpenCode plugin loading/reloading;
- notification observation is colocated with the state being observed.

Do **not** use session/tool hooks to implement notifications. Hooks can affect live operations; notifications should be observational. Use `ctx.event.subscribe()` plus authoritative reads. A broken notification integration must not modify, delay, reject, or interrupt agent work. [13]

```mermaid
flowchart LR
    APP[Phone app] -->|normal v2 API| OC[OpenCode server]
    APP -->|Pocket RPC: register device/preferences| RPC[Pocket plugin RPC]
    OC --> PLUG[@pocket/opencode-plugin]
    RPC --> PLUG
    PLUG -->|public event stream + authoritative reads| OC
    PLUG -->|FCM HTTP v1| FCM[Firebase Cloud Messaging]
    FCM -->|Android push / APNs for iOS| PHONE[Phone OS]
    PHONE -->|tap| APP
    APP -->|refresh authoritative state| OC
```

A push is **a hint that something changed**, never session truth. Opening a notification always refreshes the relevant OpenCode state before rendering controls. On Apple platforms FCM is delivered through APNs and background delivery is not guaranteed, so push cannot participate in correctness or synchronization. [11][12]

One capability is intentionally lost versus an external watchdog: if the OpenCode process or host is down, its plugin is also down and cannot emit `server_unreachable`. Defer host/server-down push alerts. The normal app still shows an unreachable server when opened. Add an external watchdog only if real usage proves out-of-process liveness alerts are valuable.

### 8.2 Packaging and installation

Ship the notification component as a normal versioned OpenCode v2 plugin package with a stable plugin ID, for example `pocket.controller`. V2 supports global package plugins and automatic plugin lifecycle/reload. The package should also export its RPC definition so the mobile TypeScript client can import exactly the same method/event schema without importing the server implementation. [13][14]

Conceptual package:

```text
@pocket/opencode-plugin
├── src/index.ts      # Plugin.define({ id, setup })
├── src/rpc.ts        # shared Pocket RPC definition
└── package.json      # exports "." and "./rpc"
```

Recommended server configuration:

```jsonc
{
  "plugins": [
    {
      "package": "@pocket/opencode-plugin@0.1.0",
      "options": {
        "firebaseProjectId": "my-pocket-project"
      }
    }
  ]
}
```

Install it globally when the server should support notifications for all projects/locations. Pin the plugin version together with the supported OpenCode build. Keep Firebase sender credentials out of `opencode.json`; prefer Application Default Credentials or a server-side service-account credential supplied through the process environment/filesystem. The FCM sender credential needs only the permissions required to send Cloud Messaging messages. [16]

The notification feature is optional. Core monitoring/control must continue to work when the plugin is absent, outdated, misconfigured, or unable to reach FCM.

### 8.3 Typed RPC surface

Use one RPC ID, `pocket`, with a deliberately small v1 method set:

```ts
type PocketInfo = {
  protocolVersion: 1;
  pluginVersion: string;
  notificationsConfigured: boolean;
};

type DevicePreferences = {
  needsPermission: boolean;
  needsAnswer: boolean;
  sessionFailed: boolean;
  sessionFinished: boolean;
  hideDetails: boolean;
};
```

| RPC method | Purpose |
|---|---|
| `info()` | Capability/version negotiation and notification configuration status |
| `upsertDevice({ deviceId, fcmToken, platform, pairingId, preferences })` | Create or refresh one app installation registration |
| `removeDevice({ deviceId })` | Best-effort unregister when disabling notifications/removing the profile |
| `testNotification({ deviceId })` | Setup diagnostic: verify server credential + FCM path without requiring an agent event |

Do not add RPC methods for ordinary session reads, prompts, interrupts, permission replies, or forms. The mobile app already uses the native OpenCode APIs for those. The plugin is not a shadow controller API.

On server connection, the app attempts `pocket.info()`. If the RPC is unavailable, mark notifications as **Plugin not installed** while leaving all other functionality enabled. If the protocol major version is unsupported, disable only plugin-backed notification controls.

The phone calls the plugin through the same OpenCode base URL/client and therefore does not need another host or port. V2's typed client supports plugin RPC definitions directly; generic HTTP clients can use `/api/rpc/pocket/{method}`. Validate in the pinned build that the RPC route inherits the same authentication and location policy as the rest of the OpenCode server. [14][15]

### 8.4 Device registration and pairing

After notification permission is granted, the phone obtains its current FCM registration token and generates two local stable identifiers:

- `deviceId`: identifies this app installation to the plugin;
- `pairingId`: opaque random ID used in notification deep links to map the push back to the correct local server profile without exposing the hostname.

Register independently with each OpenCode server profile whose notifications are enabled:

```ts
await pocket.upsertDevice({
  deviceId,
  pairingId,
  fcmToken,
  platform: "ios",
  preferences: {
    needsPermission: true,
    needsAnswer: true,
    sessionFailed: true,
    sessionFinished: true,
    hideDetails: false,
  },
})
```

FCM registration identifiers are rotatable and should be treated as secrets/identifiers. On token refresh, call `upsertDevice` again for every enabled server profile. On profile removal or notification disable, call `removeDevice` best-effort and delete the local pairing mapping. The plugin expires registrations that have not been refreshed for a proposed 90 days. [17]

V1 assumes one human user per configured OpenCode server profile. Teams, shared session subscription ACLs, per-session subscriptions, and topic fanout are out of scope. Target individual device registrations rather than FCM topics; Google's guidance recommends registration targets for fast, secure delivery to single devices or small groups. [18]

### 8.5 Plugin runtime and event flow

The plugin `setup()` owns three pieces of runtime work:

1. register the Pocket RPC implementation;
2. start one event subscription task;
3. start one small in-memory notification worker/reconciliation timer.

The event-consumption path must stay cheap. OpenCode's client documentation notes that live subscribers can backpressure the shared source, so do not call FCM or perform expensive reconciliation inline while reading events. Classify the event, add a semantic dirty key to a bounded in-memory set/queue, and return to consuming. A separate worker coalesces keys and performs reads/sends. [15]

```text
OpenCode event
    ↓
cheap classify/filter
    ↓
coalescing dirty set
    ↓
reconcile authoritative state
    ↓
notification policy
    ↓
semantic dedupe
    ↓
FCM send
```

If the dirty set exceeds its bound, discard fine-grained entries and schedule a broader reconciliation rather than blocking the OpenCode event stream. Notification loss is preferable to interfering with coding execution; periodic reconciliation recovers current actionable conditions.

V2 plugin contexts are location-aware and may observe events outside the plugin instance's own location. For location-owned events, process the event using its explicit location and ensure a plugin instance does not send for an unrelated location. Use structured location/session IDs rather than directory-name heuristics. Plugin storage is documented as scoped by plugin ID; validate multi-location visibility and duplicate-instance behavior against the pinned server before release. [13][19]

### 8.6 Notification-worthy conditions

Default notifications stay sparse and actionable:

| Kind | Default | Trigger |
|---|---:|---|
| `needs_permission` | On | A new unresolved permission request exists |
| `needs_answer` | On | A new unresolved form/question exists |
| `session_failed` | On | A watched root session reports a new failed outcome |
| `session_finished` | On | A watched root session transitions from active to inactive/terminal and no known child/background work remains |

Do **not** push token output, each tool completion, retries, normal child progress, queue changes, or “still running” heartbeats. Those belong in the app.

Child requests are actionable even while a root session remains active, so notify them and deep-link to the exact owning child/request while using parent/root context only for orientation.

`session_finished` is conservative. Parent inactivity alone is insufficient; known children and attributable background work must also be inactive. If coverage is partial, suppress the completion push rather than claim completion. If the plugin restarted and lacks a trustworthy active→inactive transition boundary, prefer no completion push over a speculative late one.

### 8.7 Authoritative reconciliation and dedupe

The plugin's live event subscription is also live-only. Plugin reloads/restarts can miss events, so events trigger refreshes rather than becoming the notification database. On plugin setup and periodically (proposed every 30 seconds), reconcile current unresolved permissions/forms and relevant active-session state. [13][15]

Use `ctx.storage` for the small durable state set; no SQLite is needed. Example keys:

```text
device/<deviceId>                  -> registration + preferences + refreshedAt
sent/permission/<session>/<req>    -> sentAt
sent/form/<session>/<form>         -> sentAt
run/<session>                      -> last observed active/outcome boundary
sent/failure/<session>/<boundary>  -> sentAt
sent/finished/<session>/<boundary> -> sentAt
```

A semantic key should identify the condition rather than the raw event envelope, because reconciliation can rediscover the same condition without the original event ID. Request resolution removes/ages out the corresponding dedupe state. Terminal dedupe records may expire after a short retention period such as seven days.

Plugin storage contains no transcript, prompt, tool output, code, shell output, or form answer. It holds only device registrations/preferences, minimal opaque session/request IDs, transition markers, and dedupe timestamps.

### 8.8 Payload design and privacy

FCM payloads are intentionally small and non-sensitive. Never include prompt text, assistant text, code, shell output, filesystem paths, permission command arguments, form answers, OpenCode credentials, server URLs, or Firebase sender credentials.

Conceptual payload:

```json
{
  "notification": {
    "title": "Needs permission",
    "body": "API compatibility cleanup · Reviewer"
  },
  "data": {
    "kind": "needs_permission",
    "pairingId": "opaque-random-id",
    "sessionId": "ses_...",
    "requestId": "req_..."
  }
}
```

`pairingId` maps to a local server profile only on the phone and plugin. It is not a hostname. When **Hide notification details** is enabled, use a generic visible body such as “A coding session needs your attention” while preserving opaque routing identifiers in the data payload.

FCM/APNs is an external metadata processor: Google/Apple necessarily receive routing metadata and the payload. Users can disable remote notifications entirely without affecting foreground control.

### 8.9 Delivery semantics and notification tap

Notification state remains separate from agent state:

```text
condition observed
      ↓
reconciled as currently true
      ↓
eligible + not deduped
      ↓
FCM accepted send request
      ↓
OS may deliver/display
      ↓
user may open
      ↓
app refreshes OpenCode
```

FCM acceptance does not prove device delivery, display, or user attention. Never mark an OpenCode request seen/resolved because a push was sent.

Use visible notification messages for actionable alerts. Silent/data-only pushes may later warm state as a best-effort optimization but are not needed for v1 and must never be the synchronization path. [11]

On tap:

1. resolve `pairingId` to the local server profile;
2. navigate to a loading shell for the exact session/request;
3. refresh the request, owning session, and parent/child context directly from OpenCode;
4. if still pending, render the normal action UI;
5. if another client already resolved it, show the refreshed state with “Already resolved” context;
6. if the server is unreachable, preserve the notification context and show normal stale/offline UI.

Use platform collapse/replacement identifiers based on semantic request identity where available so repeated discovery of one unresolved request does not create a notification pile.

### 8.10 Plugin security and failure isolation

Firebase sender credentials live only on the OpenCode host, preferably through Application Default Credentials or a protected service-account file/environment configuration. The phone receives only its own FCM registration identifier. Never embed a service-account private key in the application bundle. [16]

The plugin RPC must rely on the OpenCode server's authenticated HTTP boundary; validate this explicitly in integration tests. Do not expose a second unauthenticated registration listener. FCM registration identifiers must not appear in logs. [17]

The plugin must fail open with respect to coding execution: catch/log notification errors inside its worker and keep them out of session hooks and user actions. Plugin setup should not make the OpenCode server unusable merely because Firebase credentials are absent; instead `info()` reports `notificationsConfigured: false` and the notification worker stays disabled.

| Failure | Behavior |
|---|---|
| Plugin absent | Notification controls show unavailable; all core app controls still work |
| Plugin reload/restart | Agent execution unaffected; startup reconciliation rediscovers current actionable requests |
| OpenCode process/host down | No push is possible from this architecture; app discovers unreachable state when opened |
| FCM transient send failure | Bounded retry in the plugin worker while the condition remains relevant |
| FCM registration invalid | Remove that device registration; app re-registers on next foreground/token refresh |
| Duplicate event + reconciliation | Semantic dedupe suppresses duplicate visible push |
| Notification opened after resolution | App refreshes and shows resolved/current state |
| Phone offline / OS suppresses push | No correctness impact; app recovers truth on next foreground |

Retries here apply only to notification delivery, never to OpenCode mutations. Section 7's mutation rules are unchanged.


## 9. Mobile rendering and resource limits

Use a virtualized session list and conversation timeline. Render tool outputs collapsed, with a proposed 8 KiB preview cap. Reveal available full output on demand and use paged server output endpoints where supplied. If the server itself retained only a truncated result, say so; do not imply the full output exists elsewhere.

Keep a bounded number of message pages in memory; refetch evicted pages when revisited. Protect interrupt controls from expensive rendering work. Never render large raw JSON objects synchronously in the main timeline.

The Now line is a pure template over observed state. The unread feature uses local message/read boundaries and persisted conversation outcomes. Do not manufacture a changelog for transient activity missed while disconnected.

Show code and markdown as untrusted content. Do not run HTML, JavaScript, terminal escape sequences, or commands contained in output. Disable automatic external image fetching by default. Opening an output URL does not forward OpenCode credentials.

## 10. Security and deployment

Require authenticated HTTPS for the supported release path, with standard certificate validation. Do not ship a “trust any certificate” switch. A phone must already be able to reach the configured endpoint; this application does not solve NAT traversal or create a tunnel.

OpenCode v2's web/server documentation describes password-protected access and pairing information. Match the pinned build's actual authentication scheme in the adapter; verify it with a contract test instead of assuming that a generic Bearer-header example defines the server's password protocol. [3][5]

Store credentials in SecureStore, which uses platform-protected encrypted storage. Do not place them in query strings, nonsecret settings, diagnostic exports, or application logs. SecureStore has platform-dependent payload limits, another reason not to use it as a transcript database. [8]

Do not follow redirects to a different origin while carrying credentials. Treat returned advertised URLs as data, not an instruction to silently switch the connection. Retain the user-approved HTTPS endpoint.

Redact prompt bodies, code, tool output, authorization headers, and server filesystem paths from routine diagnostic logging. Log only action category, profile-local identifier, status code/error category, latency, reconnect count, and coverage counters. No third-party content analytics in v1.

Explicit removal deletes credentials, read markers, receipts, and cache for the profile. Do not rely on app uninstall as credential revocation. Server-side credential rotation remains the revocation mechanism. [8]

## 11. Verification plan

### Contract spike: required before feature implementation

Pin and record the server/client build. On real iOS and Android devices, validate authentication, SDK transport, event consumption, cancellation, and reconnection. Capture fixtures for running/inactive sessions, successful/failed/interrupted outcomes, concurrent tools, retry, compaction, children, forks, background shell activity, permission requests, and forms.

Explicitly test: duplicate prompt IDs with identical and different bodies; response loss after admission; `steer` versus `queue` while busy and inactive; parked input after interruption; `resume=false`; active/idle interruption; foreground and background children; simultaneous desktop actions; Pocket RPC authentication/capability negotiation; FCM token registration/refresh/revocation; plugin reload with an already-pending request; multi-location plugin behavior; event-consumer backpressure/overflow; duplicate event plus reconciliation; notification tap after another client resolves the request; missing Firebase credentials; and iOS/Android foreground/background notification behavior. Record unsupported behaviors and gate only those controls—not the whole read path.

### Acceptance tests

| Test | Assertion |
|---|---|
| Same session ID on different servers | Queries, drafts, receipts, and actions remain isolated |
| More than one metadata page | Older active/blocked work is visible; coverage does not stop at page one |
| Nested child, missing parent, independent fork | Correct navigation and honest relationship classification; no false worker counts |
| Parent becomes inactive with background work remaining | Family activity persists with the right ownership/scope |
| Tool error, retry, then success | Distinct tool failure and final outcome; no stale failure headline |
| Request exists before app launch | Snapshot discovery finds it without relying on a new event |
| Event arrives during snapshot read | Dirty counters trigger refresh; old results do not overwrite a new connection |
| Stream EOF, overflow, background/resume, changed PID | Reconciliation restores state; transport/freshness remain explicit |
| Request accepted but HTTP response lost | No automatic duplicate and no premature “failed” label |
| Interrupt response lost | Unknown result; no automatic retry against a potentially newer execution |
| Prompt request hangs while user interrupts | Interrupt remains usable on its own action path; both outcomes reconcile without assuming pending input was cancelled |
| Another client replies first | Stale form/permission is reconciled without replay |
| Unknown event / form field | Visible fallback and diagnostic signal, no false healthy state |
| Large output and sustained event burst | Bounded memory, responsive navigation and interrupt controls |
| HTTP/TLS/auth/compatibility failures | Distinct actionable error states; credentials never enter logs |
| Plugin reload with pending permission/form | Reconciliation emits at most one actionable push for the still-pending condition |
| Duplicate live event plus reconciliation | Semantic dedupe produces one user-visible notification |
| Notification opened after request resolved elsewhere | App refreshes and shows resolved/current state; no stale action is replayed |
| Invalid/rotated FCM token | Plugin removes invalid registration; app re-registers refreshed token |

Use the PRD's load and freshness targets as the benchmark. A small local diagnostic panel and reproducible fixtures are enough; no observability warehouse is needed.

## 12. Implementation order and stop rules

**Slice A:** one server, one session, physical phone; prove reads, prompt, interrupt, permission, form, and recovery.

**Slice B:** multiple servers and full session inventory; add worker relationships, current activity, and complete/partial coverage.

**Slice C:** delivery receipts, pending input, concurrent-client handling, and the failure matrix.

**Slice D:** `@pocket/opencode-plugin`, Pocket RPC capability/device registration, FCM delivery, permission/form pushes, conservative failure/completion pushes, deep-link refresh, and notification privacy controls.

**Slice E:** mobile reading, attention navigation, unread boundaries, resource tuning, and a small pilot.

Do not let the notification plugin grow into a shadow controller API or modify agent execution. Do not add durable event-log replication unless snapshots cannot meet a measured need. Do not add generalized abstractions for another coding agent before supporting another agent is actually a committed requirement. Add an external watchdog only if out-of-process server-down alerts become a demonstrated requirement.

The minimal durable product is **one app, one official client per server, snapshot-backed state, complete exposed execution visibility, a small set of explicit controls, and an optional OpenCode plugin that emits non-authoritative FCM push hints.**

## Sources

Public documentation reviewed September 24, 2026. Architecture, data models, algorithms, budgets, and acceptance criteria are proposed design decisions. No live target-server integration tests were performed for this draft.

[1] OpenCode v2 HTTP API: https://opencode.ai/v2/docs/api/  
[2] OpenCode v2 OpenAPI contract: https://opencode.ai/v2/openapi.json  
[3] OpenCode v2 JavaScript client: https://opencode.ai/v2/docs/build/client/  
[4] OpenCode v2 tools: https://opencode.ai/v2/docs/tools/  
[5] OpenCode v2 web/server setup: https://opencode.ai/v2/docs/cli/web/  
[6] OpenCode v2 permissions: https://opencode.ai/v2/docs/permissions/  
[7] Expo fetch/streaming: https://docs.expo.dev/versions/latest/sdk/expo/  
[8] Expo SecureStore: https://docs.expo.dev/versions/latest/sdk/securestore/
[9] Firebase pricing: https://firebase.google.com/pricing
[10] Firebase pricing plans / no-cost products: https://firebase.google.com/docs/projects/billing/firebase-pricing-plans
[11] Firebase Cloud Messaging — receive messages on Apple platforms: https://firebase.google.com/docs/cloud-messaging/ios/receive-messages
[12] Firebase Cloud Messaging — Apple platform setup: https://firebase.google.com/docs/cloud-messaging/ios/get-started
[13] OpenCode v2 plugin overview: https://opencode.ai/v2/docs/build/plugins/
[14] OpenCode v2 plugin RPC: https://opencode.ai/v2/docs/build/plugins/rpc/
[15] OpenCode v2 JavaScript client / plugin RPC and event semantics: https://opencode.ai/v2/docs/build/client/
[16] FCM trusted server environment / credentials: https://firebase.google.com/docs/cloud-messaging/server-environment
[17] FCM registration management: https://firebase.google.com/docs/cloud-messaging/manage-tokens
[18] FCM topic messaging guidance: https://firebase.google.com/docs/cloud-messaging/topic-messaging
[19] OpenCode v2 plugin V1 migration / storage and location notes: https://opencode.ai/v2/docs/build/plugins/migrate-v1
