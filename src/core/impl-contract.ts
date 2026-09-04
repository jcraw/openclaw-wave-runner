import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { checkPlanReview, reviewFilePath } from "./plan-review.js";

export const IMPL_CONTRACT_FILE = "IMPL_CONTRACT.md";
export const IMPL_CONTRACT_CAP = 8000;

const HEADING_RE = /^##\s+\*{0,2}Conditions or revise\*{0,2}\b[^\n]*\n?/im;
const NONE_RE = /^(none|n\/?a|—|-)\s*$/i;

export type ImplContractReason = "missing_impl_contract" | "impl_contract_too_large";

export type ImplContractExtract =
  | { ok: true; body: string }
  | { ok: false; reason: ImplContractReason };

export function implContractRequired(verdict: string): boolean {
  return verdict === "approve-with-conditions";
}

export function extractImplContract(reviewText: string): ImplContractExtract {
  const heading = reviewText.match(HEADING_RE);
  if (!heading || heading.index === undefined) {
    return { ok: false, reason: "missing_impl_contract" };
  }
  const start = heading.index + heading[0].length;
  const rest = reviewText.slice(start);
  const next = rest.search(/^##\s+/m);
  const body = (next < 0 ? rest : rest.slice(0, next)).trim();
  if (!body || NONE_RE.test(body)) {
    return { ok: false, reason: "missing_impl_contract" };
  }
  if (body.length > IMPL_CONTRACT_CAP) {
    return { ok: false, reason: "impl_contract_too_large" };
  }
  return { ok: true, body };
}

export function writeImplContract(outputDir: string, body: string): string {
  mkdirSync(outputDir, { recursive: true });
  const dest = join(outputDir, IMPL_CONTRACT_FILE);
  writeFileSync(dest, body.endsWith("\n") ? body : `${body}\n`, "utf8");
  return dest;
}

export type ImplContractLaunch =
  | { ok: true; wrote: boolean }
  | { ok: false; reason: ImplContractReason };

/** Freeze AWC conditions into outputDir. No-op when contract is not required. */
export function prepareImplContract(input: {
  stage: string;
  forgeRoot?: string;
  ticketId: string;
  outputDir: string;
}): ImplContractLaunch {
  if (input.stage !== "IMPL") return { ok: true, wrote: false };
  const review = checkPlanReview({ forgeRoot: input.forgeRoot, ticketId: input.ticketId });
  if (!review.ok || !implContractRequired(review.verdict)) {
    return { ok: true, wrote: false };
  }
  if (!input.forgeRoot) return { ok: false, reason: "missing_impl_contract" };
  const path = reviewFilePath(input.forgeRoot, input.ticketId);
  if (!existsSync(path)) return { ok: false, reason: "missing_impl_contract" };
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return { ok: false, reason: "missing_impl_contract" };
  }
  const extracted = extractImplContract(text);
  if (!extracted.ok) return extracted;
  writeImplContract(input.outputDir, extracted.body);
  return { ok: true, wrote: true };
}
