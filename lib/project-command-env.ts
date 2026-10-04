/**
 * Remove variables owned by the omp-web host before starting a child process.
 *
 * Two categories are stripped, and the distinction matters:
 *
 * - **Host runtime** (`PORT`, `NODE_ENV`, `NEXT_*`): these describe the Next.js
 *   server rather than the selected project, and a child that sees them can
 *   behave as if it were running inside the web app.
 * - **Host secrets and plumbing** (every `OMP_WEB_*`): `OMP_WEB_PASSWORD` is the
 *   credential guarding the app's own API, and `OMP_WEB_STT_KEY` is a speech API
 *   key. A child process that inherits either leaks it — an omp agent child runs
 *   shell tools, so the value could be echoed into a transcript the user then
 *   exports. The rest (`OMP_WEB_OMP_BIN`, `OMP_WEB_HOSTNAME`, `OMP_WEB_PORT`,
 *   `OMP_WEB_LAUNCHER_PID`, `OMP_WEB_PACKAGE_DIR`, the STT endpoint and model)
 *   are host plumbing that describes no project.
 *
 * The rule is the whole `OMP_WEB_` prefix rather than a list of two secrets,
 * because a list rots: the next host secret added would leak silently until
 * someone remembered to extend it.
 *
 * Deliberately NOT stripped: credentials the user set for their own work
 * (`OPENAI_API_KEY` and friends). Those belong to their shell and to omp, and
 * removing them would break the thing this app exists to do.
 */
function isHostRuntimeVariable(name: string, platform: NodeJS.Platform): boolean {
  const comparableName = platform === "win32" ? name.toUpperCase() : name;
  return comparableName === "PORT"
    || comparableName === "NODE_ENV"
    || comparableName.startsWith("NEXT_")
    || comparableName.startsWith("OMP_WEB_");
}

export function sanitizeProjectCommandEnvironment(
  baseEnvironment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const environment = { ...baseEnvironment };
  for (const name of Object.keys(environment)) {
    if (isHostRuntimeVariable(name, platform)) delete environment[name];
  }
  return environment;
}

/**
 * The environment for a child process: the current environment minus the host's
 * own variables, plus the caller's overrides.
 *
 * Sanitization is applied AFTER the merge, so an override cannot accidentally put
 * a host secret back. That is the reason it takes the base internally rather than
 * expecting callers to compose the two themselves — which is how eleven spawn
 * sites were each spreading `process.env` on their own.
 */
export function hostChildEnv(
  overrides: Record<string, string> = {},
  baseEnvironment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  return sanitizeProjectCommandEnvironment({ ...baseEnvironment, ...overrides }, platform);
}