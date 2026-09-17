// Offline integration tests for the OpenCode Zen auto-discovery path.
// The upstream gateway is not reachable from this sandbox, so `fetch` is
// stubbed with a scripted gateway and the extension is loaded exactly as pi
// loads it (default export called with a `pi` object).
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MODULE = new URL("../opencode-native.js", import.meta.url).href;
let loadCount = 0;

// ── scripted gateway ───────────────────────────────────────────────────────
const ZEN_LISTING = [
  // curated + priced free by the listing → no probe needed
  { id: "mimo-v2.5-free", name: "MiMo V2.5 upstream", cost: { input: 0, output: 0 }, limit: { context: 200000, output: 128000 } },
  // unknown model, rich metadata → auto-registered with derived params
  {
    id: "aurora-vision-free",
    name: "Aurora Vision",
    cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
    limit: { context: 262144, output: 400000 },
    modalities: { input: ["text", "image"] },
    reasoning: true,
    tool_call: true,
  },
  // "-free" in the id but the listing prices it → probe → 402 → dropped
  { id: "pricey-free", name: "Not actually free", cost: { input: 1.25, output: 5 }, limit: { context: 1000000, output: 64000 } },
  // no metadata at all → probe → free → conservative fallbacks
  { id: "mystery-model", name: "Mystery" },
  // probe fails (500) and not curated → skipped, never auto-added
  { id: "flaky-model", name: "Flaky" },
  // curated, probe fails → kept (an outage must not wipe hand-verified models)
  { id: "big-pickle", name: "Big Pickle upstream" },
  // small model: derived limits must be clamped, tools disabled
  { id: "tiny-free", cost: { input: 0, output: 0 }, context_length: 8192, max_tokens: 8192, features: ["reasoning"], tool_call: false },
];

