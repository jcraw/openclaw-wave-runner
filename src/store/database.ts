import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type {
  ArtifactRecord,
  BudgetEntry,
  DomainEvent,
  LaunchOutbox,
  LeaseRecord,
  StageRun,
  TicketRun,
  WaveRecord,
} from "../domain/types.js";
import {
  mapArtifact,
  mapBudget,
  mapEvent,
  mapLease,
  mapOutbox,
  mapStage,
  mapTicket,
  mapWave,
} from "./mappers.js";
import { MIGRATIONS, SCHEMA_VERSION } from "./schema.js";

export class WaveDatabase {
  readonly db: DatabaseSync;
  readonly path: string;

  constructor(path: string) {
    this.path = path;
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true });
    }
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.db.exec("PRAGMA busy_timeout = 5000;");
    if (path !== ":memory:") {
      this.db.exec("PRAGMA journal_mode = WAL;");
    }
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // ignore rollback failure after a failed begin
      }
      throw error;
    }
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL
      );
    `);
    const applied = new Set(
      this.db
        .prepare("SELECT version FROM schema_migrations")
        .all()
        .map((row) => Number((row as { version: number }).version)),
    );
    for (const migration of MIGRATIONS) {
      if (applied.has(migration.version)) continue;
      this.db.exec(migration.sql);
      this.db
        .prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)")
        .run(migration.version, Date.now());
    }
  }

  schemaVersion(): number {
    const row = this.db
      .prepare("SELECT MAX(version) AS version FROM schema_migrations")
      .get() as { version: number } | undefined;
    return row?.version ?? 0;
  }

  getWave(waveId: string): WaveRecord | undefined {
    const row = this.db.prepare("SELECT * FROM waves WHERE wave_id = ?").get(waveId) as
      | Record<string, unknown>
      | undefined;
    return row ? mapWave(row) : undefined;
  }

  listWaves(): WaveRecord[] {
    return this.db
      .prepare("SELECT * FROM waves ORDER BY created_at")
      .all()
      .map((row) => mapWave(row as Record<string, unknown>));
  }

  putWave(wave: WaveRecord): void {
    this.db
      .prepare(
        `INSERT INTO waves (
          wave_id, manifest_json, manifest_hash, repo_path, base_sha, status, revision,
          deadline_ms, stop_at, limits_json, counters_json, flow_id, owner, next_action,
          created_at, updated_at, cancel_requested, quota_mode
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(wave_id) DO UPDATE SET
          manifest_json=excluded.manifest_json,
          manifest_hash=excluded.manifest_hash,
          repo_path=excluded.repo_path,
          base_sha=excluded.base_sha,
          status=excluded.status,
          revision=excluded.revision,
          deadline_ms=excluded.deadline_ms,
          stop_at=excluded.stop_at,
          limits_json=excluded.limits_json,
          counters_json=excluded.counters_json,
          flow_id=excluded.flow_id,
          owner=excluded.owner,
          next_action=excluded.next_action,
          updated_at=excluded.updated_at,
          cancel_requested=excluded.cancel_requested,
          quota_mode=excluded.quota_mode`,
      )
      .run(
        wave.waveId,
        wave.manifestJson,
        wave.manifestHash,
        wave.repoPath,
        wave.baseSha,
        wave.status,
        wave.revision,
        wave.deadlineMs ?? null,
        wave.stopAt ?? null,
        JSON.stringify(wave.limits),
        JSON.stringify(wave.counters),
        wave.flowId ?? null,
        wave.owner,
        wave.nextAction,
        wave.createdAt,
        wave.updatedAt,
        wave.cancelRequested ? 1 : 0,
        wave.quotaMode,
      );
  }

  listTickets(waveId: string): TicketRun[] {
    return this.db
      .prepare("SELECT * FROM ticket_runs WHERE wave_id = ? ORDER BY ord")
      .all(waveId)
      .map((row) => mapTicket(row as Record<string, unknown>));
  }

  getTicket(waveId: string, ticketId: string): TicketRun | undefined {
    const row = this.db
      .prepare("SELECT * FROM ticket_runs WHERE wave_id = ? AND ticket_id = ?")
      .get(waveId, ticketId) as Record<string, unknown> | undefined;
    return row ? mapTicket(row) : undefined;
  }

  putTicket(ticket: TicketRun): void {
    this.db
      .prepare(
        `INSERT INTO ticket_runs (
          wave_id, ticket_id, content_hash, title, depends_on_json, ord, source_path,
          stage, status, revision, owner, next_action, plan_class, plan_artifact,
          impl_worktree, impl_branch, impl_sha, verify_proof, verify_command, provider, model, result,
          writer_scope, human_hold, human_hold_reason, product, game
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(wave_id, ticket_id) DO UPDATE SET
          content_hash=excluded.content_hash,
          title=excluded.title,
          depends_on_json=excluded.depends_on_json,
          ord=excluded.ord,
          source_path=excluded.source_path,
          stage=excluded.stage,
          status=excluded.status,
          revision=excluded.revision,
          owner=excluded.owner,
          next_action=excluded.next_action,
          plan_class=excluded.plan_class,
          plan_artifact=excluded.plan_artifact,
          impl_worktree=excluded.impl_worktree,
          impl_branch=excluded.impl_branch,
          impl_sha=excluded.impl_sha,
          verify_proof=excluded.verify_proof,
          verify_command=excluded.verify_command,
          provider=excluded.provider,
          model=excluded.model,
          result=excluded.result,
          writer_scope=excluded.writer_scope,
          human_hold=excluded.human_hold,
          human_hold_reason=excluded.human_hold_reason,
          product=excluded.product,
          game=excluded.game`,
      )
      .run(
        ticket.waveId,
        ticket.ticketId,
        ticket.contentHash,
        ticket.title,
        JSON.stringify(ticket.dependsOn),
        ticket.order,
        ticket.sourcePath,
        ticket.stage,
        ticket.status,
        ticket.revision,
        ticket.owner,
        ticket.nextAction,
        ticket.planClass ?? null,
        ticket.planArtifact ?? null,
        ticket.implWorktree ?? null,
        ticket.implBranch ?? null,
        ticket.implSha ?? null,
        ticket.verifyProof ?? null,
        ticket.verifyCommand ?? null,
        ticket.provider ?? null,
        ticket.model ?? null,
        ticket.result ?? null,
        ticket.writerScope ?? null,
        ticket.humanHold === undefined ? null : ticket.humanHold ? 1 : 0,
        ticket.humanHoldReason ?? null,
        ticket.product ?? null,
        ticket.game ?? null,
      );
  }

  listStages(waveId: string): StageRun[] {
    return this.db
      .prepare("SELECT * FROM stage_runs WHERE wave_id = ? ORDER BY created_at")
      .all(waveId)
      .map((row) => mapStage(row as Record<string, unknown>));
  }

  getStageByIdempotency(key: string): StageRun | undefined {
    const row = this.db
      .prepare("SELECT * FROM stage_runs WHERE idempotency_key = ?")
      .get(key) as Record<string, unknown> | undefined;
    return row ? mapStage(row) : undefined;
  }

  putStage(stage: StageRun): void {
    this.db
      .prepare(
        `INSERT INTO stage_runs (
          stage_run_id, wave_id, ticket_id, stage, attempt, idempotency_key, model, provider,
          task_id, run_id, session_id, receipt_json, output_ref, status, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(stage_run_id) DO UPDATE SET
          model=excluded.model,
          provider=excluded.provider,
          task_id=excluded.task_id,
          run_id=excluded.run_id,
          session_id=excluded.session_id,
          receipt_json=excluded.receipt_json,
          output_ref=excluded.output_ref,
          status=excluded.status`,
      )
      .run(
        stage.stageRunId,
        stage.waveId,
        stage.ticketId,
        stage.stage,
        stage.attempt,
        stage.idempotencyKey,
        stage.model ?? null,
        stage.provider ?? null,
        stage.taskId ?? null,
        stage.runId ?? null,
        stage.sessionId ?? null,
        stage.receiptJson ?? null,
        stage.outputRef ?? null,
        stage.status,
        stage.createdAt,
      );
  }

  listBudgets(waveId: string): BudgetEntry[] {
    return this.db
      .prepare("SELECT * FROM budget_entries WHERE wave_id = ? ORDER BY created_at")
      .all(waveId)
      .map((row) => mapBudget(row as Record<string, unknown>));
  }

  putBudget(entry: BudgetEntry): void {
    this.db
      .prepare(
        `INSERT INTO budget_entries (
          budget_id, wave_id, stage_run_id, tokens_reserved, cost_reserved_micros,
          tokens_actual, cost_actual_micros, state, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(budget_id) DO UPDATE SET
          tokens_actual=excluded.tokens_actual,
          cost_actual_micros=excluded.cost_actual_micros,
          state=excluded.state,
          updated_at=excluded.updated_at`,
      )
      .run(
        entry.budgetId,
        entry.waveId,
        entry.stageRunId ?? null,
        entry.tokensReserved,
        entry.costReservedMicros,
        entry.tokensActual ?? null,
        entry.costActualMicros ?? null,
        entry.state,
        entry.createdAt,
        entry.updatedAt,
      );
  }

  listOutbox(waveId: string): LaunchOutbox[] {
    return this.db
      .prepare("SELECT * FROM launch_outbox WHERE wave_id = ? ORDER BY created_at")
      .all(waveId)
      .map((row) => mapOutbox(row as Record<string, unknown>));
  }

  listOpenOutbox(): LaunchOutbox[] {
    return this.db
      .prepare(
        "SELECT * FROM launch_outbox WHERE state IN ('PENDING','CLAIMED','LAUNCHED','RECONCILING') ORDER BY created_at",
      )
      .all()
      .map((row) => mapOutbox(row as Record<string, unknown>));
  }

  getOutboxByIdempotency(key: string): LaunchOutbox | undefined {
    const row = this.db
      .prepare("SELECT * FROM launch_outbox WHERE idempotency_key = ?")
      .get(key) as Record<string, unknown> | undefined;
    return row ? mapOutbox(row) : undefined;
  }

  putOutbox(item: LaunchOutbox): void {
    this.db
      .prepare(
        `INSERT INTO launch_outbox (
          outbox_id, wave_id, ticket_id, stage, attempt, idempotency_key, state,
          fencing_generation, claimed_by, claimed_at, receipt_json, error, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(outbox_id) DO UPDATE SET
          state=excluded.state,
          fencing_generation=excluded.fencing_generation,
          claimed_by=excluded.claimed_by,
          claimed_at=excluded.claimed_at,
          receipt_json=excluded.receipt_json,
          error=excluded.error,
          updated_at=excluded.updated_at`,
      )
      .run(
        item.outboxId,
        item.waveId,
        item.ticketId,
        item.stage,
        item.attempt,
        item.idempotencyKey,
        item.state,
        item.fencingGeneration,
        item.claimedBy ?? null,
        item.claimedAt ?? null,
        item.receiptJson ?? null,
        item.error ?? null,
        item.createdAt,
        item.updatedAt,
      );
  }

  getLease(resourceKey: string): LeaseRecord | undefined {
    const row = this.db.prepare("SELECT * FROM leases WHERE resource_key = ?").get(resourceKey) as
      | Record<string, unknown>
      | undefined;
    return row ? mapLease(row) : undefined;
  }

  listLeases(waveId?: string): LeaseRecord[] {
    const rows = waveId
      ? this.db.prepare("SELECT * FROM leases WHERE wave_id = ?").all(waveId)
      : this.db.prepare("SELECT * FROM leases").all();
    return rows.map((row) => mapLease(row as Record<string, unknown>));
  }

  putLease(lease: LeaseRecord): void {
    this.db
      .prepare(
        `INSERT INTO leases (
          resource_key, generation, holder, wave_id, ticket_id, task_id,
          process_identity, pid, pid_start_time, expires_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(resource_key) DO UPDATE SET
          generation=excluded.generation,
          holder=excluded.holder,
          wave_id=excluded.wave_id,
          ticket_id=excluded.ticket_id,
          task_id=excluded.task_id,
          process_identity=excluded.process_identity,
          pid=excluded.pid,
          pid_start_time=excluded.pid_start_time,
          expires_at=excluded.expires_at`,
      )
      .run(
        lease.resourceKey,
        lease.generation,
        lease.holder,
        lease.waveId ?? null,
        lease.ticketId ?? null,
        lease.taskId ?? null,
        lease.processIdentity,
        lease.pid ?? null,
        lease.pidStartTime ?? null,
        lease.expiresAt,
        lease.createdAt,
      );
  }

  deleteLease(resourceKey: string): void {
    this.db.prepare("DELETE FROM leases WHERE resource_key = ?").run(resourceKey);
  }

  getEvent(eventId: string): DomainEvent | undefined {
    const row = this.db.prepare("SELECT * FROM events WHERE event_id = ?").get(eventId) as
      | Record<string, unknown>
      | undefined;
    return row ? mapEvent(row) : undefined;
  }

  insertEvent(event: DomainEvent): boolean {
    try {
      this.db
        .prepare(
          "INSERT INTO events(event_id, wave_id, type, payload_json, created_at, revision_applied) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run(
          event.eventId,
          event.waveId,
          event.type,
          event.payloadJson,
          event.createdAt,
          event.revisionApplied ?? null,
        );
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("UNIQUE") || message.toLowerCase().includes("unique")) {
        return false;
      }
      throw error;
    }
  }

  listEvents(waveId: string): DomainEvent[] {
    return this.db
      .prepare("SELECT * FROM events WHERE wave_id = ? ORDER BY created_at")
      .all(waveId)
      .map((row) => mapEvent(row as Record<string, unknown>));
  }

  putArtifact(artifact: ArtifactRecord): void {
    this.db
      .prepare(
        `INSERT INTO artifacts(artifact_id, wave_id, ticket_id, kind, path, hash, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(artifact_id) DO UPDATE SET path=excluded.path, hash=excluded.hash`,
      )
      .run(
        artifact.artifactId,
        artifact.waveId,
        artifact.ticketId ?? null,
        artifact.kind,
        artifact.path,
        artifact.hash ?? null,
        artifact.createdAt,
      );
  }

  listArtifacts(waveId: string): ArtifactRecord[] {
    return this.db
      .prepare("SELECT * FROM artifacts WHERE wave_id = ? ORDER BY created_at")
      .all(waveId)
      .map((row) => mapArtifact(row as Record<string, unknown>));
  }
}

export function expectedSchemaVersion(): number {
  return SCHEMA_VERSION;
}
