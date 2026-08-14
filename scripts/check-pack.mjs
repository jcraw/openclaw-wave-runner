#!/usr/bin/env node
/**
 * Verify npm pack contents are installable shape for OpenClaw plugins.
 */
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

const root = process.cwd();
const staging = mkdtempSync(join(tmpdir(), "wave-runner-pack-"));

try {
  const packed = execFileSync("npm", ["pack", "--pack-destination", staging, "--json"], {
    cwd: root,
    encoding: "utf8",
  });
  const info = JSON.parse(packed);
  const filename = info[0]?.filename;
  if (!filename) throw new Error("npm pack did not return filename");
  const tgz = join(staging, filename);
  execFileSync("tar", ["-xzf", tgz, "-C", staging], { stdio: "inherit" });
  const pkgRoot = join(staging, "package");
  const pkg = JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf8"));

  const required = [
    "package.json",
    "openclaw.plugin.json",
    "README.md",
    "LICENSE",
    "dist/src/index.js",
    "dist/scripts/wave-cli.js",
  ];
  const missing = required.filter((p) => !existsSync(join(pkgRoot, p)));
  if (missing.length) {
    throw new Error(`pack missing required paths: ${missing.join(", ")}`);
  }

  const extensions = pkg.openclaw?.extensions;
  if (!Array.isArray(extensions) || extensions.length === 0) {
    throw new Error("package.json openclaw.extensions must be a non-empty array");
  }
  for (const ext of extensions) {
    const rel = String(ext).replace(/^\.\//, "");
    if (!existsSync(join(pkgRoot, rel))) {
      throw new Error(`openclaw.extensions entry missing from pack: ${ext}`);
    }
    if (rel.endsWith(".ts")) {
      throw new Error(`published extension must be JS, got ${ext}`);
    }
  }

  if (!pkg.openclaw?.compat?.pluginApi) {
    throw new Error("openclaw.compat.pluginApi required for ClawHub");
  }
  if (!pkg.openclaw?.build?.openclawVersion) {
    throw new Error("openclaw.build.openclawVersion required for ClawHub");
  }

  // bin must exist
  const bin = pkg.bin?.["wave-runner"] ?? pkg.bin;
  if (typeof bin === "string") {
    if (!existsSync(join(pkgRoot, bin.replace(/^\.\//, "")))) {
      throw new Error(`bin missing from pack: ${bin}`);
    }
  }

  // must not ship tests or local state
  const banned = ["test/", "tmp/", "coverage/", "node_modules/", "src/"];
  const listing = execFileSync("tar", ["-tzf", tgz], { encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
  for (const row of listing) {
    const path = row.replace(/^package\//, "");
    for (const b of banned) {
      if (path === b.slice(0, -1) || path.startsWith(b)) {
        // src/ is banned from pack — we ship dist only
        throw new Error(`pack must not include ${path}`);
      }
    }
  }

  console.log(`pack OK: ${filename} (${listing.length} entries)`);
  console.log(`  name=${pkg.name} version=${pkg.version}`);
  console.log(`  extensions=${extensions.join(", ")}`);
} finally {
  rmSync(staging, { recursive: true, force: true });
}
