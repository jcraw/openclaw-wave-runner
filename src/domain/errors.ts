export class WaveError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "WaveError";
  }
}

export class DuplicateEventError extends WaveError {
  constructor(eventId: string) {
    super(`Duplicate event ${eventId} ignored.`, "duplicate_event", false);
    this.name = "DuplicateEventError";
  }
}

export class StaleRevisionError extends WaveError {
  constructor(expected: number, actual: number) {
    super(`Stale revision ${expected}; current is ${actual}.`, "stale_revision", false);
    this.name = "StaleRevisionError";
  }
}

export class AdmissionDeniedError extends WaveError {
  constructor(reason: string) {
    super(`Admission denied: ${reason}`, "admission_denied", false);
    this.name = "AdmissionDeniedError";
  }
}

export class SafetyGateError extends WaveError {
  constructor(reason: string) {
    super(`Safety gate: ${reason}`, "safety_gate", false);
    this.name = "SafetyGateError";
  }
}

export class CancelledError extends WaveError {
  constructor(waveId: string) {
    super(`Wave ${waveId} cancellation is sticky; new children are forbidden.`, "cancelled", false);
    this.name = "CancelledError";
  }
}
