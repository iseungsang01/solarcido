import assert from "node:assert/strict";
import test from "node:test";

import {
  TrustResolver,
  makeTrustConfig,
  makeTrustAllowlistEntry,
  detectTrustPrompt,
  detectManualApproval,
  patternMatches,
  trustDecisionPolicy,
  trustDecisionEvents,
} from "../dist/runtime/trust-resolver.js";

// ---------------------------------------------------------------------------
// detectTrustPrompt
// ---------------------------------------------------------------------------

test("detectTrustPrompt: recognises known trust prompt copy", () => {
  assert.equal(
    detectTrustPrompt("Do you trust the files in this folder?\n1. Yes, proceed\n2. No"),
    true,
  );
});

test("detectTrustPrompt: 'trust this folder' cue", () => {
  assert.equal(detectTrustPrompt("Trust this folder to continue"), true);
});

test("detectTrustPrompt: returns false on unrelated text", () => {
  assert.equal(detectTrustPrompt("Ready for your input\n>"), false);
});

// ---------------------------------------------------------------------------
// detectManualApproval
// ---------------------------------------------------------------------------

test("detectManualApproval: 'yes, i trust' detected", () => {
  assert.equal(detectManualApproval("User selected: Yes, I trust this folder"), true);
});

test("detectManualApproval: 'approval granted' detected", () => {
  assert.equal(detectManualApproval("Approval granted by user"), true);
});

test("detectManualApproval: trust question without answer is not approval", () => {
  assert.equal(detectManualApproval("Do you trust the files in this folder?"), false);
});

// ---------------------------------------------------------------------------
// patternMatches
// ---------------------------------------------------------------------------

test("patternMatches: exact match", () => {
  assert.equal(patternMatches("/tmp/worktrees", "/tmp/worktrees"), true);
});

test("patternMatches: prefix containment without wildcard", () => {
  assert.equal(patternMatches("/tmp/worktrees", "/tmp/worktrees/repo-a"), true);
});

test("patternMatches: sibling prefix does not match", () => {
  assert.equal(patternMatches("/tmp/worktrees", "/tmp/worktrees-other/repo"), false);
});

test("patternMatches: trailing /* wildcard", () => {
  assert.equal(patternMatches("/tmp/worktrees/*", "/tmp/worktrees/repo-a"), true);
  assert.equal(patternMatches("/tmp/worktrees/*", "/tmp/other/repo"), false);
});

test("patternMatches: ? matches single character", () => {
  assert.equal(patternMatches("/tmp/test?", "/tmp/test1"), true);
  assert.equal(patternMatches("/tmp/test?", "/tmp/testAB"), false);
});

test("patternMatches: multi-wildcard glob", () => {
  assert.equal(patternMatches("/tmp/*/repo-*", "/tmp/worktrees/repo-123"), true);
  assert.equal(patternMatches("/tmp/*/repo-*", "/tmp/worktrees/other"), false);
});

test("patternMatches: path-component substring", () => {
  assert.equal(patternMatches("worktrees", "/tmp/worktrees/repo-a"), true);
});

// ---------------------------------------------------------------------------
// TrustResolver.resolve — not_required
// ---------------------------------------------------------------------------

test("resolve: not_required when no trust prompt in screen text", () => {
  const resolver = new TrustResolver(
    makeTrustConfig({ allowlisted: [makeTrustAllowlistEntry("/tmp/worktrees")] }),
  );
  const decision = resolver.resolve("/tmp/worktrees/repo-a", undefined, "Ready for your input\n>");
  assert.equal(decision.kind, "not_required");
  assert.deepEqual(trustDecisionEvents(decision), []);
  assert.equal(trustDecisionPolicy(decision), undefined);
});

// ---------------------------------------------------------------------------
// TrustResolver.resolve — auto_trust
// ---------------------------------------------------------------------------

test("resolve: auto_trust for allowlisted cwd after trust prompt detected", () => {
  const resolver = new TrustResolver(
    makeTrustConfig({ allowlisted: [makeTrustAllowlistEntry("/tmp/worktrees")] }),
  );
  const decision = resolver.resolve(
    "/tmp/worktrees/repo-a",
    undefined,
    "Do you trust the files in this folder?\n1. Yes, proceed\n2. No",
  );
  assert.equal(decision.kind, "required");
  assert.equal(trustDecisionPolicy(decision), "auto_trust");
  const events = trustDecisionEvents(decision);
  assert.equal(events.length, 2);
  assert.equal(events[0].type, "trust_required");
  assert.equal(events[1].type, "trust_resolved");
  assert.equal(events[1].resolution, "auto_allowlisted");
});

test("resolve: auto_trust with /* glob allowlist", () => {
  const resolver = new TrustResolver(
    makeTrustConfig({ allowlisted: [makeTrustAllowlistEntry("/tmp/worktrees/*")] }),
  );
  const decision = resolver.resolve(
    "/tmp/worktrees/repo-x",
    undefined,
    "Do you trust the files in this folder?\n1. Yes, proceed\n2. No",
  );
  assert.equal(trustDecisionPolicy(decision), "auto_trust");
});

