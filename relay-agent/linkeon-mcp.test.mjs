// node --test relay-agent/linkeon-mcp.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { LINKEON_TOOLS, linkeonServer } from "./linkeon-mcp.mjs";

const URL_OK = "https://my.linkeon.io/webhook/mcp/linkeon";

test("без токена хода сервера linkeon нет", () => {
  assert.equal(linkeonServer({}), null);
  assert.equal(linkeonServer(undefined), null);
  assert.equal(linkeonServer({ linkeon_mcp_url: URL_OK }), null);
  assert.equal(linkeonServer({ linkeon_token: "", linkeon_mcp_url: URL_OK }), null);
});

test("адрес — только https", () => {
  assert.equal(linkeonServer({ linkeon_token: "t", linkeon_mcp_url: "http://my.linkeon.io/webhook/mcp/linkeon" }), null);
  assert.equal(linkeonServer({ linkeon_token: "t" }), null);
});

test("токен с переводом строки не принимается", () => {
  assert.equal(linkeonServer({ linkeon_token: "t\r\nX: 1", linkeon_mcp_url: URL_OK }), null);
});

test("повторённое поле multipart (массив) не принимается", () => {
  assert.equal(linkeonServer({ linkeon_token: ["a", "b"], linkeon_mcp_url: URL_OK }), null);
});

test("с токеном — http-сервер с Bearer токена хода", () => {
  assert.deepEqual(linkeonServer({ linkeon_token: "tkn", linkeon_mcp_url: URL_OK }), {
    type: "http",
    url: URL_OK,
    headers: { Authorization: "Bearer tkn" },
  });
});

test("LINKEON_TOOLS — 11 имён mcp__linkeon__* через запятую", () => {
  const names = LINKEON_TOOLS.split(",");
  assert.equal(names.length, 11);
  for (const n of names) assert.match(n, /^mcp__linkeon__[a-z_]+$/);
});
