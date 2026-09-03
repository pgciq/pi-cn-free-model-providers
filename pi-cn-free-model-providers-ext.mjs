// OpenCode Zen native streamSimple for pi — zero pi-ai dependency.
// Fixes pi's 429 on free models by sending OpenCode-native headers
// (x-opencode-client: cli + ses_/msg_ ULID ids) and converting
// developer->system roles (upstream only accepts system/user/assistant).
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Image, Markdown } from "@earendil-works/pi-tui";

// ── Clickable file links ──────────────────────────────────────────────────
// The TUI renders assistant text as Markdown and turns a `[label](url)` link
// into a clickable OSC 8 hyperlink (supported by Windows Terminal, WezTerm,
// iTerm2, Kitty, etc.). Convert absolute paths to Markdown links so generated
// media opens in one click instead of copy-pasting the raw path.
function fileLink(p, label = p) {
  return `[${label}](${pathToFileURL(String(p)).href})`;
}

// ── Push-based stream (copied from pi-free lib/assistant-message-event-stream.js) ──
class EventStream {
  queue = [];
  waiting = [];
  done = false;
  constructor(isComplete, extractResult) {
    this.isComplete = isComplete;
    this.extractResult = extractResult;
    this.finalResultPromise = new Promise((resolve) => {
      this.resolveFinalResult = resolve;
    });
  }
  push(event) {
    if (this.done) return;
    if (this.isComplete(event)) {
      this.done = true;
      this.resolveFinalResult(this.extractResult(event));
    }
    const waiter = this.waiting.shift();
    if (waiter) waiter({ value: event, done: false });
    else this.queue.push(event);
  }
  end(result) {
    this.done = true;
    if (result !== undefined) this.resolveFinalResult(result);
    while (this.waiting.length > 0) {
      const waiter = this.waiting.shift();
      waiter?.({ value: undefined, done: true });
    }
  }
  async *[Symbol.asyncIterator]() {
    while (true) {
      if (this.queue.length > 0) yield this.queue.shift();
      else if (this.done) return;
      else {
        const result = await new Promise((resolve) => this.waiting.push(resolve));
        if (result.done) return;
        yield result.value;
      }
    }
  }
  result() {
    return this.finalResultPromise;
  }
}
class AssistantMessageEventStream extends EventStream {
  constructor() {
    super(
      (event) => event.type === "done" || event.type === "error",
      (event) => {
        if (event.type === "done") return event.message;
        if (event.type === "error") return event.error;
        throw new Error("Unexpected event type for final result");
      }
    );
  }
}

// ── OpenCode-native ID generation (ULID-style, same as pi-free) ──
const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
function generateOpenCodeId(prefix) {
  const ms = BigInt(Date.now());
  const timeHex = ms.toString(16).padStart(12, "0");
  const bytes = randomBytes(14);
  let suffix = "";
  for (let i = 0; i < 14; i++) suffix += BASE62[bytes[i] % 62];
  return `${prefix}${timeHex}${suffix}`;
}
const SESSION_ID = generateOpenCodeId("ses_");
const OPENCODE_STATIC_HEADERS = {
  "User-Agent": "opencode/1.15.5",
  "x-opencode-client": "cli",
};

// ── Message / tool normalization ──
function getContentText(msg) {
  if (typeof msg.content === "string") return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content
      .map((c) => {
        if (c.type === "text") return c.text;
        if (c.type === "thinking") return c.thinking;
        return "";
      })
      .join("");
  }
  return "";
}
function normalizeMessages(messages) {
  const out = [];
  for (const m of messages ?? []) {
    if (!m || typeof m !== "object") continue;
    // Skip failed assistant turns
    if (m.role === "assistant" && (m.stopReason === "error" || m.stopReason === "aborted")) continue;
    if (m.role === "developer") {
      out.push({ role: "system", content: getContentText(m) });
    } else if (m.role === "user") {
      let content;
      if (typeof m.content === "string") {
        content = m.content;
      } else if (Array.isArray(m.content)) {
        const hasImage = m.content.some((c) => c.type === "image");
        if (hasImage) {
          content = m.content
            .map((c) => {
              if (c.type === "text") return { type: "text", text: c.text };
              if (c.type === "image") return { type: "image_url", image_url: { url: `data:${c.mimeType};base64,${c.data}` } };
              return null;
            })
            .filter((p) => p !== null);
        } else {
          content = getContentText(m);
        }
      } else {
        content = "";
      }
      out.push({ role: "user", content });
    } else if (m.role === "assistant") {
      let content = "";
      let reasoningContent = "";
      const toolCalls = [];
      if (Array.isArray(m.content)) {
        for (const block of m.content) {
          if (block.type === "text") content += block.text;
          // Replay reasoning instead of dropping it: DeepSeek V4 thinking mode
          // requires `reasoning_content` echoed back on assistant messages in
          // history (mandatory on tool-call turns), or the API returns 400.
          // The zen gateway forwards the top-level field upstream.
          else if (block.type === "thinking") reasoningContent += block.thinking ?? "";
          else if (block.type === "toolCall") {
            toolCalls.push({
              id: block.id,
              type: "function",
              function: {
                name: block.name,
                arguments: typeof block.arguments === "string" ? block.arguments : JSON.stringify(block.arguments),
              },
            });
          }
        }
      } else {
        content = m.content || "";
      }
      const mapped = { role: "assistant", content: content || null };
      // Echo reasoning_content back on every assistant message (empty string
      // is still required for tool-call turns — DeepSeek rejects omission).
      if (reasoningContent !== "" || toolCalls.length > 0) mapped.reasoning_content = reasoningContent;
      if (toolCalls.length > 0) mapped.tool_calls = toolCalls;
      out.push(mapped);
    } else if (m.role === "toolResult") {
      out.push({ role: "tool", tool_call_id: m.toolCallId, content: getContentText(m) });
    }
    // drop anything else
  }
  return out;
}

// ── Tool normalization (pi internal -> OpenAI wire format) ──
function normalizeTools(tools) {
  if (!Array.isArray(tools)) return undefined;
  const mapped = tools
    .map((t) => {
      if (!t || typeof t !== "object") return null;
      // Already in wire format
      if (t.type === "function" && t.function?.name) return t;
      // pi internal format: { name, description, parameters }
      if (t.name) {
        return { type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } };
      }
      return null;
    })
    .filter(Boolean);
  return mapped.length > 0 ? mapped : undefined;
}

// ── SSE parsing ──
function processDelta(state, delta) {
  if (delta.reasoning_content) {
    if (state.thinkingBlockIndex === -1) {
      state.thinkingBlockIndex = state.output.content.length;
      state.output.content.push({ type: "thinking", thinking: "" });
      state.stream.push({ type: "thinking_start", contentIndex: state.thinkingBlockIndex, partial: state.output });
    }
    const block = state.output.content[state.thinkingBlockIndex];
    block.thinking += delta.reasoning_content;
    state.stream.push({ type: "thinking_delta", contentIndex: state.thinkingBlockIndex, delta: delta.reasoning_content, partial: state.output });
  }
  if (delta.content) {
    if (state.thinkingBlockIndex !== -1) {
      state.stream.push({ type: "thinking_end", contentIndex: state.thinkingBlockIndex, content: state.output.content[state.thinkingBlockIndex].thinking, partial: state.output });
      state.thinkingBlockIndex = -1;
    }
    if (state.contentBlockIndex === -1) {
      state.contentBlockIndex = state.output.content.length;
      state.output.content.push({ type: "text", text: "" });
      state.stream.push({ type: "text_start", contentIndex: state.contentBlockIndex, partial: state.output });
    }
    const block = state.output.content[state.contentBlockIndex];
    block.text += delta.content;
    state.stream.push({ type: "text_delta", contentIndex: state.contentBlockIndex, delta: delta.content, partial: state.output });
  }
  if (delta.tool_calls && Array.isArray(delta.tool_calls)) {
    for (const tc of delta.tool_calls) {
      const idx = tc.index ?? 0;
      if (!state.toolCallsState[idx]) state.toolCallsState[idx] = { arguments: "", id: "", name: "", contentIndex: 0, emittedStart: false };
      const t = state.toolCallsState[idx];
      if (tc.id) t.id = tc.id;
      if (tc.function?.name) t.name = tc.function.name;
      if (tc.function?.arguments) {
        t.arguments += tc.function.arguments;
        if (!t.emittedStart) {
          t.emittedStart = true;
          t.contentIndex = state.output.content.length;
          state.output.content.push({ type: "toolCall", id: t.id, name: t.name, arguments: {} });
          state.stream.push({ type: "toolcall_start", contentIndex: t.contentIndex, partial: state.output });
        }
        state.stream.push({ type: "toolcall_delta", contentIndex: t.contentIndex, delta: tc.function.arguments, partial: state.output });
      }
    }
  }
}
function finalizeToolCalls(state) {
  for (const t of state.toolCallsState) {
    if (t?.emittedStart) {
      let args = {};
      try { args = JSON.parse(t.arguments || "{}"); } catch {}
      state.output.content[t.contentIndex].arguments = args;
      state.stream.push({
        type: "toolcall_end",
        contentIndex: t.contentIndex,
        toolCall: { type: "toolCall", id: t.id, name: t.name, arguments: args },
        partial: state.output,
      });
    }
  }
}
function handleSSELine(state, line) {
  if (!line.startsWith("data:")) return false;
  const dataStr = line.slice(5).trim();
  if (dataStr === "[DONE]") return true;
  let parsed;
  try { parsed = JSON.parse(dataStr); } catch { return false; }
  if (parsed.error) throw new Error(`OpenCode SSE error: ${parsed.error.message || JSON.stringify(parsed.error)}`);
  if (parsed.usage) {
    const input = parsed.usage.prompt_tokens ?? 0;
    const output = parsed.usage.completion_tokens ?? 0;
    state.output.usage = {
      input,
      output,
      cacheRead: parsed.usage.prompt_tokens_details?.cached_tokens ?? 0,
      cacheWrite: 0,
      totalTokens: parsed.usage.total_tokens ?? input + output,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
  }
  if (parsed.choices && Array.isArray(parsed.choices) && parsed.choices.length > 0) {
    const choice = parsed.choices[0];
    if (choice.delta) processDelta(state, choice.delta);
    if (choice.finish_reason) state.output.stopReason = choice.finish_reason;
  }
  return false;
}
async function consumeSSEStream(state, reader) {
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    while (true) {
      const lineEnd = buffer.indexOf("\n");
      if (lineEnd === -1) break;
      const line = buffer.substring(0, lineEnd).trim();
      buffer = buffer.substring(lineEnd + 1);
      const done2 = handleSSELine(state, line);
      if (done2) break;
    }
  }
}

