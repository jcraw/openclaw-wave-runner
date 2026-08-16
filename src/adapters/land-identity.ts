/**
 * Land commits use the primary repo identity (or WAVE_LAND_*), never an invented mailbox.
 */

const PERSONAL_MAILBOX =
  /@gmail\.com$|@googlemail\.com$|@outlook\.com$|@hotmail\.com$|@yahoo\.com$|@icloud\.com$|@me\.com$|@live\.com$/i;

export type LandIdentity = { name: string; email: string };

export type LandIdentityResult =
  | { ok: true; identity: LandIdentity }
  | { ok: false; error: string };

export function resolveLandIdentity(input: {
  repoPath: string;
  env?: NodeJS.ProcessEnv;
  readConfig?: (key: "user.name" | "user.email") => string;
}): LandIdentityResult {
  const env = input.env ?? process.env;
  const envName = (env.WAVE_LAND_NAME ?? "").trim();
  const envEmail = (env.WAVE_LAND_EMAIL ?? "").trim();
  let name = "";
  let email = "";
  if (envName && envEmail) {
    name = envName;
    email = envEmail;
  } else {
    const read = input.readConfig;
    name = (read ? read("user.name") : "").trim();
    email = (read ? read("user.email") : "").trim();
  }
  if (!name || !email) return { ok: false, error: "land identity missing" };
  if (PERSONAL_MAILBOX.test(email)) return { ok: false, error: "land identity personal mailbox" };
  return { ok: true, identity: { name, email } };
}
