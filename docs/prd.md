# Pocket Control — Product Requirements Document

**Status:** Exploratory first-release draft  
**Date:** September 24, 2026  
**Audience:** Product, design, and the engineer building the first release  
**Companion:** `TD.md`

## 1. Product decision

Build a phone-sized control surface for coding work already running in OpenCode: **see what is happening, understand what needs you, and respond to the right session.**

This is not a mobile IDE, another agent runtime, or a prettier chat window. Its distinguishing feature is that the primary agent is not allowed to hide everything happening underneath it.

Working name: **Pocket Control**. The name is provisional; branding is not a release dependency.

### API baseline and assumptions

“opencode2” is interpreted as OpenCode v2's `serve` HTTP API, not the older v1 API. Public v2 documentation was reviewed on the date above. The v2 API is experimental; a specific server/client pair must be pinned before implementation. No user's live server or private fork was available for integration testing. [1]

The proposed first release is a single-user iOS/Android application. The user already has running servers, model credentials, projects, and a phone-reachable authenticated HTTPS route, optionally over an existing VPN. The product does not provision any of these. Sessions may also be controlled from a desktop client at the same time.

## 2. The job to be done

> I have several coding sessions across machines. Away from my desk, I need to know what each one is actually doing, drill into its workers and output, unblock it, stop it, or give it the next instruction—without opening several terminals.

The core loop is **scan → inspect → decide → act → verify**. A release that displays transcripts but hides blocked subagents fails. A release that sends messages but cannot tell whether the server accepted them also fails.

### Concrete walkthrough

The user opens the app and sees three servers. An API-refactor session needs a permission decision in its reviewer child. A UI session is running tests. A third server is unreachable and retains its last observed state with a stale label. The user opens the reviewer, reads the actual request, approves it once, returns to the parent, and sends “Do not change the public interface.” The app shows that the server accepted the message, then the latest execution state. The user never has to mistake “accepted” for “finished.”

## 3. First-release boundary

| Ship | Deliberately do not ship |
|---|---|
| Manually saved connections to multiple servers | Accounts, organizations, billing, sharing, or cloud synchronization |
| Unified existing-session inventory with server/project filters | Server provisioning, tunnel creation, SSH terminal, or repository cloning |
| Root sessions, child sessions, foreground/background work, and actionable blockers | A new scheduler, agent orchestrator, or workflow engine |
| Readable conversation and expandable execution details | File editing, terminal input, commit/merge/revert controls, or a full diff workstation |
| Send, guide a running session, inspect queued input, and interrupt the selected session | An app-owned execution queue, scheduled prompts, cross-server broadcast, or automatic retry of mutations |
| Permission decisions and supported question/form replies | Automatic approvals, permission-policy administration, or custom plugin configuration |
| Honest freshness, reconnect recovery, and visible action receipts | Always-on monitoring, push notifications, widgets, or background-service guarantees |
| Existing agent/model visibility | Model/provider setup, agent creation, or a new-session wizard |

Session creation can be the first addition after the core loop is proven. It is not necessary to release a useful controller for existing work.

## 4. Information architecture: three screens

### 4.1 Sessions — the attention-first home

One cross-server list, with filters for server, project, and attention state. The default groups are **Needs you**, **Working**, and **Ready / recent**. Unreachable servers remain conspicuous rather than silently vanishing.

Each root-session card contains the server alias, project/directory, title, current execution summary, latest meaningful activity, child activity counts, pending-input count, last observed time, and unread marker. Unknown counts display as unknown or still loading—not zero.

A hypothetical card:

```text
NEEDS YOU · 1 request
API compatibility cleanup
workstation · ~/src/api

Main: running
Review worker: needs permission to run a command
Children: 1 running · 1 waiting · 2 finished
Last observed 2 seconds ago
```

The card is a summary, not the only place where information exists. Tapping the request opens its owning child and exact request, not merely the parent transcript.

Keep ordering stable while the user reads. Move cards across attention groups when their meaning changes, not on every streamed token. Search includes title and project; historical results may load progressively.

### 4.2 Session — the place to understand and act

The header always shows **server → project → session**, the selected agent/model when available, and freshness. A child session additionally shows its parent breadcrumb.

At the top is a compact **Now** panel: what the selected session is doing, whether anything needs input, and whether children or background work remain active. Below it, a collapsible worker list displays the relationship tree. Use rows and breadcrumbs, not a zoomable graph.

The conversation remains readable: user messages, assistant output, code blocks, visible errors, and an unread boundary. Tool activity is collapsed into compact rows with status, duration when supported, tool name, and a useful preview. Expansion reveals exposed inputs, outputs, identifiers, timestamps, errors, and metadata. Parallel tool calls must not be reduced to a single misleading label.

The bottom composer is attached to the selected session. Its target stays visible above the keyboard. Navigating into a worker does not secretly keep sending to the parent. Drafts are keyed to their destination.

Use the same screen for roots and children. This keeps implementation small and makes child control useful rather than a separate feature family.

