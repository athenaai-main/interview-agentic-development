import {
  escapeHTML as e,
  label,
  previewURL,
  boundArtifacts,
  harnessPrompt,
} from "./model.mjs";
const $ = (id) => document.getElementById(id);
let csrf = "",
  busy = false,
  loading = false,
  current = null,
  connected = true;
const route = location.pathname.split("/").filter(Boolean);
function report(message, error = false) {
  $("status").textContent = message;
  $("status").className = error ? "error" : "muted";
}
async function api(path, body, key) {
  const response = await fetch("/api/v1" + path, {
    method: body === undefined ? "GET" : "POST",
    credentials: "same-origin",
    headers:
      body === undefined
        ? {}
        : {
            "Content-Type": "application/json",
            "X-CSRF-Token": csrf,
            "Idempotency-Key": key || crypto.randomUUID(),
          },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  const result = await response.json();
  if (!response.ok) {
    const error = new Error(
      result.message || result.code || `HTTP ${response.status}`,
    );
    error.status = response.status;
    throw error;
  }
  return result;
}
const pill = (text, kind = "") =>
  `<span class="pill ${kind}">${e(text)}</span>`;
function preview(role, p) {
  const url = p?.status === "ready" ? previewURL(p.url) : null;
  return `<div class="preview"><div class="eyebrow">${e(role)}</div><strong>${e(p?.commitSha || "No revision available")}</strong><p>${pill(p?.status || "Not started", p?.status === "ready" ? "green" : "amber")}</p>${url ? `<a class="link" href="${e(url)}" target="_blank" rel="noopener">Open ${e(role)} ↗</a><p class="muted">${e(url)}</p>` : ""}${p?.startupError ? `<p class="error">Startup error: ${e(p.startupError)}</p><p class="muted">Log: ${e(p.logPath || "not supplied")}</p>` : ""}</div>`;
}
function timeline(events) {
  return `<ul class="timeline">${[...events]
    .reverse()
    .slice(0, 15)
    .map(
      (event) =>
        `<li>${e(label(event.type))}${event.outcome ? ` · ${e(label(event.outcome))}` : ""}${event.to ? ` → ${e(label(event.to))}` : ""}${event.rationale ? `<br>${e(event.rationale)}` : ""}${event.message ? `<br>${e(event.message)}` : ""}<time>${e(new Date(event.time).toLocaleString())}</time></li>`,
    )
    .join("")}</ul>`;
}
function artifact(a) {
  return `<details class="rule" open><summary>${e(label(a.kind))} · <code>${e(a.id)}</code></summary>${a.commitSha ? `<p>Commit <code>${e(a.commitSha)}</code> · Branch ${e(a.branch || "—")}</p>` : ""}${a.summary ? `<p class="artifact">${e(a.summary)}</p>` : ""}${a.prd ? `<p class="artifact">${e(a.prd)}</p>` : ""}${a.slices ? `<ol>${a.slices.map((s) => `<li><strong>${e(s.title)}</strong><p>${e(s.description)}</p></li>`).join("")}</ol>` : ""}${a.acceptanceCriteria ? `<h3>Acceptance criteria</h3><ul>${a.acceptanceCriteria.map((c) => `<li>${e(c)}</li>`).join("")}</ul>` : ""}${a.outcome ? `<p>Outcome: <strong>${e(label(a.outcome))}</strong><br>${e(a.rationale)}</p>` : ""}${a.findings?.length ? `<ul>${a.findings.map((f) => `<li>${e(f)}</li>`).join("")}</ul>` : ""}${a.checks ? `<h3>Checks at this commit</h3>${a.checks.map((c) => `<p>${pill(c.exitCode === 0 ? "Passed" : "Failed", c.exitCode === 0 ? "green" : "amber")} ${e(c.command)} · ${e(c.commitSha)}</p><details><summary>Check output</summary><pre>${e(c.output)}</pre></details>`).join("")}` : ""}${a.prUrl && /^https:\/\/github\.com\//.test(a.prUrl) ? `<a href="${e(a.prUrl)}" target="_blank" rel="noopener">Open draft PR ↗</a>` : ""}</details>`;
}
function renderIssue(issue, cp, workers) {
  current = { issue, cp };
  const active = (issue.jobs || []).filter((j) =>
    ["queued", "running", "retrying", "reconciling"].includes(j.status),
  );
  const artifacts = cp ? boundArtifacts(cp) : issue.artifacts || [];
  const rejected = issue.state === "awaiting_rejection_reason";
  const hasPreviews = cp && cp.kind !== "plan";
  const prompt = harnessPrompt(issue, cp);
  const actions =
    connected && !busy && cp?.status === "pending"
      ? cp.allowedActions || []
      : [];
  const notice = rejected
    ? "Return to your harness to explain why. Revision work starts after your explanation is recorded."
    : cp?.status === "unavailable"
      ? "This checkpoint is unavailable. Inspect preview failures and revision evidence before continuing."
      : cp?.status === "superseded"
        ? "A newer revision has replaced this checkpoint."
        : cp?.decision
          ? `Recorded decision: ${label(cp.decision.decision)}. Current state: ${label(issue.state)}.`
          : issue.state === "paused"
            ? `Your help is needed: ${issue.pauseReason || "autonomous recovery exhausted"}.`
            : cp?.kind === "final"
              ? "Implementation reviewed. Inspect the evidence and previews; final acceptance and merge belong to the next slice."
              : cp
                ? "Review the bound artifacts below, then personally choose Approve or Reject. Your harness receives the persisted decision."
                : "Work continues in your harness or autonomous workers. This page updates as the server records progress.";
  $("app").innerHTML =
    `<a class="muted" href="/">← All issues</a><h1>${e(issue.title)}</h1><div class="meta"><span>${e(issue.repositoryId)}</span><span>Baseline <code>${e(issue.baselineSha)}</code></span><span>Issue version ${e(issue.version)}</span></div><div class="layout"><section><div class="card"><div class="eyebrow">${cp ? "Checkpoint" : "Current stage"}</div><div class="top"><h2>${e(cp ? label(cp.kind) + " review" : label(issue.state))}</h2>${pill(label(issue.state), issue.state === "paused" || rejected ? "amber" : "blue")}</div><div class="notice ${rejected || issue.state === "paused" ? "warn" : ""}">${e(notice)}</div>${cp ? `<p class="muted">Checkpoint <code>${e(cp.id)}</code> · ${e(cp.status)}</p><details><summary>Exact artifact bindings</summary><pre>${e(JSON.stringify(cp.artifactRefs, null, 2))}</pre></details>` : ""}${issue.checkpointId && issue.checkpointId !== cp?.id ? `<p><a href="/checkpoints/${encodeURIComponent(issue.checkpointId)}">Open current checkpoint</a></p>` : ""}${actions.length ? `<div class="actions">${actions.map((a) => `<button data-decision="${e(a)}" class="${a === "approve" ? "primary" : "reject"}">${e(label(a))} ${e(cp.kind)}</button>`).join("")}</div>` : ""}</div>${hasPreviews ? `<div class="card"><h3>Compare the application</h3><div class="previews">${preview("Baseline", cp.previews?.baseline)}${preview("Candidate", cp.previews?.candidate)}</div></div>` : ""}<div class="card"><div class="top"><h3>Continue in your harness</h3><button id="copy">Copy prompt</button></div><p class="muted">${rejected ? "Your explanation belongs in the harness." : "Copy the issue, revision and recovery context into your harness."}</p><div class="prompt">${e(prompt)}</div><span id="copyStatus" role="status"></span></div><div class="card"><h3>Artifacts and review evidence</h3>${artifacts.length ? artifacts.map(artifact).join("") : '<p class="muted">No artifacts submitted yet.</p>'}</div></section><aside><div class="card"><h3>Queue status</h3><div class="stat"><span>Workers busy</span><strong>${e(workers.busy)} / ${e(workers.capacity)}</strong></div><div class="stat"><span>Jobs queued</span><strong>${e(workers.queued)}</strong></div><p class="muted">${
      active.length
        ? active
            .map((j) => `${label(j.type)} · ${label(j.status)}`)
            .map(e)
            .join("<br>")
        : "This issue holds no worker slot."
    }</p><p class="muted">Human waits release worker slots.</p></div><div class="card"><h3>Timeline</h3>${timeline(issue.events || [])}</div><div class="card"><h3>Review rounds</h3>${Object.entries(
      issue.rounds || {},
    )
      .map(
        ([k, v]) =>
          `<div class="stat"><span>${e(label(k))}</span><strong>${e(v)} / 3</strong></div>`,
      )
      .join("")}</div></aside></div>`;
  $("copy").onclick = async () => {
    try {
      await navigator.clipboard.writeText(prompt);
      $("copyStatus").textContent = "Prompt copied.";
    } catch {
      $("copyStatus").textContent =
        "Select the prompt above and copy it manually.";
    }
  };
  document
    .querySelectorAll("[data-decision]")
    .forEach(
      (button) => (button.onclick = () => decide(button.dataset.decision)),
    );
}
async function decide(decision) {
  if (busy || !current?.cp) return;
  busy = true;
  const cp = current.cp;
  const key = crypto.randomUUID();
  document
    .querySelectorAll("[data-decision]")
    .forEach((b) => (b.disabled = true));
  try {
    await api(
      `/checkpoints/${encodeURIComponent(cp.id)}/decision`,
      {
        decision,
        expectedIssueVersion: cp.issueVersion,
        artifactRefs: cp.artifactRefs,
      },
      key,
    );
    report(`Decision recorded: ${decision}.`);
  } catch (error) {
    try {
      const stored = await api(
        `/checkpoints/${encodeURIComponent(cp.id)}/decision`,
      );
      report(
        stored.status === "decided"
          ? `Decision recorded: ${stored.decision}.`
          : `Decision not confirmed: ${error.message}. Review the refreshed checkpoint before trying again.`,
        stored.status !== "decided",
      );
    } catch {
      report(
        "Decision result is unknown. Reconnect to retrieve the persisted decision before trying again.",
        true,
      );
      connected = false;
    }
  } finally {
    busy = false;
    await refresh();
  }
}
async function refresh() {
  if (loading || busy) return;
  loading = true;
  try {
    const session = await api("/auth/session");
    csrf = session.csrf;
    $("pair").hidden = true;
    const data = await api("/issues");
    let cp, issue;
    if (route[0] === "checkpoints" && route[1]) {
      cp = await api("/checkpoints/" + encodeURIComponent(route[1]));
      issue = await api("/issues/" + encodeURIComponent(cp.issueId));
    } else if (route[0] === "issues" && route[1]) {
      issue = await api("/issues/" + encodeURIComponent(route[1]));
      if (issue.checkpointId)
        cp = await api(
          "/checkpoints/" + encodeURIComponent(issue.checkpointId),
        );
    }
    connected = true;
    if (issue) renderIssue(issue, cp, data.workers);
    else {
      $("app").innerHTML =
        `<h1>Your issues</h1><p class="muted">Workers ${e(data.workers.busy)} / ${e(data.workers.capacity)} · ${e(data.workers.queued)} jobs queued</p>${data.issues.length ? data.issues.map((i) => `<article class="card"><div class="top"><h2><a href="/issues/${encodeURIComponent(i.id)}">${e(i.title)}</a></h2>${pill(label(i.state), "blue")}</div><p class="muted">${e(i.repositoryId)} · Baseline ${e(i.baselineSha)} · ${e(new Date(i.updatedAt).toLocaleString())}</p></article>`).join("") : '<div class="card"><h2>No issues yet</h2><p class="muted">Submit your first issue through your human-operated harness to begin clarification.</p></div>'}`;
    }
  } catch (error) {
    connected = false;
    if (error.status === 401 || error.status === 403) {
      csrf = "";
      $("pair").hidden = false;
      $("app").innerHTML = "";
      report("Connect your human browser session to review issues.");
    } else {
      report(
        `Updates disconnected: ${error.message}. Showing the last received snapshot.`,
        true,
      );
      document
        .querySelectorAll("[data-decision]")
        .forEach((b) => (b.disabled = true));
    }
  } finally {
    loading = false;
  }
}
$("pairForm").onsubmit = async (event) => {
  event.preventDefault();
  const button = event.target.querySelector("button");
  button.disabled = true;
  try {
    const session = await api("/auth/pairing/complete", {
      code: $("pairCode").value,
    });
    csrf = session.csrf;
    $("pairCode").value = "";
    report("Browser connected.");
    await refresh();
  } catch (error) {
    report(error.message, true);
  } finally {
    button.disabled = false;
  }
};
await refresh();
setInterval(refresh, 5000);