// ---------------------------------------------------------------------------
// TrustResolver.resolve — require_approval
// ---------------------------------------------------------------------------

test("resolve: require_approval for unknown cwd", () => {
  const resolver = new TrustResolver(
    makeTrustConfig({ allowlisted: [makeTrustAllowlistEntry("/tmp/worktrees")] }),
  );
  const decision = resolver.resolve(
    "/tmp/other/repo-b",
    undefined,
    "Do you trust the files in this folder?\n1. Yes, proceed\n2. No",
  );
  assert.equal(trustDecisionPolicy(decision), "require_approval");
  const events = trustDecisionEvents(decision);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "trust_required");
  assert.equal(events[0].cwd, "/tmp/other/repo-b");
});

test("resolve: manual approval detected from screen text", () => {
  const resolver = new TrustResolver(makeTrustConfig());
  const decision = resolver.resolve(
    "/tmp/some/repo",
    undefined,
    "Do you trust the files in this folder?\nUser selected: Yes, I trust this folder",
  );
  assert.equal(trustDecisionPolicy(decision), "require_approval");
  const events = trustDecisionEvents(decision);
  const resolved = events.find((e) => e.type === "trust_resolved");
  assert.ok(resolved !== undefined);
  assert.equal(resolved.resolution, "manual_approval");
});

// ---------------------------------------------------------------------------
// TrustResolver.resolve — deny
// ---------------------------------------------------------------------------

test("resolve: denied root takes precedence over allowlist", () => {
  const resolver = new TrustResolver(
    makeTrustConfig({
      allowlisted: [makeTrustAllowlistEntry("/tmp/worktrees")],
      denied: ["/tmp/worktrees/repo-c"],
    }),
  );
  const decision = resolver.resolve(
    "/tmp/worktrees/repo-c",
    undefined,
    "Do you trust the files in this folder?\n1. Yes, proceed\n2. No",
  );
  assert.equal(trustDecisionPolicy(decision), "deny");
  const events = trustDecisionEvents(decision);
  assert.ok(events.some((e) => e.type === "trust_denied"));
  const denied = events.find((e) => e.type === "trust_denied");
  assert.ok(denied.reason.includes("denied trust root"));
});

// ---------------------------------------------------------------------------
// TrustResolver.resolve — worktree pattern
// ---------------------------------------------------------------------------

test("resolve: auto_trust when both cwd and worktree patterns match", () => {
  const resolver = new TrustResolver(
    makeTrustConfig({
      allowlisted: [makeTrustAllowlistEntry("/tmp/worktrees/*", "*/.git")],
    }),
  );
  const decision = resolver.resolve(
    "/tmp/worktrees/repo-a",
    "/tmp/worktrees/repo-a/.git",
    "Do you trust the files in this folder?\n1. Yes, proceed\n2. No",
  );
  assert.equal(trustDecisionPolicy(decision), "auto_trust");
});

test("resolve: require_approval when worktree pattern required but not supplied", () => {
  const resolver = new TrustResolver(
    makeTrustConfig({
      allowlisted: [makeTrustAllowlistEntry("/tmp/worktrees/*", "*/.git")],
    }),
  );
  const decision = resolver.resolve(
    "/tmp/worktrees/repo-a",
    undefined,
    "Do you trust the files in this folder?\n1. Yes, proceed\n2. No",
  );
  assert.equal(trustDecisionPolicy(decision), "require_approval");
});

// ---------------------------------------------------------------------------
// TrustResolver.trusts
// ---------------------------------------------------------------------------

test("trusts: true for allowlisted cwd", () => {
  const resolver = new TrustResolver(
    makeTrustConfig({ allowlisted: [makeTrustAllowlistEntry("/tmp/worktrees/*")] }),
  );
  assert.equal(resolver.trusts("/tmp/worktrees/good-repo", undefined), true);
});

test("trusts: false for denied cwd even if it matches allowlist", () => {
  const resolver = new TrustResolver(
    makeTrustConfig({
      allowlisted: [makeTrustAllowlistEntry("/tmp/worktrees/*")],
      denied: ["/tmp/worktrees/bad-repo"],
    }),
  );
  assert.equal(resolver.trusts("/tmp/worktrees/bad-repo", undefined), false);
});

test("trusts: false for unknown cwd", () => {
  const resolver = new TrustResolver(
    makeTrustConfig({ allowlisted: [makeTrustAllowlistEntry("/tmp/worktrees/*")] }),
  );
  assert.equal(resolver.trusts("/tmp/other/repo", undefined), false);
});

// ---------------------------------------------------------------------------
// trust_required event carries repo name
// ---------------------------------------------------------------------------

test("resolve: trust_required event includes repo name from last path component", () => {
  const resolver = new TrustResolver(makeTrustConfig());
  const decision = resolver.resolve(
    "/tmp/other/repo-b",
    undefined,
    "Do you trust the files in this folder?\n1. Yes, proceed\n2. No",
  );
  const events = trustDecisionEvents(decision);
  assert.equal(events[0].type, "trust_required");
  assert.equal(events[0].repo, "repo-b");
});
