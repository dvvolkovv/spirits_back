// Manual jest mock for '@anthropic-ai/claude-agent-sdk'.
//
// The real package is ESM-only (package.json "type":"module", main "sdk.mjs").
// Node's runtime `require()` can load it natively (Node >= 22), which is how the
// built app runs it in production — but Jest's own module registry does not
// support that interop, so any test that transitively imports a file with
// `import { query } from '@anthropic-ai/claude-agent-sdk'` (e.g. misc.service.ts,
// pulled in by chat-tools.ts) fails with "Cannot use import statement outside a
// module" while trying to parse the real .mjs file.
//
// No existing unit test actually exercises the Claude Agent SDK itself (that
// requires live network/OAuth credentials and is covered by e2e/smoke instead),
// so a inert stub here is safe: it only needs to satisfy static imports.
module.exports = {
  query: () => {
    throw new Error('claude-agent-sdk is mocked in jest unit tests — do not call query() from a unit test');
  },
  tool: (_name, _desc, _schema, handler) => ({ name: _name, description: _desc, schema: _schema, handler }),
  createSdkMcpServer: (config) => config,
};
