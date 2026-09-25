# Pocket Control

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Sponsor](https://img.shields.io/badge/Sponsor-%E2%9D%A4-db61a2?logo=githubsponsors&logoColor=white)](https://github.com/sponsors/rifqi2320)
![Expo](https://img.shields.io/badge/Expo-57-000020?logo=expo)
![OpenCode](https://img.shields.io/badge/OpenCode-v2-blue)

Pocket Control is a phone app for keeping an eye on your [OpenCode](https://opencode.ai) v2 sessions. It lists what needs your attention first, lets you reply to permission requests and questions, send prompts and interrupt runs, and can push a notification when a session needs you.

It only shows live data. Until a server connection succeeds, the home screen is empty. It never shows sample sessions.

> **Status:** 0.1.0, early. The web build is fine for UI review. Test native HTTPS and event streams on a real device before you leave the app watching unattended work.

## Features

- **Attention first.** Sessions waiting on a permission or a question sort above sessions that are just running.
- **Multiple servers.** Each server keeps its own name and project in the list and in the detail view.
- **Honest states.** Offline, auth failure, version mismatch and partial data each have their own UI. A prompt shows as acknowledged by the server, not as finished.
- **Forms.** Answer OpenCode questions and permission requests from the phone. If this build can't render a form, the app sends you to the OpenCode client instead of guessing an answer.
- **Push notifications (Android).** Optional. Needs the companion [OpenCode plugin](plugin/README.md), which sends through Firebase Cloud Messaging.
- **Light and dark mode.** Follows the system setting.

## Repository layout

| Path | What it is |
| --- | --- |
| `App.tsx`, `src/ui/` | Expo / React Native app: screens, design system, view models |
| `src/core/` | Networking, persistence, query snapshots, mutations, notification logic |
| `plugin/` | `@pocket/opencode-plugin`, the OpenCode server plugin for FCM push ([README](plugin/README.md)) |
| `compatibility/` | The OpenCode v2 contract this build is pinned to |
| `scripts/` | Contract smoke test against a live OpenCode server |
| `docs/` | [Product requirements](docs/prd.md) and [technical design](docs/technical-design.md) |

## Getting started

Requirements: Node.js 20.19+ and npm. Native builds also need the iOS/Android toolchains that Expo requires.

```sh
npm install
npm run start      # Expo dev server
npm run android    # native Android build
npm run ios        # native iOS build
npm run web        # browser
```

Checks:

```sh
npm run typecheck  # tsc
npm test           # node --test
npm run check      # typecheck + static web export
cd plugin && npm test
```

### Android build and Firebase

Push needs a Firebase project. `google-services.json` is gitignored, so each build supplies its own:

1. In the Firebase console, add an Android app with package `app.pocketcontrol.mobile`.
2. Download `google-services.json` into the repository root. `app.json` already points to it.
3. Run `npx expo prebuild --clean` and then `npm run android`.

Never commit Firebase **service-account / admin SDK** keys. Only the OpenCode host running the plugin needs one. See [plugin credentials](plugin/README.md#credentials).

## Connecting a server

Open **Servers → +**, enter an HTTPS URL and the server password if one is set, then connect.

- Server profiles and delivery receipts are stored in AsyncStorage (localStorage on web).
- Passwords are stored in Expo SecureStore on iOS/Android. On web they go in localStorage, which is **not encrypted**, so only use a browser profile you trust.
- Don't put credentials in the URL.
- The phone must already be able to reach the server. Pocket Control does not set up servers or VPNs, does not bypass TLS, and does not follow redirects to another origin.

## Notifications (Android)

1. Install the [Pocket plugin](plugin/README.md) on the OpenCode server. Without it, everything else still works and the server row shows **Plugin not installed**.
2. In **Servers → (server)**, turn on **Notifications**. The app asks for notification permission and registers this device's FCM token at `POST {server}/api/rpc/pocket/upsertDevice`, using the same URL and password as other requests.
3. Choose which events notify you (permission requests, questions, failures, finished sessions), hide details on the lock screen if you want, or tap **Send test**.

A push only tells the app to look. Tapping one refreshes from live OpenCode state and opens the session. The payload carries an opaque `pairingId`, never the server URL. There are two channels: `pocket-attention` (high priority) and `pocket-updates`. iOS push (APNs) and web push are not supported yet.

## UI preview

In a web dev build, `http://localhost:8081/#preview/sessions` shows the screens with fixture data. The other previews are `#preview/detail`, `#preview/servers` and `#preview/empty`.

## Contributing

Issues and pull requests are welcome. Before you open a PR, run `npm run typecheck`, `npm test` and `cd plugin && npm test`.

## Sponsor

If Pocket Control saves you trips back to your desk, please consider [sponsoring on GitHub](https://github.com/sponsors/rifqi2320). Sponsorships help pay for continued work on the app and the plugin.

## License

[MIT](LICENSE) © 2026 Rifqi Naufal Abdjul