### 4.3 Servers — setup and diagnostics

Add a display name, HTTPS base URL, and credentials. Test the connection before saving. Show separate outcomes for unreachable host, TLS failure, rejected credentials, incompatible API, and connected server.

Allow edit, reconnect, and remove. Removing a connection removes local credentials and cache only; it never stops or deletes remote work. Changing an endpoint invalidates the old connection's cache and requires revalidation.

Show supported server version, current transport mode, last successful synchronization, and partial-coverage warnings. Do not expose a full infrastructure dashboard.

## 5. What “every status” means

**Every execution-relevant state exposed by the supported API must have a visible representation.** This does not promise access to private model reasoning, hidden plugin internals, or operating-system processes that OpenCode does not expose.

A single status enum cannot express this product. A session may be running, have a child waiting for approval, contain a failed tool call that it recovered from, and have an older successful outcome at the same time.

| Dimension | Required product representation |
|---|---|
| Connection and freshness | Connecting, synchronized, refreshing, stale, unreachable, authentication failure, incompatible API; last observation time |
| Session execution | Running, inactive, or unknown; never infer success from absence of activity |
| Latest run outcome | Successful, failed, interrupted, or not reported; clearly separate historical outcome from current execution |
| Current phase | Generating output, exposed reasoning activity, tool execution, retry/backoff, compaction, waiting, or unknown activity |
| Tools | Argument generation, running, completed, error; inspect all concurrent calls and available output |
| Children | Relationship, agent, activity, outcome, own blockers, nested children, and foreground/background mode when exposed |
| Human input | Permission request, question/form, cancelled/answered request, or unsupported interaction requiring another client |
| Prompt delivery | Local draft, sending, accepted by server, pending input, observed in conversation, rejected, or outcome unknown |
| Background work | Exposed shell/task/terminal activity, completion or exit state, available output, and ownership confidence |
| Context changes | Agent/model/location changes, compaction, exposed task/checklist data, changed-file references, and usage when available |

These are application presentation categories, not a claim that the server publishes one corresponding enum. The technical design maps them to observed evidence. The v2 contract includes separate session outcomes, tool states, retry information, and compaction messages; its tools also support background shell and child-session work. [2][4]

### Non-negotiable interpretation rules

**Inactive is not completed.** A successful parent does not imply its background children are finished. A completed tool call that launched background work does not imply that work has ended. A failed tool call does not automatically mean the session failed. Silence does not prove a hang. Losing the connection does not mean execution stopped.

Distinguish a subagent from an independently forked conversation. Where the relationship cannot be established, say “child session” or “unattributed background work” rather than inventing ownership.

A root summary rolls up actionable descendant requests even while collapsed. A mixed family can read “Main running · one child needs you.” Unknown descendant coverage prevents an “all finished” claim.

## 6. Controls and their semantics

### Send to an inactive session

The user types a prompt and sends it. The draft becomes an outgoing message with an explicit delivery receipt. Acceptance clears only the submitted version of the draft, not text the user typed afterward. The server continues using the session's existing configuration.

### Send while work is running

The composer offers **Guide next step** and a secondary **Queue next turn**, using the server's own delivery modes rather than an app-owned queue. Explain that guidance is not an emergency interruption. The exact consumption boundary must be validated against the pinned build before finalizing the labels. Pending input is visible, including input added from another client. [1][2]

A queued item is not called “executing.” A prompt that remains parked after interruption is explicitly shown as pending; do not silently flush it.

### Interrupt

Use **Interrupt this session**, naming the exact target. Display “Requesting interruption…” until the response/state check resolves it. Distinguish “no active execution to interrupt,” “interruption acknowledged,” and “outcome unknown.”

Do not imply that interruption reverts files, kills every subprocess, interrupts all descendants, or cancels every queued prompt. Refresh the selected session and its family afterward and show remaining activity. The first release has no “stop everything” button.

Interrupt and send are separate actions. Do not build an automatic two-request “stop and replace” transaction in v1. The user can interrupt, inspect the result, then send the correction.

### Permissions and questions

Requests are first-class attention items, including those owned by children. Show the actual action/resources and relevant context before approval. Initially offer **Allow once** and **Reject**; persistent “always allow” is deferred.

Answer common questions with the server's form controls, not an unrelated chat message. Support the pinned contract's basic field types and validation. External/unsupported interactions remain visible with an explicit handoff, never disappear. The question tool depends on interactive form support. [4]

When another client already answered or cancelled a request, refresh and show “Already resolved elsewhere.” Do not replay the stale response.

### Offline and ambiguous delivery

Reading the in-memory last-known state and drafting remain possible after a disconnect. Sending and approvals require reachability; do not schedule them for later. An urgent interrupt may be requested against a reachable session whose displayed state is stale, with an explicit unverified-state label.

A lost HTTP response is not proof that a prompt failed. Keep an “outcome unknown” receipt and reconcile before offering another attempt. Never automatically send the same intent under a new identifier.

