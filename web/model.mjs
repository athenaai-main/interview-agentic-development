export const escapeHTML = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
export const label = (value) => String(value ?? "").replaceAll("_", " ");
export function previewURL(value) {
  try {
    const u = new URL(value);
    return u.protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname) &&
      !u.username &&
      !u.password
      ? u.href
      : null;
  } catch {
    return null;
  }
}
export function boundArtifacts(checkpoint) {
  const ids = new Set(Object.values(checkpoint?.artifactRefs || {}));
  return (checkpoint?.artifacts || []).filter((a) => ids.has(a.id));
}
export function harnessPrompt(issue, checkpoint) {
  const identity = `Issue ${issue.id}${checkpoint ? `, checkpoint ${checkpoint.id}, artifactRefs ${JSON.stringify(checkpoint.artifactRefs)}` : ""}.`;
  const failed = Object.entries(
    checkpoint?.previews || issue.previews || {},
  ).filter(([, p]) => p?.status === "failed" || p?.startupError);
  if (failed.length)
    return `${identity}\nPreview startup failed:\n${failed.map(([role, p]) => `${role}: commit ${p.commitSha || "unknown"}, URL ${p.url || "unavailable"}, error: ${p.startupError || p.status}, log: ${p.logPath || "not supplied"}`).join("\n")}\nInspect these logs and recover previews for the exact commits through the authorized server recovery flow. Verify both baseline and candidate are ready before review. Do not approve an unavailable checkpoint.`;
  if (issue.state === "awaiting_rejection_reason")
    return `${identity}\nRetrieve the rejected checkpoint decision ${checkpoint?.decision?.id || "from the decision API"}. Ask me why I rejected it, then submit my explanation with decisionId and the current expectedIssueVersion. No revision work may queue until the explanation is accepted.`;
  if (issue.state === "paused")
    return `${identity}\nAutonomous work requires attention: ${issue.pauseReason || "see recorded job outcomes"}.\n${(
      issue.jobs || []
    )
      .filter((j) => ["failed", "interrupted", "paused"].includes(j.status))
      .map(
        (j) =>
          `${j.type}: attempts ${j.attempt}; latest error ${j.errors?.at(-1)?.message || j.recovery?.error || j.status}`,
      )
      .join(
        "\n",
      )}\nInspect recorded attempts, provider execution, worktree and external side effects with me before explicit recovery. Reconcile existing side effects before any replay.`;
  if (checkpoint?.decision)
    return `${identity}\nDecision ${checkpoint.decision.id}: ${checkpoint.decision.decision}. Current state: ${issue.state}. Retrieve the persisted decision and continue from the server state; do not decide again.`;
  return (
    checkpoint?.harnessPrompt ||
    `${identity}\nRetrieve current state and continue ${label(issue.state)} in my harness. Wait for autonomous jobs when running. Ask for my input when the server requires it.`
  );
}
