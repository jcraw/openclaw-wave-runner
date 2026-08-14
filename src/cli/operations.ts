import { writeFileSync } from "node:fs";

import { WaveController, defaultCreateInput } from "../core/controller.js";
import type { CreateWaveInput } from "../domain/types.js";

export type OperatorCommand =
  | { op: "dry-run"; input: CreateWaveInput }
  | { op: "create"; input: CreateWaveInput }
  | { op: "freeze"; waveId: string; eventId?: string }
  | { op: "start"; waveId: string; eventId?: string; supervised?: boolean }
  | { op: "inspect"; waveId: string }
  | { op: "pause"; waveId: string; eventId?: string }
  | { op: "resume"; waveId: string; eventId?: string }
  | { op: "cancel"; waveId: string; eventId?: string }
  | { op: "approve"; waveId: string; ticketId: string; expectedRevision: number; eventId?: string }
  | { op: "tick"; waveId: string; supervised?: boolean }
  | { op: "project"; outPath?: string }
  | { op: "emergency-stop"; reason?: string }
  | { op: "backup"; destPath: string }
  | { op: "capabilities" };

export async function runOperator(controller: WaveController, command: OperatorCommand): Promise<unknown> {
  switch (command.op) {
    case "dry-run":
      return controller.dryRun(command.input);
    case "create":
      return controller.create(command.input);
    case "freeze":
      return controller.freeze(command.waveId, command.eventId);
    case "start":
      return controller.start(command.waveId, command.eventId, undefined, {
        supervisedBoundedPilot: command.supervised === true,
        operatorAction: command.supervised === true,
      });
    case "inspect":
      return controller.inspect(command.waveId);
    case "pause":
      return controller.pause(command.waveId, command.eventId);
    case "resume":
      return controller.resume(command.waveId, command.eventId);
    case "cancel":
      return controller.cancel(command.waveId, command.eventId);
    case "approve":
      return controller.approve(
        command.waveId,
        command.ticketId,
        command.expectedRevision,
        command.eventId,
      );
    case "tick":
      return controller.tick(command.waveId, {
        supervisedBoundedPilot: command.supervised === true,
        operatorAction: command.supervised === true,
      });
    case "project": {
      const projection = controller.project();
      if (command.outPath) {
        writeFileSync(command.outPath, `${JSON.stringify(projection, null, 2)}\n`, "utf8");
      }
      return projection;
    }
    case "emergency-stop":
      return controller.emergencyStop(command.reason);
    case "backup":
      return controller.backup(command.destPath);
    case "capabilities":
      return controller.capabilities();
  }
}

export { defaultCreateInput };
