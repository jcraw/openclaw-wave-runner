import type {
  ArtifactRecord,
  BudgetEntry,
  DomainEvent,
  LaunchOutbox,
  LeaseRecord,
  StageRun,
  TicketRun,
  WaveLimits,
  WaveRecord,
} from "../domain/types.js";

function optString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function mapWave(row: Record<string, unknown>): WaveRecord {
  return {
    waveId: String(row.wave_id),
    manifestJson: String(row.manifest_json),
    manifestHash: String(row.manifest_hash),
    repoPath: String(row.repo_path),
    baseSha: String(row.base_sha),
    status: row.status as WaveRecord["status"],
    revision: Number(row.revision),
    deadlineMs: row.deadline_ms == null ? undefined : Number(row.deadline_ms),
    stopAt: row.stop_at == null ? undefined : Number(row.stop_at),
    limits: JSON.parse(String(row.limits_json)) as WaveLimits,
    counters: JSON.parse(String(row.counters_json)) as WaveRecord["counters"],
    flowId: optString(row.flow_id),
    owner: String(row.owner),
    nextAction: String(row.next_action),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    cancelRequested: Number(row.cancel_requested) === 1,
    quotaMode: (row.quota_mode as WaveRecord["quotaMode"]) ?? "tokens",
  };
}

export function mapTicket(row: Record<string, unknown>): TicketRun {
  return {
    waveId: String(row.wave_id),
    ticketId: String(row.ticket_id),
    contentHash: String(row.content_hash),
    title: String(row.title),
    dependsOn: JSON.parse(String(row.depends_on_json)) as string[],
    order: Number(row.ord),
    sourcePath: String(row.source_path),
    stage: row.stage as TicketRun["stage"],
    status: row.status as TicketRun["status"],
    revision: Number(row.revision),
    owner: String(row.owner),
    nextAction: String(row.next_action),
    planClass: optString(row.plan_class),
    planArtifact: optString(row.plan_artifact),
    implWorktree: optString(row.impl_worktree),
    implBranch: optString(row.impl_branch),
    implSha: optString(row.impl_sha),
    verifyProof: optString(row.verify_proof),
    verifyCommand: optString(row.verify_command),
    provider: optString(row.provider),
    model: optString(row.model),
    result: optString(row.result),
    writerScope: optString(row.writer_scope),
    humanHold: row.human_hold == null ? undefined : Number(row.human_hold) === 1,
    humanHoldReason: optString(row.human_hold_reason) as TicketRun["humanHoldReason"],
    product: optString(row.product),
    game: optString(row.game),
  };
}

export function mapStage(row: Record<string, unknown>): StageRun {
  return {
    stageRunId: String(row.stage_run_id),
    waveId: String(row.wave_id),
    ticketId: String(row.ticket_id),
    stage: row.stage as StageRun["stage"],
    attempt: Number(row.attempt),
    idempotencyKey: String(row.idempotency_key),
    model: optString(row.model),
    provider: optString(row.provider),
    taskId: optString(row.task_id),
    runId: optString(row.run_id),
    sessionId: optString(row.session_id),
    receiptJson: optString(row.receipt_json),
    outputRef: optString(row.output_ref),
    status: row.status as StageRun["status"],
    createdAt: Number(row.created_at),
  };
}

export function mapBudget(row: Record<string, unknown>): BudgetEntry {
  return {
    budgetId: String(row.budget_id),
    waveId: String(row.wave_id),
    stageRunId: optString(row.stage_run_id),
    tokensReserved: Number(row.tokens_reserved),
    costReservedMicros: Number(row.cost_reserved_micros),
    tokensActual: row.tokens_actual == null ? undefined : Number(row.tokens_actual),
    costActualMicros: row.cost_actual_micros == null ? undefined : Number(row.cost_actual_micros),
    state: row.state as BudgetEntry["state"],
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

export function mapOutbox(row: Record<string, unknown>): LaunchOutbox {
  return {
    outboxId: String(row.outbox_id),
    waveId: String(row.wave_id),
    ticketId: String(row.ticket_id),
    stage: row.stage as LaunchOutbox["stage"],
    attempt: Number(row.attempt),
    idempotencyKey: String(row.idempotency_key),
    state: row.state as LaunchOutbox["state"],
    fencingGeneration: Number(row.fencing_generation),
    claimedBy: optString(row.claimed_by),
    claimedAt: row.claimed_at == null ? undefined : Number(row.claimed_at),
    receiptJson: optString(row.receipt_json),
    error: optString(row.error),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

export function mapLease(row: Record<string, unknown>): LeaseRecord {
  return {
    resourceKey: String(row.resource_key),
    generation: Number(row.generation),
    holder: String(row.holder),
    waveId: optString(row.wave_id),
    ticketId: optString(row.ticket_id),
    taskId: optString(row.task_id),
    processIdentity: String(row.process_identity),
    pid: row.pid == null ? undefined : Number(row.pid),
    pidStartTime: optString(row.pid_start_time),
    expiresAt: Number(row.expires_at),
    createdAt: Number(row.created_at),
  };
}

export function mapEvent(row: Record<string, unknown>): DomainEvent {
  return {
    eventId: String(row.event_id),
    waveId: String(row.wave_id),
    type: String(row.type),
    payloadJson: String(row.payload_json),
    createdAt: Number(row.created_at),
    revisionApplied: row.revision_applied == null ? undefined : Number(row.revision_applied),
  };
}

export function mapArtifact(row: Record<string, unknown>): ArtifactRecord {
  return {
    artifactId: String(row.artifact_id),
    waveId: String(row.wave_id),
    ticketId: optString(row.ticket_id),
    kind: String(row.kind),
    path: String(row.path),
    hash: optString(row.hash),
    createdAt: Number(row.created_at),
  };
}
