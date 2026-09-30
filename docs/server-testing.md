# Testing the live local factory server

This server is implemented on draft PR #2. The application prototype in `prototypes/human-review` is a separate fixture UX; it is not wired to this API. The server includes a small live review page for real decisions and previews.

## Quick start

Requires Node 22.13+ (verified on 22.23.2), Git, and Codex authentication. SDK is pinned to `@openai/codex-sdk` 0.159.2. Live smoke calls succeeded with `gpt-6-luna` and `gpt-6.1-sol` on September 30, 2026; account access remains account-dependent. No fallback model is used.

```sh
npm ci
npm run factory -- demo-setup
npm start
```

Open http://127.0.0.1:4310 and enter the pairing code printed in the server terminal. It expires in ten minutes and is single-use. Restart the server to obtain a fresh code. The human cookie persists for 24 hours. This is a session boundary, not proof that a browser is being controlled by a person.

In another terminal:

```sh
npm run factory -- intake examples/intake.json
```

The response contains the issue ID and scoped agent token. A mode-600 token file is also saved under `.factory/<issueId>.token`. Use the scoped token in the human-operated harness:

```sh
export FACTORY_AGENT_TOKEN="<scoped token>"
npm run factory -- plan <issueId> examples/plan.json
npm run worker
```

The plan JSON requires the current issue version, so update `expectedIssueVersion` when revising a plan. The three workers claim eligible jobs. A separate Sol agent reviews the plan. Findings return the issue to clarification; passing review creates a checkpoint. Refresh the live issue page to open it. Personally review and click Approve/Reject.

```sh
npm run factory -- checkpoint wait <checkpointId>
```

This waits independently of the browser and prints the durable decision. Reconnect with the same command to retrieve it. A rejection returns `requiresRejectionReason: true`. Ask the human why and create a JSON file containing `decisionId`, `reason`, and the current `expectedIssueVersion`, then run:

```sh
npm run factory -- reason <checkpointId> reason.json
```

No revision is queued before that explanation is persisted. New harness sessions can receive scoped tokens from `POST /api/v1/issues/:id/agent-tokens` through the paired human session. Prompts never contain credentials.

## Full GitHub workflow

The generated demo is a local repository without a remote. It can exercise plan review and local autonomous coding, but prototype completion intentionally blocks at draft PR publication. It does not fabricate a PR or pretend the full acceptance scenario passed.

For full testing, copy `factory.config.example.json` to `factory.config.json`, configure a small web application's absolute Git checkout, install/start/check commands, and GitHub repository, then restart the server. The checkout must have a committed baseline and Git identity. Start command receives `PORT` and may use `{port}`. Baseline and candidate must run independently without shared mutable data. The target's Git credentials and `gh` authentication must be available.

Set `publishDraftPr: true` only when you explicitly authorize this factory to push its deterministic prototype branch and create/update its draft PR in that target. False is the default. This implementation PR does not grant permission to publish arbitrary target repositories. The worker locates existing draft PRs by branch on retry. Implementation stays local; this slice does not merge or deploy.

The first implementation task gets a separate issue-owned worktree from the original baseline. Subsequent implementation revisions reuse it regardless of worker assignment. Code review uses a separate checkout pinned to the submitted implementation SHA.

## Failure behavior

- Preview startup runs under server supervision after the task releases its worker slot. Review decisions remain disabled until both exact-version previews are ready.
- Startup errors, process status, commit labels, and log paths appear on the checkpoint. **Copy harness prompt** includes the actual failure. Restart previews after diagnosing the configuration/environment. If code changes, the old checkpoint becomes ineligible; do not approve it.
- Interrupted autonomous reservations get one internal retry. Only after the second interruption does the issue show a paused recovery state. Attempts and prior provider IDs remain recorded. A fresh coding turn inspects and continues the issue worktree; it does not blindly replay PR creation.
- Classified transient errors get one retry when side effects are reconciled. Other failures pause immediately with their concrete error.
- Resume is human-authorized and requires explicit side-effect reconciliation. It does not reset planning/prototype/implementation round limits.
- Restart preserves SQLite issues, jobs, artifacts, decisions, events and preview metadata. Processes are stopped on normal server shutdown; previews need an explicit restart after server restart.
- Final review is read-only. It displays the reviewed commit, artifacts/checks, previews, and a continuation prompt. Final decisions and merge are deferred.

The live review page is deliberately minimal. It is a server verification surface, not the approved application UX. Issue API exposes timeline, outcomes, rounds, attempts, and failures for the prototype integration.

## Commands and configuration

`npm test` runs state/queue, HTTP/auth, and actual process/Git integration tests. `npm run check` validates syntax. `.factory` and `factory.config.json` are local-only; do not commit credentials or user-specific repository paths.

Environment: `FACTORY_DATA_DIR`, `FACTORY_CONFIG`, `FACTORY_URL` (CLI/worker), `PORT` (server), `FACTORY_WORKERS` (1–3), `FACTORY_CODEX_PATH` (optional verified executable override). Default server port is 4310, bound to 127.0.0.1. Use that exact origin for pairing and decisions.

Known verification limits: live SDK/model smoke calls and real preview integration tests have passed, but the entire real GitHub-target issue has not yet passed through human checkpoints to final review. No usage-cost estimate is invented; reported token usage is stored from SDK completion events.
