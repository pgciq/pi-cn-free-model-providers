import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const extensionPath = new URL("../pi-cn-free-model-providers-ext.mjs", import.meta.url);
const source = readFileSync(extensionPath, "utf8");

// This is a regression test for the 1.0.25 crash. Pi's extension API is
// registerProvider(providerId, config); the native API is a different API.
test("registers providers through the extension API", () => {
  assert.match(source, /pi\.registerProvider\(id,\s*\{/);
  assert.doesNotMatch(source, /pi\.registerProvider\(provider\s*\)/);
  assert.match(source, /api:\s*["']openai-completions["']/);
  assert.match(source, /models:\s*config\.models\s*\?\?\s*\[\]/);
});

test("all curated model entries have selector-safe id and name", () => {
  const modelArrays = [...source.matchAll(/const\s+[A-Z_]+_MODELS\s*=\s*\[([\s\S]*?)\];/g)];
  assert.ok(modelArrays.length >= 8, "expected the curated provider model arrays");
  for (const [, body] of modelArrays) {
    for (const block of body.split(/\n\s*\},\s*\n/)) {
      if (!/\bid\s*:/.test(block)) continue;
      assert.match(block, /\bid\s*:\s*["'`][^"'`]+["'`]/);
      assert.match(block, /\bname\s*:\s*["'`][^"'`]+["'`]/);
    }
  }
});

test("extension passes Node syntax validation", () => {
  execFileSync(process.execPath, ["--check", filePath(extensionPath)], { stdio: "pipe" });
});

function filePath(url) {
  return fileURLToPath(url);
}
