// node --test relay-agent/linkeon-mcp.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { LINKEON_TOOLS, linkeonServer, bearerServer, isHttpsUrl } from "./linkeon-mcp.mjs";

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

// Ревью 26.10.2026: та же проверка годится для talerid/products в server.mjs —
// повторённое multipart-поле (массив) не должно пройти как валидный URL.
test("isHttpsUrl: массив (повторённое multipart-поле) — не URL, даже если toString() похож на https", () => {
  assert.equal(isHttpsUrl(["https://a", "https://b"]), false);
  assert.equal(isHttpsUrl([]), false);
});

test("isHttpsUrl: строка https — да; http и не-строка — нет", () => {
  assert.equal(isHttpsUrl(URL_OK), true);
  assert.equal(isHttpsUrl("http://x"), false);
  assert.equal(isHttpsUrl(undefined), false);
  assert.equal(isHttpsUrl(123), false);
  assert.equal(isHttpsUrl(null), false);
});

test("LINKEON_TOOLS — 11 имён mcp__linkeon__* через запятую", () => {
  const names = LINKEON_TOOLS.split(",");
  assert.equal(names.length, 11);
  for (const n of names) assert.match(n, /^mcp__linkeon__[a-z_]+$/);
});

// Та же проверка для talerid и products (server.mjs): токен и адрес из
// multipart как есть.
test("bearerServer: токен — непустая строка без перевода строки, адрес — https", () => {
  const ok = { type: "http", url: URL_OK, headers: { Authorization: "Bearer t" } };
  assert.deepEqual(bearerServer("t", URL_OK), ok);
  for (const t of [undefined, "", ["a", "b"], 5, "t\r\nX: 1", "t\nX"]) {
    assert.equal(bearerServer(t, URL_OK), null, "токен " + JSON.stringify(t));
  }
  for (const u of [undefined, "http://x", [URL_OK, URL_OK]]) {
    assert.equal(bearerServer("t", u), null, "адрес " + JSON.stringify(u));
  }
});