const PROBE_RESULT = {
  "pricey-free": 402,
  "mystery-model": 200,
  "flaky-model": 500,
  "big-pickle": 500,
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function sse(chunks) {
  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function installFetch({ zenListFails = false } = {}) {
  const calls = { zenList: 0, probes: [], chats: [], probeHeaders: [] };
  globalThis.fetch = async (url, init = {}) => {
    const target = String(url);
    if (target === "https://opencode.ai/zen/v1/models") {
      calls.zenList++;
      if (zenListFails) throw new TypeError("fetch failed");
      return json({ data: ZEN_LISTING });
    }
    // every other provider's catalog: unauthenticated -> curated list is kept
    if (target.endsWith("/models")) return new Response("", { status: 401 });
    if (target === "https://opencode.ai/zen/v1/chat/completions") {
      const body = JSON.parse(init.body);
      if (body.max_tokens === 1 && !body.stream) {
        calls.probes.push(body.model);
        calls.probeHeaders.push(init.headers);
        const status = PROBE_RESULT[body.model] ?? 500;
        return status === 200 ? json({ id: "x", cost: 0, choices: [] }) : new Response("nope", { status });
      }
      calls.chats.push(body);
      return sse([
        'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n',
        "data: [DONE]\n",
      ]);
    }
    throw new Error(`unexpected fetch: ${target}`);
  };
  return calls;
}

// ── pi double ──────────────────────────────────────────────────────────────
function makePi() {
  const pi = {
    providers: new Map(),
    commands: new Map(),
    renderers: new Map(),
    entries: [],
    zenRegistrations: 0,
    registerProvider(id, cfg) {
      pi.providers.set(id, cfg);
      if (id === "opencode-zen") pi.zenRegistrations++;
    },
    registerCommand(name, cfg) { pi.commands.set(name, cfg); },
    registerEntryRenderer(key, fn) { pi.renderers.set(key, fn); },
    appendEntry(key, data) { pi.entries.push({ key, data }); },
    on() {},
  };
  return pi;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 4000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await sleep(10);
  }
  return false;
}

async function boot(options = {}) {
  const calls = installFetch(options);
  const pi = makePi();
  const { default: register } = await import(`${MODULE}?load=${++loadCount}`);
  register(pi);
  return { pi, calls };
}

function zenIds(pi) {
  return pi.providers.get("opencode-zen").models.map((m) => m.id).sort();
}
function zenModel(pi, id) {
  return pi.providers.get("opencode-zen").models.find((m) => m.id === id);
}

// ── scenarios ──────────────────────────────────────────────────────────────
const home = mkdtempSync(join(tmpdir(), "pi-home-"));
process.env.HOME = home;
delete process.env.OPENCODE_API_KEY;
const catalogCache = join(home, ".pi", "cache", "opencode-native-models.json");
const probeCache = join(home, ".pi", "cache", "opencode-zen-probes.json");
const results = [];
function check(name, fn) {
  try { fn(); results.push(`  PASS  ${name}`); }
  catch (error) { results.push(`  FAIL  ${name}\n        ${error.message}`); process.exitCode = 1; }
}

// ── 1. cold start: discovery, classification, parameter derivation ──
{
  const { pi, calls } = await boot();
  check("1.0 启动时先注册 curated 列表（不阻塞网络）", () => {
    assert.equal(pi.zenRegistrations, 1);
    assert.deepEqual(zenIds(pi), ["big-pickle", "mimo-v2.5-free", "nemotron-3-ultra-free", "nemotron-3.5-lightning-free"]);
  });
  assert.ok(await waitFor(() => pi.zenRegistrations >= 2), "background discovery did not re-register");
  await sleep(50);

  check("1.1 只注册免费模型（付费 / 探测失败的新模型被丢弃）", () => {
    assert.deepEqual(zenIds(pi), ["aurora-vision-free", "big-pickle", "mimo-v2.5-free", "mystery-model", "tiny-free"]);
  });
  check("1.2 listing 标价为 0 的模型跳过探测，只探测未知定价的模型", () => {
    assert.deepEqual([...calls.probes].sort(), ["big-pickle", "flaky-model", "mystery-model", "pricey-free"]);
    assert.equal(calls.zenList, 1);
  });
  check("1.3 探测请求带 OpenCode 原生头", () => {
    const headers = calls.probeHeaders[0];
    assert.equal(headers["x-opencode-client"], "cli");
    assert.match(headers["x-opencode-session"], /^ses_/);
    assert.match(headers["x-opencode-request"], /^msg_/);
  });
  check("1.4 新模型参数来自 /v1/models（context / 模态 / reasoning / tools）", () => {
    const m = zenModel(pi, "aurora-vision-free");
    assert.equal(m.opencodeDiscovered, true);
    assert.equal(m.name, "Aurora Vision");
    assert.equal(m.contextWindow, 262144);
    assert.deepEqual(m.input, ["text", "image"]);
    assert.equal(m.capabilities.vision, true);
    assert.equal(m.capabilities.tools, true);
    assert.equal(m.capabilities.reasoning, true);
    assert.equal(m.opencodeParamSource.contextWindow, "live");
  });
  check("1.5 max_tokens 被钳制在 context 的一半以内", () => {
    assert.equal(zenModel(pi, "aurora-vision-free").maxTokens, 131072); // listing 声称 400000
    assert.equal(zenModel(pi, "tiny-free").maxTokens, 4096);            // listing 声称 8192 / ctx 8192
    assert.equal(zenModel(pi, "tiny-free").contextWindow, 8192);
  });
  check("1.6 listing 声明不支持工具调用时关闭 tools", () => {
    assert.equal(zenModel(pi, "tiny-free").capabilities.tools, false);
    assert.equal(zenModel(pi, "tiny-free").capabilities.reasoning, true);
  });
  check("1.7 无任何元数据时使用保守回退值", () => {
    const m = zenModel(pi, "mystery-model");
    assert.equal(m.contextWindow, 131072);
    assert.equal(m.maxTokens, 32768);
    assert.deepEqual(m.input, ["text"]);
    assert.equal(m.opencodeParamSource.contextWindow, "fallback");
  });
  check("1.8 curated 模型保留人工核验参数，并挂上 live 元数据", () => {
    const m = zenModel(pi, "mimo-v2.5-free");
    assert.equal(m.maxTokens, 128000);       // 未被钳制
    assert.equal(m.contextWindow, 200000);
    assert.equal(m.name, "MiMo-V2.5 Free");  // curated 名称优先
    assert.equal(m.opencodeLiveModel.name, "MiMo V2.5 upstream");
    assert.equal(m.opencodeDiscovered, undefined);
  });
  check("1.9 其它 provider 未受影响（401 时保留 curated）", () => {
    assert.equal(pi.providers.get("siliconflow").models.length, 9);
    assert.equal(pi.providers.get("cloudflare").models.length, 13);
  });
  check("1.10 磁盘缓存已写入（目录缓存 + 探测缓存）", () => {
    assert.ok(existsSync(catalogCache));
    assert.ok(existsSync(probeCache));
  });

  // 每个模型按自己的 maxTokens 发请求，并遵守 tools 能力
  const provider = pi.providers.get("opencode-zen");
  const tiny = zenModel(pi, "tiny-free");
  await provider.streamSimple(tiny, { messages: [{ role: "user", content: "hi" }], tools: [{ name: "bash", parameters: {} }] }, {}).result();
  const aurora = zenModel(pi, "aurora-vision-free");
  await provider.streamSimple(aurora, { messages: [{ role: "user", content: "hi" }], tools: [{ name: "bash", parameters: {} }] }, {}).result();
  check("1.11 请求体 max_tokens 使用模型自身上限（旧版固定 128000）", () => {
    assert.equal(calls.chats[0].model, "tiny-free");
    assert.equal(calls.chats[0].max_tokens, 4096);
    assert.equal(calls.chats[1].max_tokens, 131072);
  });
  check("1.12 不支持工具的模型不会被塞 tools 字段", () => {
    assert.equal(calls.chats[0].tools, undefined);
    assert.equal(calls.chats[1].tools.length, 1);
  });

  // /zen-models 命令
  const ctx = { mode: "tui", modelRegistry: { getAvailable: () => provider.models.map((m) => ({ ...m, provider: "opencode-zen" })) } };
  await pi.commands.get("zen-models").handler("", ctx);
  check("1.13 /zen-models 输出参数来源表", () => {
    const md = pi.entries.at(-1).data.markdown;
    assert.match(md, /aurora-vision-free \| auto/);
    assert.match(md, /mimo-v2.5-free \| curated/);
    assert.match(md, /ctx:live/);
    assert.match(md, /ctx:默认/);
  });
  check("1.14 注册了 /zen-refresh 命令", () => {
    assert.ok(pi.commands.has("zen-refresh"));
  });
}

// ── 2. 目录缓存新鲜：零网络请求，直接用缓存目录 ──
{
  const { pi, calls } = await boot();
  await sleep(300);
  check("2.1 24h 缓存命中时不发任何网络请求", () => {
    assert.equal(calls.zenList, 0);
    assert.equal(calls.probes.length, 0);
  });
  check("2.2 缓存中的自动发现模型被直接注册", () => {
    assert.deepEqual(zenIds(pi), ["aurora-vision-free", "big-pickle", "mimo-v2.5-free", "mystery-model", "tiny-free"]);
    assert.equal(zenModel(pi, "aurora-vision-free").maxTokens, 131072);
  });
}

// ── 3. 目录缓存过期但探测缓存仍在：只重探测未决模型 ──
{
  rmSync(catalogCache);
  const { pi, calls } = await boot();
  assert.ok(await waitFor(() => pi.zenRegistrations >= 2), "second discovery pass did not run");
  await sleep(50);
  check("3.1 已判定的 free/paid 模型 7 天内不再重复探测", () => {
    assert.deepEqual([...calls.probes].sort(), ["big-pickle", "flaky-model"]);
  });
  check("3.2 结果与首次发现一致", () => {
    assert.deepEqual(zenIds(pi), ["aurora-vision-free", "big-pickle", "mimo-v2.5-free", "mystery-model", "tiny-free"]);
  });
}

// ── 4. 网络故障：退回 curated，不清空 provider ──
{
  const freshHome = mkdtempSync(join(tmpdir(), "pi-home-"));
  process.env.HOME = freshHome;
  const { pi, calls } = await boot({ zenListFails: true });
  await sleep(400);
  check("4.1 /v1/models 不可达时保留 curated 列表", () => {
    assert.deepEqual(zenIds(pi), ["big-pickle", "mimo-v2.5-free", "nemotron-3-ultra-free", "nemotron-3.5-lightning-free"]);
    assert.equal(calls.probes.length, 0);
    assert.equal(zenModel(pi, "mimo-v2.5-free").maxTokens, 128000);
  });
  rmSync(freshHome, { recursive: true, force: true });
}

rmSync(home, { recursive: true, force: true });
console.log(results.join("\n"));
console.log(process.exitCode ? "\n结果: 存在失败用例" : `\n结果: 全部 ${results.length} 项通过`);
