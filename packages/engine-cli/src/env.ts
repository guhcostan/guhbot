/**
 * The environment handed to an agent CLI child process.
 *
 * An agent CLI is arbitrary code that the user installed, but it is still not
 * entitled to this host's credentials. It has its own subscription session on
 * disk, and that is the only credential it should use. Passing `process.env`
 * through would hand every API key, cloud credential and session token in the
 * host process to a child that also reads untrusted content and runs commands —
 * which is precisely the leak `secrets.*` exists to prevent elsewhere.
 *
 * This mirrors the rule in `@guhbot/mcp` (`buildChildEnv`) rather than importing
 * it: mcp is a capability, not a library, and an engine must not depend on
 * another capability. The two lists are intentionally the same shape — an
 * allowlist written out by hand, never a wildcard — because a wildcard silently
 * inherits whatever the host's environment gains later.
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
  // The CLIs keep their signed-in session under the XDG directories on Linux.
  // Stripping these would make a user who configured them look signed out, and
  // reporting a signed-in user as signed out is its own kind of lie.
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_CACHE_HOME',
  'XDG_STATE_HOME',
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
 * Exported so the rule is testable on its own, and so a host can apply the same
 * judgement where it stores engine configuration.
 */
export function isSecretLikeCliEnvName(name: string): boolean {
  return name.toUpperCase().startsWith('AWS_') || SECRET_SUFFIX.test(name);
}

/**
 * Build the child environment.
 *
 * Inherited values are filtered; `configured` values win and are passed
 * verbatim. Naming `ANTHROPIC_API_KEY` in an engine's own configuration is the
 * documented way to give that one CLI its own credential, so the secret filter
 * deliberately does not apply to it. Those values are never echoed into a tool
 * result, a log line, an error message or a transcript entry.
 */
export function buildCliEnv(
  configured: Record<string, string> | undefined,
  hostEnv: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};

  for (const key of INHERITED_ENV_KEYS) {
    const value = hostEnv[key];
    if (value === undefined || isSecretLikeCliEnvName(key)) continue;
    env[key] = value;
  }

  for (const [key, value] of Object.entries(configured ?? {})) {
    // A key containing `=` or NUL can smuggle a second variable past the spawn
    // layer's env handling on some platforms.
    if (key.length === 0 || key.includes('=') || key.includes('\0')) continue;
    env[key] = value;
  }

  return env;
}
