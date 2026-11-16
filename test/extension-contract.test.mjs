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

test("AMD catalog models carry non-zero catalog prices", () => {
  const match = source.match(/const AMD_MODELS = \[([\s\S]*?)\n\];/);
  assert.ok(match, "expected AMD model catalog");
  const costs = [...match[1].matchAll(/cost:\s*\{\s*input:\s*([\d.]+),\s*output:\s*([\d.]+)/g)];
  assert.equal(costs.length, 4, "expected the four currently priced AMD catalog entries");
  for (const [, input, output] of costs) {
    assert.ok(Number(input) > 0 && Number(output) > 0, "AMD catalog prices should not be zero");
  }
});

test("Agnes Image 2.5 Flash is not listed without verified pricing", () => {
  assert.doesNotMatch(source, /id:\s*["']agnes-image-2\.5-flash["']/);
});

test("extension passes Node syntax validation", () => {
  execFileSync(process.execPath, ["--check", filePath(extensionPath)], { stdio: "pipe" });
});

function filePath(url) {
  return fileURLToPath(url);
}
