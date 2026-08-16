import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { JsonTracker } from "../src/adapters/json-tracker.js";
import { MarkdownTracker } from "../src/adapters/markdown-tracker.js";
import { eligibleForBoundedWave, GAME_JAM } from "../src/adapters/studio.js";
import { resolveCliTicketSource } from "../src/cli/ticket-source.js";
import { hashTicketContent } from "../src/core/manifest.js";
import { SAFETY, assertSupervisedBoundedLaunch } from "../src/domain/safety.js";
import { DEFAULT_LIMITS } from "../src/domain/types.js";
import { openCliController } from "../src/runtime.js";

const SAMPLE = {
  ticketId: "X-1",
  title: "Foreign ticket",
  dependsOn: [] as string[],
  sourcePath: "linear://X-1",
  verifyCommand: "true",
};

function writeIssue(root: string, name: string, contents: string): string {
  const issues = join(root, "issues");
  mkdirSync(issues, { recursive: true });
  const path = join(issues, name);
  writeFileSync(path, contents, "utf8");
  return path;
}

function initBareRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "wave-json-repo-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "wave@example.test"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Wave Runner"], { cwd: dir });
  writeFileSync(join(dir, "README.md"), "no issues folder\n", "utf8");
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync("git", ["commit", "-m", "init"], { cwd: dir });
  return dir;
}

test("JSON schema 1 object and array-only parse to the same catalog", () => {
  const arrayText = JSON.stringify([SAMPLE]);
  const objectText = JSON.stringify({ schema: 1, tickets: [SAMPLE] });
  const fromArray = JsonTracker.fromJsonText(arrayText);
  const fromObject = JsonTracker.fromJsonText(objectText);
  assert.deepEqual(fromArray.tickets, fromObject.tickets);
  assert.equal(fromArray.tickets[0]?.ticketId, "X-1");
  assert.equal(fromArray.tickets[0]?.sourcePath, "linear://X-1");
});

test("JSON requires ticketId and sourcePath; title and dependsOn default", () => {
  assert.throws(() => JsonTracker.fromJsonText(JSON.stringify([{ sourcePath: "x" }])), /ticketId/);
  assert.throws(() => JsonTracker.fromJsonText(JSON.stringify([{ ticketId: "", sourcePath: "x" }])), /ticketId/);
  assert.throws(() => JsonTracker.fromJsonText(JSON.stringify([{ ticketId: "X-1" }])), /sourcePath/);
  const tracker = JsonTracker.fromJsonText(JSON.stringify([{ ticketId: "X-1", sourcePath: "src" }]));
  assert.equal(tracker.tickets[0]?.title, "X-1");
  assert.deepEqual(tracker.tickets[0]?.dependsOn, []);
});

test("JSON rejects invalid input, wrong schema, and duplicate ids", () => {
  assert.throws(() => JsonTracker.fromJsonText("not-json"), /Invalid JSON/);
  assert.throws(() => JsonTracker.fromJsonText(JSON.stringify({ schema: 2, tickets: [] })), /schema/);
  assert.throws(() => JsonTracker.fromJsonText(JSON.stringify({ schema: 1 })), /tickets/);
  assert.throws(() => JsonTracker.fromJsonText(JSON.stringify(["X-1"])), /not an object/);
  assert.throws(
    () =>
      JsonTracker.fromJsonText(
        JSON.stringify([
          { ticketId: "X-1", sourcePath: "a" },
          { ticketId: "X-1", sourcePath: "b" },
        ]),
      ),
    /Duplicate/,
  );
  assert.throws(
    () => JsonTracker.fromJsonText(JSON.stringify([{ ticketId: "X-1", sourcePath: "a", dependsOn: "X-0" }])),
    /dependsOn/,
  );
});

test("JsonTracker snapshot computes hash/order and ignores extra operator fields", async () => {
  const tracker = JsonTracker.fromJsonText(
    JSON.stringify([
      {
        ...SAMPLE,
        labels: ["board"],
        storyPoints: 5,
        contentHash: "operator-hash",
        order: 99,
        body: "hash-me",
      },
    ]),
  );
  const frozen = await tracker.snapshot({ ticketIds: ["X-1"], repoPath: "/tmp" });
  assert.equal(frozen.length, 1);
  assert.equal(frozen[0]?.ticketId, "X-1");
  assert.equal(frozen[0]?.order, 1);
  assert.equal(
    frozen[0]?.contentHash,
    hashTicketContent({
      ticketId: "X-1",
      title: "Foreign ticket",
      dependsOn: [],
      sourcePath: "linear://X-1",
      body: "hash-me",
    }),
  );
  assert.notEqual(frozen[0]?.contentHash, "operator-hash");
  assert.equal((frozen[0] as { labels?: unknown }).labels, undefined);
  assert.equal((frozen[0] as { storyPoints?: unknown }).storyPoints, undefined);
  await tracker.mirror({ ticketId: "X-1", status: "DONE", waveId: "W1" });
});

