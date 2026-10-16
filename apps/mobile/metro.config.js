const path = require('node:path');
const { existsSync } = require('node:fs');
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// `@guhbot/server` exports the client SDK next to the host transport. Bundling
// the package entry would drag `ws`, `node:http` and the SQLite store into a
// phone bundle, so the resolver is pointed at the client module, which imports
// nothing but `@guhbot/protocol`. It is the same file the desktop renderer uses.
// Run `pnpm -r --filter './packages/**' build` first; without dist this falls
// back to the package entry and the bundle will complain about node builtins.
const clientSdk = path.resolve(__dirname, '../../packages/server/dist/client.js');

config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName === '@guhbot/server' && existsSync(clientSdk)) {
    return { type: 'sourceFile', filePath: clientSdk };
  }
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