## 7. Small creative features worth keeping

### The Now line

Generate a deterministic sentence from observed state: “Running tests; reviewer needs permission.” No extra model call, provider key, cost, or speculative summary. Always allow opening the underlying evidence.

### Since you last looked

Keep a local read boundary and highlight newer persisted messages and outcomes. A short strip can say “New output · one worker finished · one request waiting” only where the relevant changes are observable. After a gap, distinguish reconstructed conversation changes from transient events that were not retained. Never market it as a complete audit trail.

### Next thing that needs me

A button moves to the next unresolved request across servers. It performs navigation only. It does not batch approvals, choose answers, or mutate another session behind the user's back.

Ideas intentionally parked: generated voice briefings, live-activity widgets, automatic prioritization, global emergency stop, and AI-written suggested instructions. Each adds responsibility before the basic loop is reliable.

## 8. Mobile usability requirements

Optimize for one-handed use, readable typography, large touch targets, and a composer that remains usable with the keyboard open. Status is communicated through words and icons, not color alone. Support system text scaling and screen-reader labels.

Keep server/project identity visible before every mutation. Preserve scroll position when new output arrives; show “New output” instead of pulling the reader to the bottom. Long command output must not block navigation or interruption. Truncated previews must visibly say so and offer access to available full output.

Drafts survive navigation and temporary network loss within the running app. Persisting sensitive draft text across process termination is intentionally not promised in v1. Communicate this limitation rather than silently claiming offline-first behavior.

## 9. Release acceptance and success targets

These are proposed acceptance targets, not measured performance claims. Test on a representative iPhone and Android phone against the pinned server build.

| Acceptance case | Passing result |
|---|---|
| Five servers; 100 root sessions and 100 children total | Usable scrolling, correct identity isolation, complete metadata pagination, and no requirement to load every transcript |
| A blocked child belongs to a parent outside the initial page | The active/requesting child is discovered and its parent becomes reachable; no hidden blocker |
| Parent inactive; child or background shell still active | Family summary does not say all work is finished |
| Tool failure followed by recovery | Tool error remains inspectable; final session outcome is not incorrectly overwritten |
| Stream drops and phone reconnects | Authoritative state converges; stale state never masquerades as live |
| Prompt accepted but response lost | No automatic duplicate; receipt remains unknown until reconciled |
| Desktop resolves a request first | Mobile refreshes the stale card and does not resubmit |
| Two servers return the same session ID | No display, draft, or control crosses server boundaries |
| New/unsupported event or form | No crash or fabricated state; visible fallback/compatibility warning |
| Large output or event burst | Reading and interrupt controls remain responsive; partial data is explicit |

Usability target: identify the session needing intervention within 10 seconds in a seeded multi-server scenario, and reach its request in no more than two taps. Freshness target: foreground status changes visible within 2 seconds at the 95th percentile under the agreed reference load/network. Recovery target: the open session and actionable blockers refreshed within 5 seconds after connectivity is restored under that same test setup. Historical pagination may take longer and must show progress.

The primary product measure is the proportion of real away-from-desk interventions completed without returning to a computer. For a small pilot, capture this through scenario tests and a short user diary instead of building an analytics platform. Any duplicate or misdirected mutation is a release blocker.

## 10. Delivery sequence

**First prove the connection and contract.** Read sessions and children on a physical phone; send one prompt; interrupt; answer one permission and one question; reconnect during activity. Record exact versions and event fixtures.

**Then prove visibility.** Ship the unified list, execution evidence, child drill-down, generic detail renderer, and freshness behavior.

**Then prove control and recovery.** Add delivery receipts, pending input, request replies, mutation ambiguity handling, and concurrent-client tests.

**Then polish the phone experience.** Optimize long output, keyboard behavior, unread boundaries, and attention navigation. Cut convenience features before cutting safety or state correctness.

## 11. Decisions intentionally left for validation

The target server/client version, exact steering/queue consumption boundary, duplicate-message-ID behavior, interruption effects on child/background work, and mobile SDK compatibility are validation tasks—not assumptions to hide in implementation. The technical design provides conservative behavior while these are tested.

The first-release boundary remains: **know what is happening, know what needs you, and safely tell the correct session what to do next.**

## Sources

Public documentation reviewed September 24, 2026. Product requirements, example UI, targets, and implementation recommendations are proposed design decisions.

[1] OpenCode v2 HTTP API: https://opencode.ai/v2/docs/api/  
[2] OpenCode v2 OpenAPI contract: https://opencode.ai/v2/openapi.json  
[3] OpenCode v2 JavaScript client: https://opencode.ai/v2/docs/build/client/  
[4] OpenCode v2 tools: https://opencode.ai/v2/docs/tools/  
[5] OpenCode v2 web/server setup: https://opencode.ai/v2/docs/cli/web/  
[6] OpenCode v2 permissions: https://opencode.ai/v2/docs/permissions/
