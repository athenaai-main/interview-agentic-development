import test from "node:test";
import assert from "node:assert/strict";
import {
  escapeHTML,
  previewURL,
  boundArtifacts,
  harnessPrompt,
} from "./model.mjs";
test("preview links allow only credential-free loopback HTTP", () => {
  assert.equal(previewURL("http://127.0.0.1:4321/"), "http://127.0.0.1:4321/");
  for (const url of [
    "javascript:alert(1)",
    "https://example.com",
    "http://localhost.evil.test",
    "http://user:password@localhost:4321",
  ])
    assert.equal(previewURL(url), null);
});
test("only checkpoint-bound artifacts become review evidence", () => {
  assert.deepEqual(
    boundArtifacts({
      artifactRefs: { plan: "old" },
      artifacts: [{ id: "old" }, { id: "new" }],
    }),
    [{ id: "old" }],
  );
  assert.equal(
    escapeHTML('<script>"x"</script>'),
    "&lt;script&gt;&quot;x&quot;&lt;/script&gt;",
  );
});
test("failure prompt carries actual revision, error and log instead of approval instructions", () => {
  const p = harnessPrompt(
    { id: "issue", state: "awaiting_prototype_approval" },
    {
      id: "cp",
      artifactRefs: { prototype: "v2" },
      previews: {
        candidate: {
          status: "failed",
          commitSha: "sha",
          startupError: "port occupied",
          logPath: "/local/start.log",
        },
      },
      harnessPrompt: "approve now",
    },
  );
  for (const text of [
    "checkpoint cp",
    "v2",
    "sha",
    "port occupied",
    "/local/start.log",
    "recover",
  ])
    assert.ok(p.includes(text));
  assert.ok(!p.includes("approve now"));
});
test("rejection hands explanation back to harness with persisted decision identity", () => {
  const p = harnessPrompt(
    { id: "issue", state: "awaiting_rejection_reason" },
    { id: "cp", artifactRefs: {}, decision: { id: "decision" } },
  );
  assert.ok(p.includes("decision"));
  assert.ok(p.includes("Ask me why"));
  assert.ok(p.includes("No revision work"));
});
test("ordinary retries do not request human recovery; paused exhaustion does", () => {
  assert.ok(
    !harnessPrompt({ id: "issue", state: "prototype_running" }).includes(
      "explicit recovery",
    ),
  );
  const p = harnessPrompt({
    id: "issue",
    state: "paused",
    pauseReason: "retries exhausted",
    jobs: [
      {
        type: "prototype",
        status: "failed",
        attempt: 2,
        errors: [{ message: "execution interrupted" }],
      },
    ],
  });
  for (const text of [
    "retries exhausted",
    "attempts 2",
    "execution interrupted",
    "Reconcile",
  ])
    assert.ok(p.includes(text));
});
