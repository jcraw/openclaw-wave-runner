import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const isolated = mkdtempSync(resolve(tmpdir(), "wave-runner-m0-validate-"));
const home = resolve(isolated, "home");
const state = resolve(isolated, "state");
const workspace = resolve(isolated, "workspace");
const config = resolve(isolated, "openclaw.json");

mkdirSync(home, { recursive: true });
mkdirSync(state, { recursive: true });
mkdirSync(workspace, { recursive: true });
writeFileSync(
  config,
  JSON.stringify(
    {
      gateway: { mode: "local" },
      agents: { defaults: { workspace } },
      plugins: {
        load: { paths: [root] },
        entries: { "wave-runner-m0": { enabled: true, config: {} } },
      },
    },
    null,
    2,
  ),
);

const env = {
  ...process.env,
  HOME: home,
  OPENCLAW_STATE_DIR: state,
  OPENCLAW_CONFIG_PATH: config,
};

try {
  const inspectText = execFileSync(
    "openclaw",
    ["plugins", "inspect", "wave-runner-m0", "--runtime", "--json"],
    { cwd: root, env, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
  );
  const inspect = JSON.parse(inspectText);
  if (inspect.plugin?.status !== "loaded") {
    throw new Error(`plugin status is ${String(inspect.plugin?.status)}`);
  }
  const methods = new Set(inspect.gatewayMethods ?? []);
  for (const method of [
    "wave_runner_m0.start",
    "wave_runner_m0.settle",
    "wave_runner_m0.approve",
    "wave_runner_m0.cancel",
    "wave_runner_m0.inspect",
    "wave_runner_m0.capabilities",
    "wave_runner.capabilities",
    "wave_runner.dry_run",
    "wave_runner.create",
    "wave_runner.inspect",
    "wave_runner.freeze",
    "wave_runner.start",
    "wave_runner.tick",
    "wave_runner.resume",
    "wave_runner.pause",
    "wave_runner.cancel",
    "wave_runner.approve",
    "wave_runner.project",
    "wave_runner.emergency_stop",
  ]) {
    if (!methods.has(method)) throw new Error(`missing Gateway method: ${method}`);
  }
  execFileSync("openclaw", ["plugins", "doctor"], {
    cwd: root,
    env,
    encoding: "utf8",
    stdio: ["ignore", "inherit", "inherit"],
  });
  console.log(
    JSON.stringify(
      {
        ok: true,
        status: inspect.plugin.status,
        gatewayMethods: [...methods].sort(),
        diagnostics: inspect.plugin.diagnostics ?? [],
      },
      null,
      2,
    ),
  );
} finally {
  rmSync(isolated, { recursive: true, force: true });
}
