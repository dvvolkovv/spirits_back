// node --test relay-agent/agent-test-mode.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { agentTestMode, cliToolArgs } from "./agent-test-mode.mjs";

const BASE_TOOLS = "Bash(*),Read(*),Write(*),Edit(*),Glob(*),Grep(*),WebSearch(*),WebFetch(*)";

test("default relay CLI args preserve the existing built-in tools", () => {
  assert.equal(agentTestMode({}), false);
  assert.deepEqual(cliToolArgs(false, BASE_TOOLS), ["--allowedTools", BASE_TOOLS]);
});

test("agent test mode disables every built-in tool in the actual CLI arg builder", () => {
  assert.equal(agentTestMode({ testMode: "true" }), true);
  const args = cliToolArgs(true, BASE_TOOLS);
  assert.deepEqual(args, ["--allowedTools", "", "--tools", ""]);
  for (const tool of ["Bash", "Write", "Edit", "Read", "WebFetch"]) {
    assert.equal(args.join(" ").includes(tool), false);
  }
});

test("only the explicit multipart flag enables test mode", () => {
  assert.equal(agentTestMode({ testMode: "false" }), false);
  assert.equal(agentTestMode({ testMode: "" }), false);
  assert.equal(agentTestMode({ testMode: "1" }), false);
});
