/**
 * The environment handed to a spawned MCP server.
 *
 * A stdio server is arbitrary code that the user chose to run, but it is still
 * not entitled to the host's credentials. Passing `process.env` through would
 * hand it every API key, cloud credential and session token the host process can
 * see, and would turn "add an MCP server" into "exfiltrate the developer
 * machine". So the child gets an explicit allow list of variables a CLI program
 * needs to start, plus exactly what the caller configured for that server.
 *
 * The allow list is written out rather than expressed as a wildcard: a variable
 * that appears in the host's environment later is then not inherited by
 * accident, which is the failure mode a wildcard would hide.
 */

/** Variables an ordinary CLI program needs to start (POSIX and Windows). */
const INHERITED_ENV_KEYS = [
  'PATH',
  'HOME',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TZ',
  'TMPDIR',
  'USER',
  'LOGNAME',
  'SHELL',
  'TERM',
  'PWD',
  'SystemRoot',
  'SystemDrive',
  'windir',
  'ComSpec',
  'PATHEXT',
  'TEMP',
  'TMP',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'ProgramData',
  'ProgramFiles',
  'ProgramFiles(x86)',
  'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE',
  'OS',
] as const;

const SECRET_SUFFIX = /(_KEY|_TOKEN|_SECRET|_PASSWORD|_PASSWD|_CREDENTIAL|_CREDENTIALS)$/i;

/**
 * True for a name that conventionally holds a credential.
 *
 * Exported so a host can apply the same rule where it stores configurations,
 * and so the rule is testable on its own.
 */
export function isSecretLikeEnvName(name: string): boolean {
  return name.toUpperCase().startsWith('AWS_') || SECRET_SUFFIX.test(name);
}

/**
 * Build the child environment.
 *
 * Inherited values are filtered; `configured` values win. Configured values are
 * passed verbatim on purpose — naming `GITHUB_PERSONAL_ACCESS_TOKEN` (or any
 * other secret-looking variable) in a server's own config is the documented way
 * to give that one server its own credential. Those values are never echoed into
 * a tool result, a log line or an error message.
 */
export function buildChildEnv(
  configured: Record<string, string> | undefined,
  hostEnv: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};

  for (const key of INHERITED_ENV_KEYS) {
    const value = hostEnv[key];
    if (value === undefined || isSecretLikeEnvName(key)) continue;
    env[key] = value;
  }

  for (const [key, value] of Object.entries(configured ?? {})) {
    // An entry with `=` or NUL can smuggle a second variable past the spawn
    // layer's env handling on some platforms.
    if (key.length === 0 || key.includes('=') || key.includes('\0')) continue;
    env[key] = value;
  }

  return env;
}
