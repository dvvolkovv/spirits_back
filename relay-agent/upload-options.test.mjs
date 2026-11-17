// Имена файлов хода, принятых multer'ом на POST /chat (upload-options.mjs).
//
// Живая проверка 17.11.2026: бэк прислал «смета.txt» и «отчет.txt», а модель
// увидела латинскую мешанину и сказала человеку, что у файлов битые имена.
// busboy по умолчанию читает filename как latin1; бэк (form-data) и браузеры
// шлют его в UTF-8. Тест гоняет настоящий multipart-запрос через multer.
//
// Нужен multer 2.x из node_modules самого relay-agent: в 1.x (его тянет бэк,
// @nestjs/platform-express) настройки defParamCharset нет. В клоне без своих
// node_modules у relay-agent импорт уходит в корневой multer 1.x, и тесты имён
// краснеют не из-за кода — об этом говорит первый тест.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import multer from "multer";
import { createRequire } from "node:module";
import { uploadOptions } from "./upload-options.mjs";

function multerVersion() {
  // Корень пакета — каталог его main (index.js), выше по дереву не ходим.
  const dir = path.dirname(createRequire(import.meta.url).resolve("multer"));
  return JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")).version;
}

test("multer — 2.x: в 1.x нет defParamCharset", () => {
  const v = multerVersion();
  assert.ok(
    Number(v.split(".")[0]) >= 2,
    `подхватился multer ${v}: у relay-agent нет своих node_modules? Поставьте их (npm ci в relay-agent)`,
  );
});

async function namesAfterUpload(names) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-upload-names-"));
  const app = express();
  app.post("/chat", multer(uploadOptions(dir)).array("files", 10), (req, res) => {
    res.json(req.files.map((f) => f.originalname));
  });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  try {
    const fd = new FormData();
    for (const name of names) fd.append("files", new Blob(["x"], { type: "text/plain" }), name);
    const r = await fetch(`http://127.0.0.1:${server.address().port}/chat`, { method: "POST", body: fd });
    assert.equal(r.status, 200);
    return await r.json();
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("кириллические имена доезжают до хода целыми", async () => {
  assert.deepEqual(await namesAfterUpload(["смета.txt", "отчет.txt"]), ["смета.txt", "отчет.txt"]);
});

test("латиница, умлауты и типографика не портятся", async () => {
  const names = ["report.pdf", "Straße.pdf", "Договор №5 «итог» — копия.docx"];
  assert.deepEqual(await namesAfterUpload(names), names);
});

test("потолок размера файла прежний — 500 МБ", () => {
  assert.equal(uploadOptions("/tmp/x").limits.fileSize, 500 * 1024 * 1024);
});