test("CLI --tickets-json builds JsonTracker and freezes without issues/", async () => {
  const repo = initBareRepo();
  const jsonPath = join(repo, "tickets.json");
  writeFileSync(jsonPath, JSON.stringify({ schema: 1, tickets: [SAMPLE] }), "utf8");
  const source = resolveCliTicketSource({ ticketsJsonFlag: jsonPath, repoPath: repo });
  assert.ok(source.tracker instanceof JsonTracker);
  assert.deepEqual(source.ticketIds, ["X-1"]);
  const markdown = resolveCliTicketSource({ ticketsFlag: "X-1", repoPath: repo });
  assert.ok(markdown.tracker instanceof MarkdownTracker);

  const controller = openCliController({
    dbPath: join(repo, "wave.sqlite"),
    repoPath: repo,
    supervised: false,
    tracker: source.tracker,
  });
  const dry = await controller.dryRun({
    waveId: "json-wave",
    repoPath: repo,
    ticketIds: source.ticketIds ?? [],
    limits: DEFAULT_LIMITS,
  });
  assert.equal(dry.ok, true);
  assert.deepEqual(dry.order, ["X-1"]);
  const created = await controller.create({
    waveId: "json-wave",
    repoPath: repo,
    ticketIds: source.ticketIds ?? [],
    limits: DEFAULT_LIMITS,
  });
  assert.equal(created.wave.status, "DRAFT");
  assert.equal(created.tickets[0]?.ticketId, "X-1");
});

test("JSON without --tickets keeps the full file order; supervised max-8 still applies", () => {
  const tickets = [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => ({
    ticketId: `X-${n}`,
    sourcePath: `x/${n}`,
  }));
  const source = resolveCliTicketSource({
    ticketsJsonFlag: "-",
    repoPath: "/tmp",
    jsonText: JSON.stringify(tickets),
  });
  assert.deepEqual(source.ticketIds, ["X-1", "X-2", "X-3", "X-4", "X-5", "X-6", "X-7", "X-8", "X-9"]);
  assert.equal(SAFETY.supervisedMaxTickets, 8);
  assert.throws(
    () =>
      assertSupervisedBoundedLaunch({
        ticketIds: source.ticketIds,
        operatorAction: true,
        isolatedWorktree: true,
      }),
    /at most 8/,
  );
});

test("markdown aliases and filename/H1 fallbacks snapshot correctly", async () => {
  const repo = mkdtempSync(join(tmpdir(), "wave-md-alias-"));
  writeIssue(
    repo,
    "AL-000.md",
    `---
id: AL-000
title: External done
status: done
---
`,
  );
  writeIssue(
    repo,
    "alias.md",
    `---
ticket: AL-001
name: Alias name
state: open
blocked_by: [AL-000]
---
`,
  );
  writeIssue(
    repo,
    "issue-summary.md",
    `---
issue: AL-002
summary: From summary
depends: AL-001
---
`,
  );
  writeIssue(repo, "WR-001-slug.md", "---\nstatus: open\n---\n\n# Hello\n");
  writeIssue(repo, "WR-002-mutation-80.md", "---\nstatus: open\n---\n\nBody only.\n");
  writeIssue(repo, "notes.md", "# Title\n\nNot a ticket.\n");
  const tracker = new MarkdownTracker(repo);
  const snapped = await tracker.snapshot({
    ticketIds: ["AL-001", "AL-002", "WR-001", "WR-002"],
    repoPath: repo,
  });
  assert.equal(snapped[0]?.title, "Alias name");
  assert.deepEqual(snapped[0]?.dependsOn, []);
  assert.equal(snapped[0]?.satisfiedExternalDeps?.[0]?.ticketId, "AL-000");
  assert.equal(snapped[1]?.title, "From summary");
  assert.deepEqual(snapped[1]?.dependsOn, ["AL-001"]);
  assert.equal(snapped[2]?.ticketId, "WR-001");
  assert.equal(snapped[2]?.title, "Hello");
  assert.equal(snapped[3]?.ticketId, "WR-002");
  assert.equal(snapped[3]?.title, "mutation-80");
  await assert.rejects(tracker.snapshot({ ticketIds: ["NOTES"], repoPath: repo }), /not found/);
});

test("auto-admission stays fail-closed; explicit --tickets ignores eligibility", async () => {
  assert.equal(eligibleForBoundedWave("---\nid: X-1\nstatus: open\n---\n", GAME_JAM).eligible, false);
  assert.equal(
    eligibleForBoundedWave("---\nid: X-1\nstatus: open\nagent_eligible: maybe\n---\n", GAME_JAM).eligible,
    false,
  );
  assert.equal(
    eligibleForBoundedWave("---\nid: X-1\nstatus: open\neligible: false\n---\n", GAME_JAM).eligible,
    false,
  );
  assert.equal(
    eligibleForBoundedWave("---\nid: X-1\nstatus: open\neligible: true\n---\n", GAME_JAM).eligible,
    true,
  );
  assert.equal(
    eligibleForBoundedWave("---\nid: X-1\nstatus: open\nagent_eligible: true\n---\n", GAME_JAM).eligible,
    true,
  );

  const repo = mkdtempSync(join(tmpdir(), "wave-md-elig-"));
  writeIssue(repo, "X-1.md", "---\nid: X-1\ntitle: No flag\nstatus: open\n---\n");
  const markdown = new MarkdownTracker(repo);
  const mdSnap = await markdown.snapshot({ ticketIds: ["X-1"], repoPath: repo });
  assert.equal(mdSnap[0]?.ticketId, "X-1");

  const json = JsonTracker.fromJsonText(JSON.stringify([{ ticketId: "X-1", sourcePath: "board://X-1" }]));
  const jsonSnap = await json.snapshot({ ticketIds: ["X-1"], repoPath: repo });
  assert.equal(jsonSnap[0]?.ticketId, "X-1");
});
