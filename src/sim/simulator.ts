import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  MockTracker,
  MockUsage,
  MockWorker,
  MockWorkflow,
  MockWorkspace,
  SafePolicy,
} from "../adapters/mocks.js";
import { FakeClock, SequentialIds } from "../domain/clock.js";
import { DEFAULT_LIMITS } from "../domain/types.js";
import { MemoryAuthority, defaultSleep } from "../core/authority.js";
import { CrashInjectedError, WaveController } from "../core/controller.js";
import type { OutboxBoundary } from "../core/outbox.js";
import { WaveDatabase } from "../store/database.js";

export type SimHarness = {
  dbPath: string;
  clock: FakeClock;
  ids: SequentialIds;
  tracker: MockTracker;
  workflow: MockWorkflow;
  worker: MockWorker;
  usage: MockUsage;
  workspace: MockWorkspace;
  policy: SafePolicy;
  llmCalls: { count: number };
  authority: MemoryAuthority;
  sleep: (ms: number) => Promise<void>;
  open(): WaveController;
};

export function createSimulator(label = "wave-sim"): SimHarness {
  const dir = mkdtempSync(join(tmpdir(), `${label}-`));
  const dbPath = join(dir, "wave.sqlite");
  const clock = new FakeClock(1_700_000_000_000);
  const ids = new SequentialIds();
  const tracker = new MockTracker();
  const workflow = new MockWorkflow();
  const worker = new MockWorker();
  const usage = new MockUsage();
  const workspace = new MockWorkspace();
  const policy = new SafePolicy();
  const llmCalls = { count: 0 };
  const authority = new MemoryAuthority();
  const sleep = defaultSleep;
  tracker.seed({
    ticketId: "FX-001",
    title: "Fixture one",
    contentHash: "",
    dependsOn: [],
    order: 1,
    sourcePath: "issues/FX-001.md",
    planClass: "manual",
    verifyCommand: "true",
    body: "one",
  });
  tracker.seed({
    ticketId: "FX-002",
    title: "Fixture two",
    contentHash: "",
    dependsOn: ["FX-001"],
    order: 2,
    sourcePath: "issues/FX-002.md",
    planClass: "safe-policy",
    verifyCommand: "true",
    body: "two",
  });
  tracker.seed({
    ticketId: "FX-003",
    title: "Fixture three",
    contentHash: "",
    dependsOn: ["FX-002"],
    order: 3,
    sourcePath: "issues/FX-003.md",
    planClass: "manual",
    verifyCommand: "true",
    body: "three",
  });

  const harness: SimHarness = {
    dbPath,
    clock,
    ids,
    tracker,
    workflow,
    worker,
    usage,
    workspace,
    policy,
    llmCalls,
    authority,
    sleep,
    open() {
      return new WaveController({
        db: new WaveDatabase(dbPath),
        clock,
        ids,
        tracker,
        workflow,
        worker,
        usage,
        workspace,
        policy,
        process: { holder: "sim", processIdentity: "sim-1", pid: process.pid },
        authority: harness.authority,
        sleep: harness.sleep,
        llmCalls,
        worktreeRoot: join(dir, "worktrees"),
      });
    },
  };
  return harness;
}

export async function seedWave(
  sim: SimHarness,
  waveId: string,
  ticketIds: string[],
  limits: Partial<typeof DEFAULT_LIMITS> = {},
) {
  const controller = sim.open();
  await controller.create({
    waveId,
    repoPath: "/tmp/wave-fixture-repo",
    ticketIds,
    limits: { ...DEFAULT_LIMITS, ...limits },
  });
  return controller;
}

export async function injectCrash(
  sim: SimHarness,
  waveId: string,
  boundary: OutboxBoundary,
): Promise<{ recovered: WaveController; error: CrashInjectedError }> {
  const first = sim.open();
  first.crashAt = boundary;
  let error: CrashInjectedError | undefined;
  try {
    if (boundary === "before_reservation") {
      await first.start(waveId);
    } else {
      await first.start(waveId);
      await first.runUntilIdle(waveId);
    }
  } catch (caught) {
    if (caught instanceof CrashInjectedError) error = caught;
    else throw caught;
  }
  if (!error) {
    throw new Error(`Expected crash at ${boundary}`);
  }
  const recovered = sim.open();
  recovered.crashAt = null;
  return { recovered, error };
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