// ── Shared output factory ──
function makeOutput(model) {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

// ── Verified image-generation models ---------------------------------------
// Agnes and SenseNova expose OpenAI-compatible image-generation endpoints.
// Keep this separate from the generic chat stream: their image responses are
// not chat-completion SSE messages and need to be saved/echoed explicitly.
let appendNativeImage = null;

function latestImageRequest(context) {
  const messages = Array.isArray(context?.messages) ? context.messages : [];
  const user = [...messages].reverse().find((message) => message?.role === "user");
  if (!user) return { prompt: "", images: [] };
  if (typeof user.content === "string") return { prompt: user.content, images: [] };
  const parts = Array.isArray(user.content) ? user.content : [];
  return {
    prompt: parts.filter((part) => part?.type === "text").map((part) => part.text ?? "").join("\n"),
    images: parts.filter((part) => part?.type === "image"),
  };
}

function latestAudioRequest(context) {
  const messages = Array.isArray(context?.messages) ? context.messages : [];
  const user = [...messages].reverse().find((message) => message?.role === "user");
  if (!user || typeof user.content === "string") return { audios: [] };
  const parts = Array.isArray(user.content) ? user.content : [];
  const audios = parts
    .filter((part) => part?.type === "audio" || (part?.mimeType ?? "").startsWith("audio/"))
    .map((part) => ({
      data: part?.data ?? part?.audio_url?.url ?? part?.audioUrl ?? "",
      mimeType: part?.mimeType ?? "audio/wav",
    }))
    .filter((audio) => audio.data);
  return { audios };
}

async function saveNativeImage(image, modelId) {
  const directory = join(process.cwd(), ".pi", "generated-images");
  if (!existsSync(directory)) mkdirSync(directory, { recursive: true });
  const mimeType = image?.mime_type ?? image?.mimeType ?? "image/png";
  const extension = mimeType.includes("jpeg") ? "jpg" : mimeType.includes("webp") ? "webp" : "png";
  const safeModelId = String(modelId).replaceAll("/", "_");
  const path = join(directory, `opencode-${safeModelId}-${Date.now()}.${extension}`);
  if (image?.b64_json) {
    writeFileSync(path, Buffer.from(image.b64_json, "base64"));
  } else if (image?.url) {
    const response = await fetch(image.url);
    if (!response.ok) throw new Error(`Unable to download generated image: HTTP ${response.status}`);
    writeFileSync(path, Buffer.from(await response.arrayBuffer()));
  } else {
    throw new Error("Image API returned neither url nor b64_json");
  }
  return { path, mimeType };
}

async function saveNativeAudio(bytes, modelId, extension = "mp3") {
  const directory = join(process.cwd(), ".pi", "generated-audio");
  if (!existsSync(directory)) mkdirSync(directory, { recursive: true });
  const path = join(directory, `opencode-${modelId.replaceAll("/", "_")}-${Date.now()}.${extension}`);
  writeFileSync(path, Buffer.from(bytes));
  return path;
}

function streamNativeAudio(model, context, options) {
  const stream = new AssistantMessageEventStream();
  const output = makeOutput(model);
  (async () => {
    try {
      stream.push({ type: "start", partial: output });
      const prompt = latestImageRequest(context).prompt;
      if (!prompt) throw new Error("TTS requires text input");
      const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
      const apiKey = process.env.CLOUDFLARE_API_KEY;
      if (!accountId || !apiKey) throw new Error("CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_KEY are required for TTS");
      const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${model.id}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ text: prompt }),
        signal: options?.signal,
      });
      if (!response.ok) throw new Error(`Cloudflare TTS HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
      const path = await saveNativeAudio(await response.arrayBuffer(), model.id, "mp3");
      const text = `Generated audio saved to: ${fileLink(path)}`;
      output.content.push({ type: "text", text });
      stream.push({ type: "text_start", contentIndex: 0, partial: output });
      stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: output });
      stream.push({ type: "text_end", contentIndex: 0, content: text, partial: output });
      output.stopReason = "stop";
      stream.push({ type: "done", reason: "stop", message: output });
      stream.end();
    } catch (error) {
      output.stopReason = options?.signal?.aborted ? "aborted" : "error";
      output.errorMessage = error instanceof Error ? error.message : String(error);
      stream.push({ type: "error", reason: "error", error: output });
      stream.end();
    }
  })();
  return stream;
}

async function saveNativeTranscript(text, modelId) {
  const directory = join(process.cwd(), ".pi", "generated-transcripts");
  if (!existsSync(directory)) mkdirSync(directory, { recursive: true });
  const path = join(directory, `opencode-${modelId.replaceAll("/", "_")}-${Date.now()}.txt`);
  writeFileSync(path, text, "utf-8");
  return path;
}

// Cloudflare Workers AI speech-to-text. Two verified transports:
//  • whisper (`@cf/openai/whisper`): POST JSON `{ audio: <0–255 byte array> }`;
//    a base64 string / object is rejected with HTTP 400. Response `{ result: { text } }`.
//  • Deepgram nova (`@cf/deepgram/nova-3`, flag opencodeAsrRawBody): POST the raw
//    audio bytes as the request body with `Content-Type: audio/*`. Response:
//    `{ result: { results: { channels: [{ alternatives: [{ transcript }] }] } } }`.
// Both decode the attached audio's base64 `data` before sending.
function streamNativeTranscription(model, context, options) {
  const stream = new AssistantMessageEventStream();
  const output = makeOutput(model);
  (async () => {
    try {
      stream.push({ type: "start", partial: output });
      const { audios } = latestAudioRequest(context);
      if (audios.length === 0) throw new Error("Transcription requires an audio input (attach an audio file)");
      const audio = audios[0];
      const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
      const apiKey = process.env.CLOUDFLARE_API_KEY;
      if (!accountId || !apiKey) throw new Error("CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_KEY are required for transcription");
      const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${model.id}`;
      let response;
      if (model.opencodeAsrRawBody) {
        // Deepgram nova: raw audio bytes as the body, with an audio/* Content-Type
        response = await fetch(url, {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": audio.mimeType || "audio/wav" },
          body: Buffer.from(audio.data, "base64"),
          signal: options?.signal,
        });
      } else {
        // whisper: { audio: <0–255 byte array> } as JSON
        let audioBytes;
        try {
          audioBytes = Array.from(Buffer.from(audio.data, "base64"));
        } catch {
          throw new Error("Failed to decode attached audio (expected base64)");
        }
        response = await fetch(url, {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({ audio: audioBytes }),
          signal: options?.signal,
        });
      }
      if (!response.ok) throw new Error(`Cloudflare transcription HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
      const payload = await response.json();
      const result = payload?.result ?? payload;
      const transcript =
        result?.text ??
        result?.transcript ??
        result?.results?.channels?.[0]?.alternatives?.[0]?.transcript ??
        payload?.text ??
        "";
      if (!transcript) throw new Error("Transcription returned no text");
      const path = await saveNativeTranscript(transcript, model.id);
      const text = `Transcription (${model.id}):\n\n${transcript}\n\nSaved transcript to: ${fileLink(path)}`;
      output.content.push({ type: "text", text });
      stream.push({ type: "text_start", contentIndex: 0, partial: output });
      stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: output });
      stream.push({ type: "text_end", contentIndex: 0, content: text, partial: output });
      output.stopReason = "stop";
      stream.push({ type: "done", reason: "stop", message: output });
      stream.end();
    } catch (error) {
      output.stopReason = options?.signal?.aborted ? "aborted" : "error";
      output.errorMessage = error instanceof Error ? error.message : String(error);
      stream.push({ type: "error", reason: "error", error: output });
      stream.end();
    }
  })();
  return stream;
}

// Generic OpenAI-compatible audio endpoints: POST `{baseUrl}/audio/speech` for
// TTS and `{baseUrl}/audio/transcriptions` (multipart) for ASR. Used by
// SiliconFlow and ModelScope. SiliconFlow's shape is verified; ModelScope's
// audio compatibility is unverified (no API key in this environment) and may
// need a different path / voice-reference params.
function streamOpenAITTS(model, context, options, baseUrl, envKey) {
  const stream = new AssistantMessageEventStream();
  const output = makeOutput(model);
  (async () => {
    try {
      stream.push({ type: "start", partial: output });
      const prompt = latestImageRequest(context).prompt;
      if (!prompt) throw new Error("TTS requires text input");
      const apiKey = process.env[envKey];
      if (!apiKey) throw new Error(`${envKey} is required for TTS`);
      const response = await fetch(`${baseUrl}/audio/speech`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: model.id, input: prompt, voice: model.opencodeVoice ?? "female", response_format: "mp3" }),
        signal: options?.signal,
      });
      if (!response.ok) throw new Error(`TTS HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      const path = await saveNativeAudio(bytes, model.id, "mp3");
      const text = `Speech generated (${model.id}):\n\nSaved audio to: ${fileLink(path)}`;
      output.content.push({ type: "text", text });
      stream.push({ type: "text_start", contentIndex: 0, partial: output });
      stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: output });
      stream.push({ type: "text_end", contentIndex: 0, content: text, partial: output });
      output.stopReason = "stop";
      stream.push({ type: "done", reason: "stop", message: output });
      stream.end();
    } catch (error) {
      output.stopReason = options?.signal?.aborted ? "aborted" : "error";
      output.errorMessage = error instanceof Error ? error.message : String(error);
      stream.push({ type: "error", reason: "error", error: output });
      stream.end();
    }
  })();
  return stream;
}

function streamOpenAIASR(model, context, options, baseUrl, envKey) {
  const stream = new AssistantMessageEventStream();
  const output = makeOutput(model);
  (async () => {
    try {
      stream.push({ type: "start", partial: output });
      const { audios } = latestAudioRequest(context);
      if (audios.length === 0) throw new Error("Transcription requires an audio input (attach an audio file)");
      const audio = audios[0];
      const apiKey = process.env[envKey];
      if (!apiKey) throw new Error(`${envKey} is required for transcription`);
      const fd = new FormData();
      fd.append("file", new Blob([Buffer.from(audio.data, "base64")], { type: audio.mimeType || "audio/wav" }), "audio");
      fd.append("model", model.id);
      const response = await fetch(`${baseUrl}/audio/transcriptions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}` },
        body: fd,
        signal: options?.signal,
      });
      if (!response.ok) throw new Error(`ASR HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
      const payload = await response.json().catch(() => null);
      const transcript = payload?.text ?? payload?.transcript ?? (typeof payload === "string" ? payload : "");
      if (!transcript) throw new Error("Transcription returned no text");
      const path = await saveNativeTranscript(transcript, model.id);
      const text = `Transcription (${model.id}):\n\n${transcript}\n\nSaved transcript to: ${fileLink(path)}`;
      output.content.push({ type: "text", text });
      stream.push({ type: "text_start", contentIndex: 0, partial: output });
      stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: output });
      stream.push({ type: "text_end", contentIndex: 0, content: text, partial: output });
      output.stopReason = "stop";
      stream.push({ type: "done", reason: "stop", message: output });
      stream.end();
    } catch (error) {
      output.stopReason = options?.signal?.aborted ? "aborted" : "error";
      output.errorMessage = error instanceof Error ? error.message : String(error);
      stream.push({ type: "error", reason: "error", error: output });
      stream.end();
    }
  })();
  return stream;
}

async function saveNativeVideo(url, modelId) {
  const directory = join(process.cwd(), ".pi", "generated-videos");
  if (!existsSync(directory)) mkdirSync(directory, { recursive: true });
  const path = join(directory, `opencode-${modelId}-${Date.now()}.mp4`);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Unable to download generated video: HTTP ${response.status}`);
  writeFileSync(path, Buffer.from(await response.arrayBuffer()));
  return path;
}

async function waitForNativeVideo(baseUrl, videoId, apiKey, signal) {
  const deadline = Date.now() + 30 * 60 * 1000;
  const apiRoot = baseUrl.replace(/\/v1\/?$/, "");
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error("Video generation aborted");
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, 5000);
      signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("Video generation aborted")); }, { once: true });
    });
    const response = await fetch(`${apiRoot}/agnesapi?video_id=${encodeURIComponent(videoId)}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal,
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload?.error?.message ?? `Video status HTTP ${response.status}`);
    if (payload.status === "completed") return payload;
    if (payload.status === "failed") throw new Error(payload?.error?.message ?? "Video generation failed");
  }
  throw new Error("Video generation timed out after 30 minutes");
}

function streamNativeVideo(model, context, options) {
  const stream = new AssistantMessageEventStream();
  const output = makeOutput(model);
  (async () => {
    try {
      stream.push({ type: "start", partial: output });
      const { prompt, images } = latestImageRequest(context);
      if (!prompt) throw new Error("Video generation requires a text prompt");
      if (model.opencodeVideoProvider === "siliconflow") {
        const baseUrl = "https://api.siliconflow.cn/v1";
        const apiKey = process.env.SILICONFLOW_API_KEY ?? "";
        if (!apiKey) throw new Error("SILICONFLOW_API_KEY is required for video generation");
        const body = { model: model.id, prompt, image_size: model.opencodeVideoSize ?? "1280x720" };
        if (images.length) body.image = `data:${images[0].mimeType};base64,${images[0].data}`;
        const subRes = await fetch(`${baseUrl}/video/submit`, {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: options?.signal,
        });
        const sub = await subRes.json();
        if (!subRes.ok) throw new Error(sub?.message ?? sub?.error?.message ?? `Video submit HTTP ${subRes.status}`);
        const requestId = sub?.requestId ?? sub?.request_id ?? sub?.task_id ?? sub?.taskId;
        if (!requestId) throw new Error("Video submit returned no requestId");
        const deadline = Date.now() + 30 * 60 * 1000;
        let result;
        while (Date.now() < deadline) {
          if (options?.signal?.aborted) throw new Error("Video generation aborted");
          await new Promise((resolve, reject) => {
            const timer = setTimeout(resolve, 5000);
            options?.signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("Video generation aborted")); }, { once: true });
          });
          const stRes = await fetch(`${baseUrl}/video/status`, {
            method: "POST",
            headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
            body: JSON.stringify({ requestId }),
            signal: options?.signal,
          });
          const st = await stRes.json();
          if (!stRes.ok) throw new Error(st?.message ?? st?.error?.message ?? `Video status HTTP ${stRes.status}`);
          const status = st?.status ?? st?.data?.status ?? st?.statuses?.status;
          if (["Succeed", "Succeeded", "completed", "success"].includes(status)) { result = st; break; }
          if (["Failed", "failed", "error"].includes(status)) throw new Error(st?.message ?? st?.error?.message ?? "Video generation failed");
        }
        if (!result) throw new Error("Video generation timed out after 30 minutes");
        const url = result?.results?.videos?.[0]?.url ?? result?.video_url ?? result?.url ?? result?.data?.video_url;
        if (!url) throw new Error("Video status returned no video url");
        const path = await saveNativeVideo(url, model.id);
        const text = `Generated video saved to: ${fileLink(path)}\n\nVideo URL: ${url}`;
        output.content.push({ type: "text", text });
        stream.push({ type: "text_start", contentIndex: 0, partial: output });
        stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: output });
        stream.push({ type: "text_end", contentIndex: 0, content: text, partial: output });
        output.stopReason = "stop";
        stream.push({ type: "done", reason: "stop", message: output });
        stream.end();
        return;
      }
      const isCN = model.opencodeImageProvider === "agnes-cn";
      const baseUrl = isCN ? "https://api.agnes-ai.cn/v1" : "https://apihub.agnes-ai.com/v1";
      const envKey = isCN ? "AGNES_CN_API_KEY" : "AGNES_API_KEY";
      const body = {
        model: model.id,
        prompt,
        ...(images.length === 1 ? { image: `data:${images[0].mimeType};base64,${images[0].data}` } : {}),
        ...(images.length > 1 ? { extra_body: { image: images.map((image) => `data:${image.mimeType};base64,${image.data}`), mode: "keyframes" } } : {}),
        num_frames: 121,
        frame_rate: 24,
      };
      const response = await fetch(`${baseUrl}/videos`, {
        method: "POST",
        headers: { Authorization: `Bearer ${process.env[envKey] ?? ""}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: options?.signal,
      });
      const task = await response.json();
      if (!response.ok) throw new Error(task?.error?.message ?? `Video API HTTP ${response.status}`);
      const videoId = task.video_id ?? task.id ?? task.task_id;
      if (!videoId) throw new Error("Video API returned no video_id");
      const result = task.status === "completed" ? task : await waitForNativeVideo(baseUrl, videoId, process.env[envKey] ?? "", options?.signal);
      const url = result?.metadata?.url;
      if (!url) throw new Error("Video API returned no metadata.url");
      const path = await saveNativeVideo(url, model.id);
      const text = `Generated video saved to: ${fileLink(path)}\n\nVideo URL: ${url}`;
      output.content.push({ type: "text", text });
      stream.push({ type: "text_start", contentIndex: 0, partial: output });
      stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: output });
      stream.push({ type: "text_end", contentIndex: 0, content: text, partial: output });
      output.stopReason = "stop";
      stream.push({ type: "done", reason: "stop", message: output });
      stream.end();
    } catch (error) {
      output.stopReason = options?.signal?.aborted ? "aborted" : "error";
      output.errorMessage = error instanceof Error ? error.message : String(error);
      stream.push({ type: "error", reason: output.stopReason, error: output });
      stream.end();
    }
  })();
  return stream;
}

function streamNativeImage(model, context, options) {
  const stream = new AssistantMessageEventStream();
  const output = makeOutput(model);
  (async () => {
    try {
      stream.push({ type: "start", partial: output });
      const { prompt, images } = latestImageRequest(context);
      if (!prompt) throw new Error("Image generation requires a text prompt");
      const isSenseNova = model.opencodeImageProvider === "sensenova";
      const isSiliconFlow = model.opencodeImageProvider === "siliconflow";
      const isAgnesCN = model.opencodeImageProvider === "agnes-cn";
      const isCloudflare = model.opencodeImageProvider === "cloudflare";
      if (isCloudflare) {
        const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
        const apiKey = process.env.CLOUDFLARE_API_KEY;
        if (!accountId || !apiKey) throw new Error("CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_KEY are required for image generation");
        const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${model.id}`, {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({ prompt }),
          signal: options?.signal,
        });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload?.errors?.[0]?.message ?? `Cloudflare image API HTTP ${response.status}`);
        const saved = await saveNativeImage({ b64_json: payload?.result?.image, mime_type: "image/jpeg" }, model.id);
        const text = `Generated image saved to: ${fileLink(saved.path)}`;
        output.content.push({ type: "text", text });
        stream.push({ type: "text_start", contentIndex: 0, partial: output });
        stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: output });
        stream.push({ type: "text_end", contentIndex: 0, content: text, partial: output });
        appendNativeImage?.(saved);
        output.stopReason = "stop";
        stream.push({ type: "done", reason: "stop", message: output });
        stream.end();
        return;
      }
      const baseUrl = isSenseNova
        ? "https://token.sensenova.cn/v1"
        : isSiliconFlow
          ? "https://api.siliconflow.cn/v1"
          : isAgnesCN
            ? "https://api.agnes-ai.cn/v1"
            : "https://apihub.agnes-ai.com/v1";
      const envKey = isSenseNova ? "SENSENOVA_API_KEY" : isSiliconFlow ? "SILICONFLOW_API_KEY" : isAgnesCN ? "AGNES_CN_API_KEY" : "AGNES_API_KEY";
      const endpoint = isSenseNova && images.length ? `${baseUrl}/images/edits` : `${baseUrl}/images/generations`;
      const body = isSiliconFlow
        ? { model: model.id, prompt, n: 1, response_format: "url" }
        : isSenseNova
          ? {
            model: model.id,
            prompt,
            n: 1,
            response_format: "url",
            output_format: "png",
            ...(images.length ? { images: images.map((image) => ({ image_url: `data:${image.mimeType};base64,${image.data}` })) } : {}),
          }
        : {
            model: model.id,
            prompt,
            n: 1,
            extra_body: { response_format: "url" },
            ...(images.length === 1 ? { image: `data:${images[0].mimeType};base64,${images[0].data}` } : {}),
          };
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { Authorization: `Bearer ${process.env[envKey] ?? ""}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: options?.signal,
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.error?.message ?? `Image API HTTP ${response.status}`);
      const image = payload?.data?.[0];
      if (!image) throw new Error("Image API returned no image data");
      const saved = await saveNativeImage(image, model.id);
      const text = `Generated image saved to: ${fileLink(saved.path)}`;
      output.content.push({ type: "text", text });
      stream.push({ type: "text_start", contentIndex: 0, partial: output });
      stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: output });
      stream.push({ type: "text_end", contentIndex: 0, content: text, partial: output });
      appendNativeImage?.(saved);
      output.stopReason = "stop";
      stream.push({ type: "done", reason: "stop", message: output });
      stream.end();
    } catch (error) {
      output.stopReason = options?.signal?.aborted ? "aborted" : "error";
      output.errorMessage = error instanceof Error ? error.message : String(error);
      stream.push({ type: "error", reason: output.stopReason, error: output });
      stream.end();
    }
  })();
  return stream;
}

// Factory for standard OpenAI-compatible providers (no special headers/schema).
// opts.maxTokens may be a number (all models) or a function (model) => number
// to let each model use its own registered limit.
// Provider-side model churn surfaces as distinctive upstream errors long before
// our curated lists get updated. Recognize them and attach an actionable hint:
// - 404 / "not found" / 已下线 → model deprecated or renamed;
// - insufficient-balance → if the model is curated as free, that label is stale
//   (it turned paid and just tried to bill the user). See also:
//   .github/workflows/siliconflow-watch.yml (weekly official-announcements poll).
function explainModelChurn(status, errText) {
  const t = String(errText).toLowerCase();
  if (
    status === 404 ||
    /model[\w-]{0,24}(not found|not exist|does not exist)/.test(t) ||
    /(已下线|已不再提供|不存在|deprecated|no longer available)/.test(t)
  ) {
    return "Hint: this model may have been deprecated/renamed by the provider — check 模型广场 (https://cloud.siliconflow.cn/me/models) and update the curated list.";
  }
  if (/insufficient[ _-]?balance|余额不足/.test(t)) {
    return "Hint: rejected for insufficient balance — if this model is labeled 免费 in the curated list, that label is stale (it has turned PAID). Update SILICONFLOW_MODELS accordingly.";
  }
  return "";
}

function makeOpenAIStream(baseUrl, envKey, opts = {}) {
  return function streamSimple(model, context, options) {
    const stream = new AssistantMessageEventStream();
    const output = makeOutput(model);
    const maxTokens = typeof opts.maxTokens === "function" ? opts.maxTokens(model) : (opts.maxTokens ?? 128000);
    const cfg = {
      url: `${baseUrl.replace(/\/+$/, "")}/chat/completions`,
      key: () => process.env[envKey] ?? (options?.apiKey && options.apiKey !== "public" ? options.apiKey : undefined),
      headers: () => ({}),
      maxTokens,
    };
    if (opts.cleanBody) cfg.cleanBody = opts.cleanBody;
    if (opts.enableThinking) cfg.enableThinking = true;
    run(stream, output, model, context, options, cfg);
    return stream;
  };
}

// ── Main streamSimple ──
function streamOpenCode(model, context, options) {
  const stream = new AssistantMessageEventStream();
  const output = makeOutput(model);
  run(stream, output, model, context, options, {
    url: "https://opencode.ai/zen/v1/chat/completions",
    key: () => process.env.OPENCODE_API_KEY
      ?? (options?.apiKey && options.apiKey !== "public" ? options.apiKey : "public"),
    headers: () => ({
      ...OPENCODE_STATIC_HEADERS,
      "x-opencode-session": SESSION_ID,
      "x-opencode-request": generateOpenCodeId("msg_"),
    }),
    maxTokens: 128000,
  });
  return stream;
}

// SenseNova (商汤日日新) — OpenAI-compatible gateway with a strict schema.
// https://platform.sensenova.cn/docs — only listed fields are accepted;
// response_format is rejected, multiple system messages must be merged,
// assistant.content:null must be dropped, max_tokens <= 65536.
const streamSenseNovaChat = makeOpenAIStream("https://token.sensenova.cn/v1", "SENSENOVA_API_KEY", {
  maxTokens: 65536,
  cleanBody: (body) => {
    const msgs = body.messages ?? [];
    const merged = [];
    for (const m of msgs) {
      const last = merged[merged.length - 1];
      if (m.role === "system" && last?.role === "system") {
        last.content = `${last.content}\n\n${m.content}`;
      } else {
        merged.push({ ...m });
      }
    }
    for (const m of merged) {
      if (m.role === "assistant" && m.content === null) delete m.content;
    }
    return { ...body, messages: merged };
  },
});
const streamSenseNova = (model, context, options) =>
  model.opencodeImageModel ? streamNativeImage(model, context, options) : streamSenseNovaChat(model, context, options);

// Standard OpenAI-compatible providers
const SF_URL = "https://api.siliconflow.cn/v1";
const streamSiliconFlowChat = makeOpenAIStream(SF_URL, "SILICONFLOW_API_KEY");
const streamSiliconFlow = (model, context, options) => {
  if (model.opencodeTranscriptionModel) return streamOpenAIASR(model, context, options, SF_URL, "SILICONFLOW_API_KEY");
  if (model.opencodeAudioModel) return streamOpenAITTS(model, context, options, SF_URL, "SILICONFLOW_API_KEY");
  if (model.opencodeImageModel) return streamNativeImage(model, context, options);
  if (model.opencodeVideoModel) return streamNativeVideo(model, context, options);
  return streamSiliconFlowChat(model, context, options);
};
const MS_URL = "https://api-inference.modelscope.cn/v1";
const streamModelScopeChat = makeOpenAIStream(MS_URL, "MODELSCOPE_API_KEY", { maxTokens: 65536 });
const streamModelScope = (model, context, options) => {
  if (model.opencodeTranscriptionModel) return streamOpenAIASR(model, context, options, MS_URL, "MODELSCOPE_API_KEY");
  if (model.opencodeAudioModel) return streamOpenAITTS(model, context, options, MS_URL, "MODELSCOPE_API_KEY");
  return streamModelScopeChat(model, context, options);
};
const streamNvidia = makeOpenAIStream("https://integrate.api.nvidia.com/v1", "NVIDIA_NIM_API_KEY");

// Agnes AI — OpenAI-compatible gateway (apihub.agnes-ai.com = 国际站,
// api.agnes-ai.cn = 中国站). Same model lineup on both. Supports
// image_url input (base64 data URLs work), tool calling, and thinking mode
// via chat_template_kwargs.enable_thinking (wired to pi's thinkingLevel).
// https://www.agnes-ai.com/zh-Hans/docs/overview
const streamAgnesChat = makeOpenAIStream("https://apihub.agnes-ai.com/v1", "AGNES_API_KEY", {
  maxTokens: 65536,
  enableThinking: true,
});
const streamAgnesCNChat = makeOpenAIStream("https://api.agnes-ai.cn/v1", "AGNES_CN_API_KEY", {
  maxTokens: 65536,
  enableThinking: true,
});
const streamAgnes = (model, context, options) =>
  model.opencodeVideoModel
    ? streamNativeVideo(model, context, options)
    : model.opencodeImageModel
      ? streamNativeImage(model, context, options)
      : streamAgnesChat(model, context, options);
const streamAgnesCN = (model, context, options) =>
  model.opencodeVideoModel
    ? streamNativeVideo(model, context, options)
    : model.opencodeImageModel
      ? streamNativeImage(model, context, options)
      : streamAgnesCNChat(model, context, options);

// Cloudflare Workers AI — official OpenAI-compatible endpoint.
// https://developers.cloudflare.com/workers-ai/configuration/open-ai-compatibility/
// The account id is embedded in the URL path, so the base URL is built from
// CLOUDFLARE_ACCOUNT_ID at request time (cannot use makeOpenAIStream's static
// baseUrl). Free tier: 10,000 neurons/day (UTC reset); the 5 frontier models
// (deepseek-v4-flash/pro, glm-5.2, kimi-k2.6/k2.7-code) require paid billing
// and are intentionally NOT registered here.
const streamCloudflare = (model, context, options) => {
  if (model.opencodeTranscriptionModel) return streamNativeTranscription(model, context, options);
  if (model.opencodeImageModel) return streamNativeImage(model, context, options);
  if (model.opencodeAudioModel) return streamNativeAudio(model, context, options);
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!accountId) {
    const stream = new AssistantMessageEventStream();
    const output = makeOutput(model);
    output.stopReason = "error";
    output.errorMessage = "CLOUDFLARE_ACCOUNT_ID env var is not set; cannot build Workers AI endpoint URL";
    stream.push({ type: "error", reason: "error", error: output });
    try { stream.end(); } catch {}
    return stream;
  }
  return makeOpenAIStream(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1`,
    "CLOUDFLARE_API_KEY",
    { maxTokens: (model) => model.maxTokens ?? 65536 }
  )(model, context, options);
};

async function run(stream, output, model, context, options, cfg) {
  const state = { output, stream, contentBlockIndex: -1, thinkingBlockIndex: -1, toolCallsState: [] };
  try {
    // pi carries its system prompt (coding prompt, injected skills XML, etc.)
    // in context.systemPrompt — forward it, otherwise the model never sees it.
    const sysRaw = context.systemPrompt;
    let systemText = "";
    if (typeof sysRaw === "string") systemText = sysRaw;
    else if (Array.isArray(sysRaw)) systemText = sysRaw.map((b) => (typeof b === "string" ? b : b?.text ?? "")).join("");
    else if (sysRaw && typeof sysRaw === "object") {
      const c = sysRaw.content ?? sysRaw.text;
      if (typeof c === "string") systemText = c;
    }
    const messages = [
      ...(systemText ? [{ role: "system", content: systemText }] : []),
      ...normalizeMessages(context.messages ?? []),
    ];
    const tools = normalizeTools(context.tools);
    let body = {
      model: model.id,
      messages,
      stream: true,
      stream_options: { include_usage: true },
      ...(tools && tools.length > 0 ? { tools } : {}),
      ...(options?.maxTokens ? { max_tokens: options.maxTokens } : { max_tokens: cfg.maxTokens }),
    };
    if (cfg.cleanBody) body = cfg.cleanBody(body);
    // Thinking mode for providers that opt in via a gateway extension field
    // (e.g. Agnes AI: chat_template_kwargs.enable_thinking). pi signals the
    // requested level through options.thinkingLevel.
    if (cfg.enableThinking && options?.thinkingLevel && options.thinkingLevel !== "off") {
      body.chat_template_kwargs = { enable_thinking: true };
    }
    const headers = {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      Authorization: `Bearer ${cfg.key()}`,
      ...(cfg.headers ? cfg.headers() : {}),
    };
    stream.push({ type: "start", partial: output });
    const response = await fetch(cfg.url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: options?.signal,
    });
    if (!response.ok) {
      const errText = await response.text();
      const hint = explainModelChurn(response.status, errText);
      throw new Error(`${model.provider} API request failed: ${response.status} ${response.statusText}. ${errText.slice(0, 300)}${hint ? `\n${hint}` : ""}`);
    }
    const reader = response.body.getReader();
    await consumeSSEStream(state, reader);
    finalizeToolCalls(state);
    if (state.toolCallsState.length > 0) output.stopReason = "toolUse";
    else if (!output.stopReason || output.stopReason === "stop") output.stopReason = "stop";
    stream.push({ type: "done", reason: output.stopReason, message: output });
    stream.end();
  } catch (e) {
    output.stopReason = options?.signal?.aborted ? "aborted" : "error";
    output.errorMessage = e instanceof Error ? e.message : String(e);
    stream.push({ type: "error", reason: output.stopReason, error: output });
    try { stream.end(); } catch {}
  }
}

// ── Agnes AI models (shared by international + China providers) ──
// Chat and verified image-generation models. Image models use the native
// /v1/images/generations endpoint rather than chat completions. Limits from:
// https://wiki.agnes-ai.com/en/docs/agnes-25-flash.md (and agnes-20-flash.md)
// agnes-2.0-flash 已于 2026-08 官方标记 Deprecated（迁移至 agnes-2.5-flash）并移除。
const AGNES_MODELS = [
  {
    id: "agnes-2.5-flash",
    name: "Agnes 2.5 Flash",
    api: "openai-completions",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 512000,
    maxTokens: 65536,
  },
  {
    id: "agnes-2.5-pro",
    name: "Agnes 2.5 Pro",
    api: "openai-completions",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0.45, output: 0.9, cacheRead: 0.0038, cacheWrite: 0 },
    contextWindow: 1048576,
    maxTokens: 65536,
  },
  {
    id: "agnes-2.5-pro-alpha",
    name: "Agnes 2.5 Pro Alpha",
    api: "openai-completions",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0.45, output: 0.9, cacheRead: 0.0038, cacheWrite: 0 },
    contextWindow: 1048576,
    maxTokens: 65536,
  },
  {
    id: "agnes-image-2.0-flash",
    name: "Agnes Image 2.0 Flash",
    api: "openai-completions",
    input: ["text"],
    opencodeImageModel: true,
    opencodeImageProvider: "agnes",
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 131072,
    maxTokens: 4096,
  },
  {
    id: "agnes-image-2.1-flash",
    name: "Agnes Image 2.1 Flash",
    api: "openai-completions",
    input: ["text"],
    opencodeImageModel: true,
    opencodeImageProvider: "agnes",
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 131072,
    maxTokens: 4096,
  },
  {
    id: "agnes-video-v2.0",
    name: "Agnes Video V2.0",
    api: "openai-completions",
    input: ["text"],
    opencodeVideoModel: true,
    opencodeImageProvider: "agnes",
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 131072,
    maxTokens: 4096,
  },
  {
    id: "agnes-video-2.5",
    name: "Agnes Video 2.5",
    api: "openai-completions",
    input: ["text"],
    opencodeVideoModel: true,
    opencodeImageProvider: "agnes",
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 131072,
    maxTokens: 4096,
  },
  {
    id: "agnes-video-2.5-flash",
    name: "Agnes Video 2.5 Flash",
    api: "openai-completions",
    input: ["text"],
    opencodeVideoModel: true,
    opencodeImageProvider: "agnes",
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 131072,
    maxTokens: 4096,
  },
];

// ── Curated model allowlists ──
// Models we vouch for: verified free tier + correct metadata (contextWindow,
// maxTokens, reasoning, input, cost). At load each list is intersected with
// the provider's live /v1/models so models that leave the free tier or get
// renamed are auto-removed (drift detection). For Zen, every live model is
// additionally probe-verified as free at load (see verifyZenModels): unknown
// free models are auto-added with conservative metadata, and curated entries
// that switched to paid are dropped despite being whitelisted.
const ZEN_FREE_MODELS = [
  {
    id: "mimo-v2.5-free",
    name: "MiMo-V2.5 Free",
    api: "openai-completions",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200000,
    maxTokens: 128000,
  },
  {
    id: "laguna-s-2.1-free",
    name: "Laguna S 2.1 Free",
    api: "openai-completions",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200000,
    maxTokens: 128000,
  },
  {
    id: "nemotron-3-ultra-free",
    name: "Nemotron 3 Ultra Free",
    api: "openai-completions",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1000000,
    maxTokens: 128000,
  },
  {
    id: "nemotron-3.5-lightning-free",
    name: "Nemotron 3.5 Lightning Free",
    api: "openai-completions",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1000000,
    maxTokens: 128000,
  },
  {
    id: "big-pickle",
    name: "Big Pickle",
    api: "openai-completions",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200000,
    maxTokens: 128000,
  },
];
const SENSENOVA_MODELS = [
  {
    id: "sensenova-6.7-flash-lite",
    name: "SenseNova 6.7 Flash-Lite",
    api: "openai-completions",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 262144,
    maxTokens: 65536,
  },
  {
    id: "sensenova-6.8-flash-lite",
    name: "SenseNova 6.8 Flash-Lite",
    api: "openai-completions",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 262144,
    maxTokens: 65536,
  },
  {
    id: "deepseek-v4-flash",
    name: "DeepSeek V4 Flash (via SenseNova)",
    api: "openai-completions",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1048576,
    maxTokens: 65536,
  },
  {
    id: "glm-5.2",
    name: "GLM-5.2 (via SenseNova)",
    api: "openai-completions",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1048576,
    maxTokens: 131072,
  },
  {
    id: "sensenova-u1-fast",
    name: "SenseNova U1 Fast (image generation)",
    api: "openai-completions",
    input: ["text"],
    opencodeImageModel: true,
    opencodeImageProvider: "sensenova",
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 262144,
    maxTokens: 4096,
  },
  {
    id: "sensenova-u1.5-lite",
    name: "SenseNova U1.5 Lite (image generation/editing)",
    api: "openai-completions",
    input: ["text", "image"],
    opencodeImageModel: true,
    opencodeImageProvider: "sensenova",
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 262144,
    maxTokens: 4096,
  },
];
// 免费清单 2026-08-22 经模型广场 biz_info 计价接口逐个核验，并与 /v1/models 在架列表取交集。
// 变动提示：nex-agi/Nex-N2-Pro 已转付费（输入¥0.00175/输出¥0.007 每K tokens）；
// Qwen2.5-7B-Instruct 不再免费；glm-4-9b-chat、Qwen2-7B-Instruct、R1-Distill-Qwen-7B、
// bce 向量/重排序等老牌免费模型均已下线。当前免费聊天模型仅剩以下小模型。
const SILICONFLOW_MODELS = [
  {
    id: "Qwen/Qwen3-8B",
    name: "Qwen3-8B (免费)",
    api: "openai-completions",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 131072,
    maxTokens: 65536,
  },
  {
    id: "deepseek-ai/DeepSeek-R1-0528-Qwen3-8B",
    name: "DeepSeek-R1-0528-Qwen3-8B (免费推理)",
    api: "openai-completions",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 131072,
    maxTokens: 65536,
  },
  {
    id: "THUDM/GLM-Z1-9B-0414",
    name: "GLM-Z1-9B (免费推理)",
    api: "openai-completions",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 131072,
    maxTokens: 32768,
  },
  {
    id: "THUDM/GLM-4-9B-0414",
    name: "GLM-4-9B-0414 (免费)",
    api: "openai-completions",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 32768,
    maxTokens: 8192,
  },
  {
    id: "Qwen/Qwen3.5-4B",
    name: "Qwen3.5-4B (免费长上下文)",
    api: "openai-completions",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 262144,
    maxTokens: 65536,
  },
  {
    id: "Tongyi-MAI/Z-Image-Turbo",
    name: "Z-Image Turbo (SiliconFlow image)",
    api: "openai-completions",
    input: ["text"],
    opencodeImageModel: true,
    opencodeImageProvider: "siliconflow",
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 131072,
    maxTokens: 4096,
  },
  {
    id: "FunAudioLLM/CosyVoice2-0.5B",
    name: "CosyVoice2 0.5B (SiliconFlow TTS)",
    api: "openai-completions",
    input: ["text"],
    opencodeAudioModel: true,
    opencodeAudioProvider: "openai-audio",
    opencodeVoice: "FunAudioLLM/CosyVoice2-0.5B:alex",
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 131072,
    maxTokens: 4096,
  },
  {
    id: "FunAudioLLM/SenseVoiceSmall",
    name: "SenseVoiceSmall (SiliconFlow ASR)",
    api: "openai-completions",
    input: ["audio"],
    opencodeTranscriptionModel: true,
    opencodeAsrProvider: "openai-audio",
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 131072,
    maxTokens: 4096,
  },
  {
    id: "Wan-AI/Wan2.2-T2V-A14B",
    name: "Wan2.2 T2V A14B (SiliconFlow video)",
    api: "openai-completions",
    input: ["text"],
    opencodeVideoModel: true,
    opencodeVideoProvider: "siliconflow",
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 131072,
    maxTokens: 4096,
  },
];
const MODELSCOPE_MODELS = [
  {
    id: "Qwen/Qwen3-Coder-30B-A3B-Instruct",
    name: "Qwen3-Coder-30B (via ModelScope)",
    api: "openai-completions",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 131072,
    maxTokens: 65536,
  },
  // DeepSeek-V4-Pro 存在但默认配额不足(429)，需在 ModelScope 控制台开通对应模型额度
  {
    id: "deepseek-ai/DeepSeek-V4-Pro",
    name: "DeepSeek V4 Pro (via ModelScope, 需开通)",
    api: "openai-completions",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1048576,
    maxTokens: 65536,
  },
];
// NVIDIA NIM (build.nvidia.com) — free tier: up to 40 RPM + 10,000 requests/day
// (site-published limits, daily reset). The RPM cap is account-level and shared
// across ALL models, so this provider suits low-frequency / fallback use.
// Curated from the ~100-model catalog after live streaming benchmarks (2026-08).
// Excluded: deepseek-v4-flash-0731 (read timeout x2), stepfun step-3.7-flash
// (HTTP 500), kimi-k2.6 / codestral-22b (HTTP 404 not entitled on free accounts),
// gpt-oss-120b (persistent read-timeouts confirmed by local benchmark + the
// nvidia-watch CI probe across two networks; Cloudflare carries the same model),
// nvidia/llama-3.3-nemotron-super-49b-v1.5 (removed from catalog 2026-08-31,
// probe HTTP 410 Gone), deepseek-ai/deepseek-v4-pro-0813 (catalog 2026-08-31,
// no free-tier evidence; Cloudflare carries it behind paid billing).
const NVIDIA_MODELS = [
  // Benchmark winner: TTFB 0.8s, ~130 tok/s.
  {
    id: "openai/gpt-oss-20b",
    name: "GPT-OSS 20B (via NVIDIA NIM)",
    api: "openai-completions",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 131072,
    maxTokens: 65536,
  },
  // TTFB 0.8s, ~70 tok/s.
  {
    id: "minimaxai/minimax-m3",
    name: "MiniMax M3 (via NVIDIA NIM)",
    api: "openai-completions",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 131072,
    maxTokens: 65536,
  },
  // Thinking model; TTFB 0.8s, ~80 tok/s.
  {
    id: "nvidia/nemotron-3-nano-30b-a3b",
    name: "Nemotron 3 Nano 30B A3B (via NVIDIA NIM)",
    api: "openai-completions",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 131072,
    maxTokens: 65536,
  },
  // Works but slow generation (~5-18 tok/s).
  {
    id: "moonshotai/kimi-k3",
    name: "Kimi K3 (via NVIDIA NIM)",
    api: "openai-completions",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 131072,
    maxTokens: 65536,
  },
];
const CLOUDFLARE_MODELS = [
  {
    id: "@cf/openai/gpt-oss-120b",
    name: "GPT-OSS 120B (via Cloudflare)",
    api: "openai-completions",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 131072,
    maxTokens: 65536,
  },
  {
    id: "@cf/openai/gpt-oss-20b",
    name: "GPT-OSS 20B (via Cloudflare)",
    api: "openai-completions",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 131072,
    maxTokens: 65536,
  },
  {
    id: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    name: "Llama 3.3 70B (via Cloudflare)",
    api: "openai-completions",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 24000,
    maxTokens: 8192,
  },
  {
    id: "@cf/qwen/qwen3-30b-a3b-fp8",
    name: "Qwen3 30B A3B (via Cloudflare)",
    api: "openai-completions",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 32768,
    maxTokens: 8192,
  },
  {
    id: "@cf/qwen/qwen2.5-coder-32b-instruct",
    name: "Qwen2.5 Coder 32B (via Cloudflare)",
    api: "openai-completions",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 32768,
    maxTokens: 8192,
  },
  {
    id: "@cf/google/gemma-4-26b-a4b-it",
    name: "Gemma 4 26B (via Cloudflare)",
    api: "openai-completions",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 131072,
    maxTokens: 65536,
  },
  {
    id: "@cf/zai-org/glm-4.7-flash",
    name: "GLM-4.7-Flash (via Cloudflare)",
    api: "openai-completions",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 131072,
    maxTokens: 65536,
  },
  {
    id: "@cf/deepseek-ai/deepseek-r1-distill-qwen-32b",
    name: "DeepSeek R1 Distill Qwen 32B (via Cloudflare)",
    api: "openai-completions",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 80000,
    maxTokens: 65536,
  },
  {
    id: "@cf/black-forest-labs/flux-1-schnell",
    name: "FLUX.1 Schnell (via Cloudflare image)",
    api: "openai-completions",
    input: ["text"],
    opencodeImageModel: true,
    opencodeImageProvider: "cloudflare",
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 131072,
    maxTokens: 4096,
  },
  {
    id: "@cf/deepgram/aura-2-en",
    name: "Deepgram Aura 2 English (via Cloudflare TTS)",
    api: "openai-completions",
    input: ["text"],
    opencodeAudioModel: true,
    opencodeAudioProvider: "cloudflare",
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 131072,
    maxTokens: 4096,
  },
  {
    id: "@cf/deepgram/aura-2-es",
    name: "Deepgram Aura 2 Spanish (via Cloudflare TTS)",
    api: "openai-completions",
    input: ["text"],
    opencodeAudioModel: true,
    opencodeAudioProvider: "cloudflare",
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 131072,
    maxTokens: 4096,
  },
  {
    id: "@cf/openai/whisper",
    name: "OpenAI Whisper (via Cloudflare ASR)",
    api: "openai-completions",
    input: ["audio"],
    opencodeTranscriptionModel: true,
    opencodeAsrProvider: "cloudflare",
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 131072,
    maxTokens: 4096,
  },
  {
    id: "@cf/deepgram/nova-3",
    name: "Deepgram Nova-3 (via Cloudflare ASR)",
    api: "openai-completions",
    input: ["audio"],
    opencodeTranscriptionModel: true,
    opencodeAsrProvider: "cloudflare",
    opencodeAsrRawBody: true,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 131072,
    maxTokens: 4096,
  },
];

// ── Live model-list drift detection ──
// Fetch complete model objects from a provider's /v1/models. The live payload
// is retained so capability metadata (modalities/features/supports_*) is not
// lost while doing drift detection.
async function fetchLiveModels(url, headers) {
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const json = await res.json();
    const data = Array.isArray(json) ? json : json?.data;
    if (!Array.isArray(data)) return null;
    return data.filter((model) => model && (model.id ?? model.name));
  } catch {
    return null;
  }
}

async function fetchLiveModelIds(url, headers) {
  const models = await fetchLiveModels(url, headers);
  return models ? new Set(models.map((model) => model.id ?? model.name).filter(Boolean)) : null;
}

function authHeader(envKey) {
  return { Authorization: `Bearer ${process.env[envKey] ?? "public"}` };
}

function mergeLiveModel(curated, live) {
  // Keep curated routing/cost/limit metadata authoritative, while retaining
  // the complete upstream object for capability detection and diagnostics.
  return {
    ...live,
    ...curated,
    id: curated.id,
    name: curated.name ?? live.name ?? live.label ?? curated.id,
    opencodeLiveModel: live,
  };
}

// Keep the curated allowlist for safety, but return each retained model with
// its complete upstream metadata instead of reducing /v1/models to IDs.
async function filterToLive(curated, url, headers) {
  const liveModels = await fetchLiveModels(url, headers);
  if (!liveModels) return curated;
  const byId = new Map(liveModels.map((model) => [model.id ?? model.name, model]));
  const kept = curated
    .filter((model) => byId.has(model.id))
    .map((model) => mergeLiveModel(model, byId.get(model.id)));
  return kept.length ? kept : curated;
}

// ── Zen free-model auto-discovery ──
// /v1/models exposes no pricing and paid models keep "-free" ids, so freeness
// is verified by probing: a tiny chat completion per unknown model. Free
// models accept the anonymous "public" key (HTTP 200) while paid ones reject
// it during auth (401/402/403) before any tokens are billed. When a real
// OPENCODE_API_KEY is set, the response's `cost` field must be zero instead —
// paid models then succeed but report non-zero cost.
// Returns "free" (verified), "paid" (verified not free), or "unknown"
// (network/shape errors — callers must keep the model rather than drop it,
// so a transient outage never wipes the list).
async function probeFreeStatus(modelId) {
  const apiKey = process.env.OPENCODE_API_KEY;
  let res;
  try {
    res = await fetch("https://opencode.ai/zen/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...OPENCODE_STATIC_HEADERS,
        "x-opencode-session": SESSION_ID,
        "x-opencode-request": generateOpenCodeId("msg_"),
        Authorization: `Bearer ${apiKey ?? "public"}`,
      },
      body: JSON.stringify({ model: modelId, messages: [{ role: "user", content: "hi" }], max_tokens: 1 }),
      signal: AbortSignal.timeout(20000),
    });
  } catch {
    return "unknown";
  }
  if (!res.ok) {
    // Auth/billing rejection = verified not free. Anything else (5xx, rate
    // limit) says nothing about pricing — treat as unknown.
    return [401, 402, 403].includes(res.status) ? "paid" : "unknown";
  }
  let json;
  try { json = await res.json(); } catch { return "unknown"; }
  if (apiKey) return Number(json?.cost ?? 0) === 0 ? "free" : "paid";
  return "free";
}
// Run async fn over items with bounded concurrency.
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const idx = next++;
      results[idx] = await fn(items[idx]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
function makeDiscoveredModel(id) {
  return {
    id,
    name: id,
    api: "openai-completions",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 131072,
    maxTokens: 65536,
  };
}
// Verify the whole live Zen list by probing every id (curated entries use
// their hand-verified metadata, unknown ones get conservative defaults). This
// catches models that switched from free to paid while staying listed — they
// are dropped exactly like renamed/removed ones. If nothing verifies free
// (e.g. probes all failed), fall back to the curated ∩ live intersection so a
// gateway outage never empties the provider.
async function verifyZenModels(liveIds) {
  const known = new Map(ZEN_FREE_MODELS.map((m) => [m.id, m]));
  const ids = [...liveIds];
  const statuses = await mapLimit(ids, 8, probeFreeStatus);
  const verified = [];
  for (let i = 0; i < ids.length; i++) {
    if (statuses[i] !== "free") continue;
    verified.push(known.get(ids[i]) ?? makeDiscoveredModel(ids[i]));
  }
  if (verified.length) return verified;
  const kept = ZEN_FREE_MODELS.filter((m) => liveIds.has(m.id));
  return kept.length ? kept : ZEN_FREE_MODELS;
}

// ── Extension entry ──
// ── Non-blocking startup: register curated/cached lists immediately, then
// drift-detect live in the background so Pi never waits on the network. ──

const OPENCODE_CACHE_FILE = join(homedir(), ".pi", "cache", "opencode-native-models.json");
const OPENCODE_CACHE_TTL = 24 * 60 * 60 * 1000;

function loadCache() {
  try {
    const data = JSON.parse(readFileSync(OPENCODE_CACHE_FILE, "utf-8"));
    if (!data || typeof data.timestamp !== "number") return null;
    if (Date.now() - data.timestamp > OPENCODE_CACHE_TTL) return null;
    return data;
  } catch {
    return null;
  }
}

function saveCache(models) {
  try {
    const dir = dirname(OPENCODE_CACHE_FILE);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(OPENCODE_CACHE_FILE, JSON.stringify({ timestamp: Date.now(), ...models }));
  } catch {
    // best-effort; the cache is an optimization, never required
  }
}

function curatedModels() {
  return {
    zen: ZEN_FREE_MODELS,
    sensenova: SENSENOVA_MODELS,
    siliconflow: SILICONFLOW_MODELS,
    modelscope: MODELSCOPE_MODELS,
    nvidia: NVIDIA_MODELS,
    cloudflare: CLOUDFLARE_MODELS,
    agnes: AGNES_MODELS,
  };
}

function initialModels() {
  const cache = loadCache();
  if (!cache) return curatedModels();
  const curated = curatedModels();
  return {
    zen: cache.zen ?? curated.zen,
    sensenova: cache.sensenova ?? curated.sensenova,
    siliconflow: cache.siliconflow ?? curated.siliconflow,
    modelscope: cache.modelscope ?? curated.modelscope,
    nvidia: cache.nvidia ?? curated.nvidia,
    cloudflare: curated.cloudflare,
    agnes: cache.agnes ?? curated.agnes,
  };
}

// Derive a capabilities block from model metadata. Image-generation models
// carry explicit opencodeImageModel metadata because their upstream endpoint
// is not chat completions; verified Agnes/SenseNova models use native
// image/video generation paths below. Unknown providers remain conservative.
function withCapabilities(model) {
  const live = model.opencodeLiveModel ?? {};
  const asArray = (value) => Array.isArray(value) ? value.map(String).map((item) => item.toLowerCase()) : [];
  const inputModalities = asArray(live.input_modalities ?? live.inputModalities ?? model.input);
  const outputModalities = asArray(live.output_modalities ?? live.outputModalities);
  const featureValues = [
    ...asArray(live.supported_features),
    ...asArray(live.features),
    ...asArray(live.capabilities),
  ];
  const type = String(live.type ?? live.model_type ?? "").toLowerCase();
  const has = (...names) => {
    const wanted = names.map((name) => name.toLowerCase());
    return wanted.some((name) => featureValues.includes(name)) || wanted.some((name) => live?.[name] === true);
  };
  const vision = model.opencodeImageModel ? false : inputModalities.includes("image") || live.multimodal === true;
  const image = model.opencodeImageModel === true || outputModalities.includes("image") ||
    type === "image" || live.supports_image_generation === true || has("image_generation");
  const video = model.opencodeVideoModel === true || outputModalities.includes("video") ||
    type === "video" || live.supports_video === true || has("video");
  const audio = model.opencodeAudioModel === true || model.opencodeTranscriptionModel === true || inputModalities.includes("audio") || outputModalities.includes("audio") ||
    type === "audio" || live.supports_audio === true || has("audio", "speech", "transcription");
  const tools = live.features?.tools === false || live.capabilities?.tools === false
    ? false
    : model.tools !== false;
  return {
    ...model,
    capabilities: {
      tools,
      vision,
      image,
      video,
      audio,
      reasoning: !!model.reasoning || live.reasoning === true || live.supports_reasoning === true,
    },
  };
}

function registerAll(pi, m) {
  appendNativeImage = (image) => pi.appendEntry("opencode-generated-image", image);
  pi.registerEntryRenderer("opencode-generated-image", (entry, _options, theme) => {
    const image = entry.data ?? {};
    try {
      const data = readFileSync(image.path).toString("base64");
      // Image.render calls theme.fallbackColor(), but the global `theme` passed
      // to entry renderers does not define it (pi bug). Provide a compatible
      // wrapper so the inline image preview renders and we never crash.
      const imageTheme = theme && typeof theme.fallbackColor === "function"
        ? theme
        : { fallbackColor: (s) => (theme && theme.fg ? theme.fg("toolOutput", s) : s) };
      return new Image(data, image.mimeType || "image/png", imageTheme, { maxWidthCells: 80, maxHeightCells: 30 });
    } catch {
      const unavailablePath = image.path ?? "unknown path";
      return new Markdown(`Generated image unavailable: ${fileLink(unavailablePath)}`, 1, 0, getMarkdownTheme());
    }
  });
  // Augment each model with a capabilities block (derived from reasoning/input).
  for (const key of Object.keys(m)) {
    if (Array.isArray(m[key])) m[key] = m[key].map(withCapabilities);
  }
  pi.registerProvider("opencode-zen", {
    name: "OpenCode Zen (native headers)",
    apiKey: "public",
    baseUrl: "https://opencode.ai/zen/v1",
    api: "openai-completions",
    streamSimple: streamOpenCode,
    models: m.zen,
  });
  pi.registerProvider("sensenova", {
    name: "SenseNova (商汤日日新)",
    apiKey: "public",
    baseUrl: "https://token.sensenova.cn/v1",
    api: "openai-completions",
    streamSimple: streamSenseNova,
    models: m.sensenova,
  });
  pi.registerProvider("siliconflow", {
    name: "硅基流动 (SiliconFlow)",
    apiKey: "public",
    baseUrl: "https://api.siliconflow.cn/v1",
    api: "openai-completions",
    streamSimple: streamSiliconFlow,
    models: m.siliconflow,
  });
  pi.registerProvider("modelscope", {
    name: "魔塔社区 (ModelScope)",
    apiKey: "public",
    baseUrl: "https://api-inference.modelscope.cn/v1",
    api: "openai-completions",
    streamSimple: streamModelScope,
    models: m.modelscope,
  });
  pi.registerProvider("nvidia", {
    name: "NVIDIA NIM",
    apiKey: "public",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    api: "openai-completions",
    streamSimple: streamNvidia,
    models: m.nvidia,
  });
  pi.registerProvider("cloudflare", {
    name: "Cloudflare Workers AI (免费额度)",
    apiKey: "public",
    baseUrl: "https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/v1",
    api: "openai-completions",
    streamSimple: streamCloudflare,
    models: m.cloudflare,
  });
  pi.registerProvider("agnes", {
    name: "Agnes AI (国际站)",
    apiKey: "public",
    baseUrl: "https://apihub.agnes-ai.com/v1",
    api: "openai-completions",
    streamSimple: streamAgnes,
    models: m.agnes,
  });
  pi.registerProvider("agnes-cn", {
    name: "Agnes AI (中国站)",
    apiKey: "public",
    baseUrl: "https://api.agnes-ai.cn/v1",
    api: "openai-completions",
    streamSimple: streamAgnesCN,
    models: m.agnes,
  });
}

// ---------------------------------------------------------------------------
// /model-capabilities — per-model capability table across all providers
// ---------------------------------------------------------------------------

const OPENCODE_PROVIDER_IDS = [
  "opencode-zen",
  "sensenova",
  "siliconflow",
  "modelscope",
  "nvidia",
  "cloudflare",
  "agnes",
  "agnes-cn",
];

const OPENCODE_SESSION_USAGE = new Map();
let opencodeUsageHookInstalled = false;

function showModelMarkdown(pi, ctx, key, markdown) {
  if (ctx.mode === "tui") pi.appendEntry(key, { markdown });
  else if (ctx.hasUI) ctx.ui.notify(markdown, "info");
  else console.log(markdown);
}

function formatPrice(value) {
  if (value === undefined || value === null) return "—";
  if (Number(value) === 0) return "free/0";
  return `$${Number(value).toFixed(4)}`;
}

function registerPricesCommand(pi) {
  pi.registerCommand("model-prices", {
    description: "List model catalog prices per 1M tokens; optional provider filter",
    handler: async (args, ctx) => {
      const provider = (args || "").trim().split(/\\s+/).find((token) => OPENCODE_PROVIDER_IDS.includes(token));
      const models = (ctx.modelRegistry?.getAvailable?.() ?? []).filter((model) =>
        OPENCODE_PROVIDER_IDS.includes(model.provider) && (!provider || model.provider === provider),
      );
      const rows = models.sort((a, b) => a.provider === b.provider ? a.id.localeCompare(b.id) : a.provider.localeCompare(b.provider)).map((model) => ({
        provider: model.provider,
        id: model.id,
        input: model.cost?.input,
        output: model.cost?.output,
        total: (Number(model.cost?.input) || 0) + (Number(model.cost?.output) || 0),
        context: model.contextWindow ?? 0,
      }));
      const markdown = [
        `# Model catalog prices${provider ? ` (${provider})` : ""}`,
        "",
        "_Catalog values are USD per 1M tokens. Zero means the curated catalog marks the model free; `—` means no price metadata._",
        "",
        "| Provider | Model | Input | Output | Total | Context |",
        "|---|---|---:|---:|---:|---:|",
        ...rows.map((row) => `| ${row.provider} | ${row.id} | ${formatPrice(row.input)} | ${formatPrice(row.output)} | ${formatPrice(row.total)} | ${row.context ? `${Math.round(row.context / 1000)}K` : "—"} |`),
        "",
        rows.length ? "" : "_No registered models match the filter._",
      ].join("\n");
      showModelMarkdown(pi, ctx, "model-prices", markdown);
    },
  });
  pi.registerEntryRenderer("model-prices", (entry) => new Markdown(entry.data.markdown, 1, 0, getMarkdownTheme()));
}

function installUsageTracker(pi) {
  if (opencodeUsageHookInstalled || typeof pi.on !== "function") return;
  opencodeUsageHookInstalled = true;
  pi.on("message_end", (event) => {
    const message = event?.message;
    if (message?.role !== "assistant" || !OPENCODE_PROVIDER_IDS.includes(message.provider)) return;
    const key = `${message.provider}/${message.model}`;
    const previous = OPENCODE_SESSION_USAGE.get(key) ?? { provider: message.provider, model: message.model, input: 0, output: 0, total: 0, cost: 0, turns: 0 };
    const usage = message.usage ?? {};
    const cost = usage.cost ?? {};
    const turnInput = Number(usage.input) || 0;
    const turnOutput = Number(usage.output) || 0;
    const turnTotal = Number(usage.totalTokens) || turnInput + turnOutput;
    previous.input += turnInput;
    previous.output += turnOutput;
    previous.total += turnTotal;
    previous.cost += Number(cost.total) || 0;
    previous.turns += 1;
    OPENCODE_SESSION_USAGE.set(key, previous);
  });
}

function registerUsageCommand(pi) {
  pi.registerCommand("model-usage", {
    description: "Show model token/cost usage accumulated in the current Pi process",
    handler: async (_args, ctx) => {
      const rows = [...OPENCODE_SESSION_USAGE.values()].sort((a, b) => a.provider === b.provider ? a.model.localeCompare(b.model) : a.provider.localeCompare(b.provider));
      const total = rows.reduce((sum, row) => sum + row.cost, 0);
      const markdown = [
        "# Model session usage",
        "",
        "_This is process/session usage from assistant messages, not a provider billing dashboard. Provider billing APIs are not uniform._",
        "",
        "| Provider | Model | Turns | Input tokens | Output tokens | Total tokens | Cost |",
        "|---|---|---:|---:|---:|---:|---:|",
        ...rows.map((row) => `| ${row.provider} | ${row.model} | ${row.turns} | ${row.input.toLocaleString()} | ${row.output.toLocaleString()} | ${row.total.toLocaleString()} | $${row.cost.toFixed(6)} |`),
        "",
        rows.length ? `**Session total:** $${total.toFixed(6)}` : "_No assistant usage recorded in this Pi process yet._",
      ].join("\n");
      showModelMarkdown(pi, ctx, "model-usage", markdown);
    },
  });
  pi.registerEntryRenderer("model-usage", (entry) => new Markdown(entry.data.markdown, 1, 0, getMarkdownTheme()));
}

function registerCapabilitiesCommand(pi) {
  const flags = {
    reasoning: "reasoning",
    vision: "vision",
    image: "image",
    video: "video",
    audio: "audio",
    tools: "tools",
  };

  pi.registerCommand("model-capabilities", {
    description:
      "List model capabilities (vision/image/video/audio/tools/reasoning) across all providers; e.g. /model-capabilities vision",
    handler: async (args, ctx) => {
      const tokens = (args || "").trim().split(/\s+/).filter(Boolean);
      const filter = tokens.find((token) => token in flags);
      const models = (ctx.modelRegistry?.getAvailable?.() ?? []).filter((m) =>
        OPENCODE_PROVIDER_IDS.includes(m.provider),
      );

      const rows = models
        .map((model) => {
          const caps = model.capabilities ?? {};
          return {
            provider: model.provider,
            id: model.id,
            reasoning: caps.reasoning ? "✓" : "",
            vision: caps.vision ? "✓" : "",
            image: caps.image ? "✓" : "",
            video: caps.video ? "✓" : "",
            audio: caps.audio ? "✓" : "",
            tools: caps.tools ? "✓" : "",
          };
        })
        .filter((row) => !filter || row[flags[filter]] === "✓")
        .sort((a, b) =>
          a.provider === b.provider ? a.id.localeCompare(b.id) : a.provider.localeCompare(b.provider),
        );

      const markdown = [
        `# Model capabilities${filter ? ` (filter: ${filter})` : ""}`,
        "",
        "| Provider | Model | Reasoning | Vision | Image | Video | Audio | Tools |",
        "|---|---|:---:|:---:|:---:|:---:|:---:|:---:|",
        ...rows.map(
          (row) =>
            `| ${row.provider} | ${row.id} | ${row.reasoning || "—"} | ${row.vision || "—"} | ${row.image || "—"} | ${row.video || "—"} | ${row.audio || "—"} | ${row.tools || "—"} |`,
        ),
        "",
        "_Capabilities are derived from each curated model's reasoning/input fields; verified Agnes/SenseNova image models use their native generation endpoints._",
      ].join("\n");

      if (ctx.mode === "tui") {
        pi.appendEntry("model-capabilities", { markdown });
      } else if (ctx.hasUI) {
        ctx.ui.notify(markdown, "info");
      } else {
        console.log(markdown);
      }
    },
  });

  pi.registerEntryRenderer("model-capabilities", (entry) => {
    const mdTheme = getMarkdownTheme();
    return new Markdown(entry.data.markdown, 1, 0, mdTheme);
  });
}

// Background drift/probe pass. Best-effort: a failure leaves the already
// registered (curated or cached) models untouched, so the user is never blocked.
async function verifyAndUpdateModels(pi) {
  // Honor the same 24h cache TTL that loadCache() enforces at boot. Without
  // this guard the background probe runs unconditionally on every startup and
  // clobbers a previously-good catalog whenever a flaky-window 1-token probe
  // (e.g. Console 500 storms) fails a healthy model. A fresh cache means the
  // currently-registered catalog is authoritative; skip the re-probe entirely.
  if (loadCache()) return;
  // Overall safety net so a pathological network can never strand this task.
  const signal = AbortSignal.timeout(45000);
  const zenHeaders = {
    ...OPENCODE_STATIC_HEADERS,
    Authorization: `Bearer ${process.env.OPENCODE_API_KEY ?? "public"}`,
  };
  const [zenLive, sensenovaModels, siliconflowModels, modelscopeModels, nvidiaModels, agnesModels] = await Promise.all([
    fetchLiveModelIds("https://opencode.ai/zen/v1/models", zenHeaders),
    filterToLive(SENSENOVA_MODELS, "https://token.sensenova.cn/v1/models", authHeader("SENSENOVA_API_KEY")),
    filterToLive(SILICONFLOW_MODELS, "https://api.siliconflow.cn/v1/models", authHeader("SILICONFLOW_API_KEY")),
    filterToLive(MODELSCOPE_MODELS, "https://api-inference.modelscope.cn/v1/models", authHeader("MODELSCOPE_API_KEY")),
    filterToLive(NVIDIA_MODELS, "https://integrate.api.nvidia.com/v1/models", authHeader("NVIDIA_NIM_API_KEY")),
    filterToLive(AGNES_MODELS, "https://apihub.agnes-ai.com/v1/models", authHeader("AGNES_API_KEY")),
  ]);
  const zenModels = zenLive ? await verifyZenModels(zenLive) : ZEN_FREE_MODELS;
  const verified = {
    zen: zenModels,
    sensenova: sensenovaModels,
    siliconflow: siliconflowModels,
    modelscope: modelscopeModels,
    nvidia: nvidiaModels,
    cloudflare: CLOUDFLARE_MODELS,
    agnes: agnesModels,
  };
  registerAll(pi, verified);
  saveCache(verified);
}

// ── Extension entry ──
export default function (pi) {
  // Register immediately with the curated allowlists (or a fresh on-disk cache)
  // so Pi startup is never blocked on network model discovery. The live
  // drift/probe pass runs in the background and hot-swaps the catalog without a
  // /reload.
  registerAll(pi, initialModels());
  registerCapabilitiesCommand(pi);
  registerPricesCommand(pi);
  installUsageTracker(pi);
  registerUsageCommand(pi);
  setTimeout(() => {
    verifyAndUpdateModels(pi).catch(() => {});
  }, 100);
}