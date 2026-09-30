# Human review application

The project application uses the local server's `/api/v1` contract, human-session cookie and CSRF token. It contains no fixture scenarios or simulated decisions.

Run `node web/start.mjs` from the project root with Node 22.13+ after installing the project's dependencies. This entry point mounts the application and the existing factory API on the same loopback origin, default `http://127.0.0.1:4310`. Stop any existing factory server before starting it. It uses the same FACTORY_DATA_DIR, FACTORY_CONFIG and PORT options as server/index.js. The server prints a short-lived pairing code for the human to enter in the application. Never commit credentials or factory data.

Application routes: `/`, `/issues/:id`, `/checkpoints/:id`. Worker and harness commands remain owned by the server implementation. The application entry point composes the server modules without modifying server-owned files. Once the server branch is merged, the project start script can select this entry point.

This PR depends on the concurrent server implementation, which is not part of this application's changes. Follow-up commits will update this same PR as the server contract and UI mature. Preview process status and exact commit labels come from server metadata. Retry eligibility and exhaustion are server-authoritative; internal retries remain ordinary execution, and server-paused exhaustion provides recovery context. The application does not automatically resume jobs or assert side-effect reconciliation.

Final review is read-only. Approval and rejection are revision-bound server writes with an idempotency key. If a response is uncertain, the application retrieves the durable decision before allowing another attempt. Network failures disable decision controls until a fresh server snapshot arrives.
