import type { ToolDefinition } from '@guhbot/agent';
import type { OriginCredentials } from './credentials.js';

/**
 * The model-facing half of the capability: one read-only tool.
 *
 * It reports which origins have an approval, and nothing about the material
 * behind them. In particular it does not say whether a value is stored for a
 * given origin, so an approved-but-empty origin and an approved-and-loaded one
 * are indistinguishable from the model's side. That is deliberate: the number
 * of things a model can learn about the vault is one list of origins a person
 * already agreed to.
 *
 * There is no `credential_use` tool, and there must never be one. A model that
 * can ask for a credential by name can be argued into asking for the wrong one;
 * the release instead happens inside whichever tool actually needs the material,
 * through `OriginCredentialProvider`, where the origin is a fact about the
 * request rather than a string a model chose.
 */
export const CREDENTIAL_ORIGINS_TOOL = 'credential_origins';

export function createCredentialsTools(credentials: OriginCredentials): ToolDefinition[] {
  return [
    {
      name: CREDENTIAL_ORIGINS_TOOL,
      description:
        'List the origins this host holds a credential approval for, with the time each was approved. '
        + 'Credential values are never returned to you and no tool can ask for one by name; a tool that '
        + 'needs a credential releases it inside its own execution.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      // Reading an approved-origin list changes nothing and reveals nothing a
      // person did not already approve, so blocking an unattended run on it
      // would cost more than it protects.
      requiresApproval: false,
      execute: async () => {
        const origins = credentials.approvedOrigins().map((record) => ({
          origin: record.origin,
          approvedAt: record.approvedAt,
        }));
        return JSON.stringify({
          origins,
          note: 'Approval is per origin. A value is released only inside a tool execution that needs it, and never to you.',
        });
      },
    },
  ];
}
