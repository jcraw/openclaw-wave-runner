export function parseFrontmatter(raw: string): { data: Record<string, string | string[] | boolean>; body: string } {
  if (!raw.startsWith("---")) return { data: {}, body: raw };
  const end = raw.indexOf("\n---", 3);
  if (end < 0) return { data: {}, body: raw };
  const block = raw.slice(4, end);
  const body = raw.slice(end + 4).replace(/^\n/, "");
  const data: Record<string, string | string[] | boolean> = {};
  for (const line of block.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes(":")) continue;
    const idx = trimmed.indexOf(":");
    const key = trimmed.slice(0, idx).trim();
    let value = trimmed.slice(idx + 1).trim();
    if (!key) continue;
    if (value.startsWith("[") && value.endsWith("]")) {
      data[key] = value
        .slice(1, -1)
        .split(",")
        .map((part) => part.trim().replace(/^['"]|['"]$/g, ""))
        .filter(Boolean);
      continue;
    }
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (value === "true" || value === "false") {
      data[key] = value === "true";
    } else {
      data[key] = value;
    }
  }
  return { data, body };
}

export function mapProjectedStatus(status: string): string {
  switch (status) {
    case "PLAN_REVIEW":
      return "plan_review";
    case "PLANNING":
    case "IMPLEMENTING":
    case "VERIFYING":
    case "CLAIMED":
    case "APPROVED":
    case "REVISING":
      return "in_progress";
    case "DONE":
      return "done";
    case "BLOCKED":
    case "BUDGET_STOPPED":
    case "CANCELLED":
    case "FAILED":
      return "blocked";
    default:
      return "open";
  }
}

export function upsertFrontmatter(
  raw: string,
  fields: Record<string, string | undefined>,
): string {
  const { data, body } = parseFrontmatter(raw);
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) data[key] = value;
  }
  const lines = Object.entries(data).map(([key, value]) => {
    if (Array.isArray(value)) return `${key}: [${value.join(", ")}]`;
    if (typeof value === "boolean") return `${key}: ${value}`;
    return `${key}: ${value}`;
  });
  return `---\n${lines.join("\n")}\n---\n\n${body.replace(/^\n/, "")}`;
}
