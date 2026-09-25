# @pocket/opencode-plugin

OpenCode v2 server plugin that sends **Pocket Control** push notifications through Firebase Cloud Messaging (FCM HTTP v1).

- Observational only. It reads the server event stream (`ctx.event.subscribe`) and never registers session, tool or permission hooks, so it cannot block, delay or change agent work. All errors are caught and logged.
- Registers the `pocket` RPC so the phone can register itself over the same OpenCode URL and auth: `POST /api/rpc/pocket/{method}`.
- No runtime dependencies. OAuth tokens are minted from a service-account key with `node:crypto` (JWT RS256) and cached until they expire.
- Tested against OpenCode **v2.0.12** (plugin SDK `@opencode/plugin` 2.0.8).

## Install

The plugin needs Firebase sender credentials on the OpenCode host (see [Credentials](#credentials)). Plugin options go in the `plugins` array of `opencode.json`.

### Global (recommended)

Global install makes the `pocket` RPC available in every location. That includes the server's default location, which the phone uses when it calls RPC without a `location` query.

`~/.config/opencode/opencode.json`:

```jsonc
{
  "plugins": [
    {
      "package": "@pocket/opencode-plugin@0.2.0",
      "options": {
        "credentialsFile": "/etc/opencode/firebase-sender.json" // optional; else GOOGLE_APPLICATION_CREDENTIALS
      }
    }
  ]
}
```

Or run `opencode plugin add @pocket/opencode-plugin@0.2.0` and then add `options`.

### Local checkout

Point `package` at the **absolute** path of this folder. OpenCode loads `<folder>/index.js` and hot-reloads it when files change:

```jsonc
{ "plugins": [ { "package": "/abs/path/to/opencode-pocket/plugin", "options": {} } ] }
```

### Per project

Put the same entry in `<project>/opencode.json`. Only locations inside that project load the plugin. If the server's working directory is outside the project, the phone must pass the project directory as `location` (see the wire format below). Otherwise `info` returns `rpc.unavailable`.

### Options

| Option | Default | Meaning |
|---|---|---|
| `credentialsFile` | `$GOOGLE_APPLICATION_CREDENTIALS` | Path to a Firebase service-account JSON |
| `firebaseProjectId` | `project_id` from the credentials | FCM project to send through |
| `projectName` | basename of the project directory | Name shown in notification titles |
| `throttleSeconds` | `10` | Minimum interval per device + session + kind |
| `events` | all kinds | Kinds this server pushes at all: any of `permission`, `question`, `failed`, `finished`, `interrupted`. Phones only show toggles for these. |
| `subagents` | `true` | Allow phones to opt into subagent `finished` / `failed` / `interrupted` pushes |
| `minRunSeconds` | `0` | Skip `finished` pushes for runs shorter than this |
| `hideDetails` | `false` | Force generic notification text for every device, whatever its preference |
| `verbose` | `false` | Log info-level messages (never tokens or keys) |

Invalid option values are ignored, with a warning in the server log.

Example: only push requests and long runs, never subagents:

```jsonc
{
  "package": "@pocket/opencode-plugin@0.2.0",
  "options": { "events": ["permission", "question", "finished"], "minRunSeconds": 120, "subagents": false }
}
```

## Credentials

1. Firebase console → Project settings → Service accounts → *Generate new private key*. Alternatively, create a dedicated service account that has only the *Firebase Cloud Messaging API Admin* role (`roles/firebasecloudmessaging.admin`).
2. Store the file on the OpenCode host, readable only by the OpenCode user (`chmod 600`). Never commit it, and never ship it in the app.
3. Either set `GOOGLE_APPLICATION_CREDENTIALS=/path/to/key.json` in the OpenCode server's environment (for the background service, in its service environment), or set `options.credentialsFile`.

If credentials are missing or invalid, the plugin still loads. `info()` then returns `notificationsConfigured: false`, and no events are processed.

## RPC (wire format)

All calls are `POST {base}/api/rpc/pocket/{method}` and use the same auth as the rest of the server (HTTP Basic, user `opencode`, password `OPENCODE_SERVER_PASSWORD`). Send `content-type: application/json`.

- Request body: `{"input": <value>}`. The `input` key is required, even for `info`. Use `{"input":{}}` or `{"input":null}`. A body of `{}` fails with `rpc.invalid_input`.
- Success: HTTP 200, `{"output": <value>}`.
- Error: HTTP 400, `{"_tag":"RpcError","type":"rpc.unavailable"|"rpc.method_not_found"|"rpc.invalid_input"|..., "message": "..."}`. `rpc.unavailable` means the plugin isn't loaded in that location. Malformed JSON returns HTTP 400 with `{"_tag":"InvalidRequestError",...}`. Bad credentials return HTTP 401.
- Optional location: add `?location%5Bdirectory%5D=/abs/dir` to target a specific location. Without it, the call goes to the server's default location.

| Method | Input | Output |
|---|---|---|
| `info` | anything | `{ protocolVersion: 1, pluginVersion, notificationsConfigured, events, subagents }` (`events`/`subagents` since 0.2.0) |
| `upsertDevice` | `{ deviceId, fcmToken, platform: 'android'\|'ios', pairingId, preferences }` | `{ ok: true }` |
| `removeDevice` | `{ deviceId }` | `{ ok: true }` (also when unknown) |
| `testNotification` | `{ deviceId }` | `{ ok: true }` or `{ ok: false, error }` |

Clients can import the JSON-Schema RPC definition and types from `@pocket/opencode-plugin/rpc` (no server code).

## Preferences

Each device registration has independent preferences, chosen on the phone. The server options above decide which kinds exist at all; preferences pick among them. Call `upsertDevice` again to change them or to refresh the FCM token. Registrations that aren't refreshed for 90 days expire.

| Preference | Push when |
|---|---|
| `needsPermission` | A new permission request is asked (`permission.asked`) in any session, subagents included |
| `needsAnswer` | A new question/form is created (`form.created`) |
| `sessionFailed` | A session's execution fails (`session.execution.failed`). Subagents only with `includeSubagents`. |
| `sessionFinished` | A session goes from running to idle/succeeded, and the plugin saw it start. Off by default in the app. Never sent for interruptions, runs shorter than `minRunSeconds`, or runs that started before the plugin loaded. Subagents only with `includeSubagents`. |
| `sessionInterrupted` | A run is interrupted (`session.execution.interrupted`). Optional, default `false`. Subagents only with `includeSubagents`. |
| `includeSubagents` | Also send the three outcome kinds above for subagent sessions (requires the server option `subagents`). Optional, default `false`. Permission requests and questions always notify, subagents included. |
| `hideDetails` | Show a generic title (`OpenCode needs you` / `Session update`) and body, with no project name, session title, command or error text. The routing `data` doesn't change. |

Requests answered before the push goes out are skipped. Every condition is deduplicated by request, form or event id, and the dedupe records are kept in plugin storage (bounded to 500, 7-day retention). If FCM says a token is invalid (`UNREGISTERED`, HTTP 404, or `INVALID_ARGUMENT` about the registration token), the device is removed automatically. Transient FCM errors get one retry.

## Push payload

- `notification`: `{ title, body }`. The body is at most 120 characters.
- `data` (all values are strings): `{ pocket: '1', pairingId, kind: 'permission'|'question'|'failed'|'finished'|'interrupted'|'test', eventId, sessionId? }`.
  - `eventId` is the permission request id (`per_…`), the form id (`frm_…`), the session event id (`evt_…`), or `test-…`.
  - `sessionId` is missing only for `test`.
- `android`: `priority: HIGH`, `ttl: 86400s`, `notification.channel_id`: `pocket-attention` (permission/question) or `pocket-updates` (failed/finished/interrupted/test), and `tag`/`collapse_key` = `${kind}-${sessionId}`.
- `apns`: `apns-priority: 10`, `apns-collapse-id` = same tag, `aps.thread-id` = sessionId.

A push is only a hint. The app must refresh state from OpenCode when a notification is opened.

## Development

```sh
cd plugin && npm test   # node --test, no install needed
```
