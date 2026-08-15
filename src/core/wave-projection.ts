import { SAFETY } from "../domain/safety.js";
import type { ControllerContext } from "./controller-context.js";
import { inspect } from "./controller-context.js";
import { isTerminalWave } from "./state-machine.js";

export function capabilities(ctrl: ControllerContext) {
  return {
    milestone: "v0",
    phases: ["M0", "P1", "P2", "P3", "P4", "P5"],
    safety: { ...SAFETY },
    productionDrainEnabled: false,
    overnightEnabled: false,
    productionWorkerLaunchEnabled: false,
    supervisedOneTicketLaunchAllowed: SAFETY.supervisedOneTicketLaunchAllowed,
    supervisedBoundedLaunchAllowed: SAFETY.supervisedBoundedLaunchAllowed,
    supervisedMaxTickets: SAFETY.supervisedMaxTickets,
    launchMode: ctrl.launchMode,
    publicApisOnly: true,
  };
}

export function project(ctrl: ControllerContext) {
  return {
    generatedAt: ctrl.clock.now(),
    authoritative: false,
    productionDrainEnabled: false,
    overnightEnabled: false,
    productionWorkerLaunchEnabled: false,
    supervisedOneTicketLaunchAllowed: SAFETY.supervisedOneTicketLaunchAllowed,
    safety: { ...SAFETY },
    waves: ctrl.db.listWaves().map((wave) => {
      const view = inspect(ctrl, wave.waveId);
      return {
        waveId: wave.waveId,
        status: wave.status,
        revision: wave.revision,
        manifestHash: wave.manifestHash,
        flowId: wave.flowId,
        nextAction: wave.nextAction,
        cancelRequested: wave.cancelRequested,
        budgets: {
          committedTokens: wave.counters.committedTokens,
          reservedTokens: wave.counters.reservedTokens,
          indeterminateTokens: wave.counters.indeterminateTokens,
          launches: wave.counters.launches,
          maxTokens: wave.limits.maxTokens,
          maxLaunches: wave.limits.maxLaunches,
        },
        approvals: view.tickets
          .filter((t) => t.status === "PLAN_REVIEW")
          .map((t) => ({
            ticketId: t.ticketId,
            revision: t.revision,
            plan: t.planArtifact,
          })),
        pauseCancel: {
          canPause:
            wave.status === "RUNNING" ||
            wave.status === "WAITING_APPROVAL" ||
            wave.status === "AWAITING_PLAN_GATE",
          canCancel: !isTerminalWave(wave.status),
          canResume: wave.status === "PAUSED",
        },
        tickets: view.tickets.map((t) => ({
          ticketId: t.ticketId,
          status: t.status,
          stage: t.stage,
          nextAction: t.nextAction,
          plan: t.planArtifact,
          worktree: t.implWorktree,
          proof: t.verifyProof,
        })),
        runs: view.stages.map((s) => ({
          stageRunId: s.stageRunId,
          ticketId: s.ticketId,
          stage: s.stage,
          attempt: s.attempt,
          taskId: s.taskId,
          runId: s.runId,
          sessionId: s.sessionId,
          status: s.status,
        })),
        artifacts: view.artifacts.map((a) => ({
          kind: a.kind,
          path: a.path,
          ticketId: a.ticketId,
          hash: a.hash,
        })),
      };
    }),
  };
}
