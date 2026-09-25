# Contributing to Pocket Control

Thanks for helping out. Bug reports, fixes, docs and feature ideas are all welcome.

## Before you start

- **Bugs:** open an issue with your OpenCode version (`opencode --version`), the app platform (Android / iOS / web), what you did, and what you expected. Leave out server URLs, passwords and transcript content.
- **Features:** open an issue first for anything bigger than a small fix, so we can agree on the approach before you spend time on it. The [product requirements](docs/prd.md) and [technical design](docs/technical-design.md) explain the reasoning behind the current behavior.
- **Security issues:** don't open a public issue. Use [GitHub private vulnerability reporting](https://github.com/rifqi2320/opencode-pocket/security/advisories/new) instead.

## Setup

Requirements: Node.js 20.19+ and npm. Native builds also need the Expo iOS/Android toolchains.

```sh
git clone https://github.com/rifqi2320/opencode-pocket.git
cd opencode-pocket
npm install
npm run web        # quickest loop; UI previews at http://localhost:8081/#preview/sessions
```

Push notifications need your own Firebase project. See [Android build and Firebase](README.md#android-build-and-firebase) and [plugin/README.md](plugin/README.md).

To try plugin changes, point your OpenCode config at your checkout (`"package": "/abs/path/to/opencode-pocket/plugin"`). OpenCode hot-reloads the plugin when its files change.

## Checks

Run all of these before opening a pull request:

```sh
npm run typecheck
npm test
cd plugin && npm test
```

Tests use `node --test` and need no extra dependencies. Pure logic sits in files with no React Native imports (`src/core/*Logic.ts`, `src/core/folders.ts`, `src/ui/behavior.ts`, …) so it can be tested directly. Keep it that way when adding logic.

For UI changes, include a screenshot from the web preview (`#preview/sessions`, `#preview/projects`, `#preview/detail`, `#preview/servers`, `#preview/empty`) in light and dark mode.

## Code guidelines

- **Match the surrounding code.** Follow the existing naming, file layout, comment density and idioms.
- **Keep the boundaries:** `src/core/**` owns networking, persistence and mutations. `src/ui/**` renders view projections (`src/ui/types.ts`) and never calls the OpenCode API directly. `App.tsx` adapts one to the other.
- **Show only real state.** The app never fabricates or guesses server state. When something is unknown, stale or unsupported, say so in the UI.
- **Secrets stay out of logs, URLs and storage other than SecureStore.** Never commit `google-services.json`, service-account keys or APKs; they're gitignored.
- **The plugin is observational.** It must never block, delay or change agent work, and it must stay free of runtime dependencies.
- **Plugin protocol changes must stay backward compatible** with already-installed apps and plugins. Add optional fields rather than changing required ones, and bump `plugin/package.json`'s version.

## Pull requests

- Keep each PR focused on one change, and explain what it does and why.
- Add or update tests for behavior changes.
- Update `README.md` / `plugin/README.md` when user-facing behavior or options change.
- Use [Conventional Commits](https://www.conventionalcommits.org/) for commit messages if you can (`feat:`, `fix:`, `docs:`, …).

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
