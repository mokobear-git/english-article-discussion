import http from "node:http";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import {
  SYSTEM_PROMPT,
  TRANSLATE_INSTRUCTION,
  SUMMARY_INSTRUCTION,
  TRANSLATE_CONTINUE,
  START_INSTRUCTION,
  START_INSTRUCTION_NO_QUESTIONS,
} from "./prompts.js";
import { mockStream } from "./mock.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const MODEL = process.env.MODEL || "claude-haiku-5-5";
const DIALOG_EFFORT = process.env.DIALOG_EFFORT || "low";
const TRANSLATE_EFFORT = process.env.TRANSLATE_EFFORT || "medium";
const FAST_MODE = process.env.FAST_MODE === "1";
const MOCK = process.env.MOCK === "1";
const APP_PASSWORD = process.env.APP_PASSWORD || "";
const DATA_DIR = path.join(here, "data", "sessions");
const PUBLIC_DIR = path.join(here, "public");
const MAX_BODY = 45 * 1024 * 1024;
const MAX_TRANSLATE_ROUNDS = 5;

const client = MOCK ? null : new Anthropic();

// Server-side refusal fallback ("default" routing) is available on these models.
const FALLBACK_MODELS = new Set([
  "claude-opus-5-5",
  "claude-opus-5",
  "claude-fable-5-1",
  "claude-sonnet-5-5",
]);
const FAST_MODELS = new Set(["claude-opus-5-5", "claude-opus-5", "claude-opus-4-8"]);
let fastAvailable = FAST_MODE && FAST_MODELS.has(MODEL);

// ---------------------------------------------------------------------------
// Session store (in memory, persisted to data/sessions/<id>.json)
// ---------------------------------------------------------------------------
const sessions = new Map();

async function loadSession(id) {
  if (!/^[a-f0-9-]{36}$/.test(id)) return null;
  if (sessions.has(id)) return sessions.get(id);
  const file = path.join(DATA_DIR, `${id}.json`);
  if (!existsSync(file)) return null;
  const s = JSON.parse(await fs.readFile(file, "utf8"));
  s.busy = false;
  sessions.set(id, s);
  return s;
}

async function saveSession(s) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const { busy, ...rest } = s;
  const file = path.join(DATA_DIR, `${s.id}.json`);
  await fs.writeFile(file + ".tmp", JSON.stringify(rest));
  await fs.rename(file + ".tmp", file);
}

// ---------------------------------------------------------------------------
// Request building
// ---------------------------------------------------------------------------
function docBlocks(s) {
  const blocks = [];
  for (const d of s.docs) {
    const title = d.role === "paper" ? "論文" : "設問";
    const label = d.name ? `${title}: ${d.name}` : title;
    if (d.kind === "pdf") {
      blocks.push({
        type: "document",
        source: { type: "base64", media_type: "application/pdf", data: d.data },
        title: label,
      });
    } else if (d.kind === "image") {
      blocks.push({ type: "text", text: `【${label}(画像)】` });
      blocks.push({ type: "image", source: { type: "base64", media_type: d.mime, data: d.data } });
    } else {
      blocks.push({
        type: "document",
        source: { type: "text", media_type: "text/plain", data: d.text },
        title: label,
      });
    }
  }
  // Cache breakpoint after the documents: shared by translation and dialogue.
  blocks[blocks.length - 1] = { ...blocks[blocks.length - 1], cache_control: { type: "ephemeral" } };
  return blocks;
}

function baseParams(effort, maxTokens) {
  const params = {
    model: MODEL,
    max_tokens: maxTokens,
    system: SYSTEM_PROMPT,
    output_config: { effort },
    // Automatic caching of the growing conversation prefix.
    cache_control: { type: "ephemeral" },
  };
  const betas = [];
  if (FALLBACK_MODELS.has(MODEL)) {
    params.fallbacks = "default";
    betas.push("server-side-fallback-2026-07-01");
  }
  if (fastAvailable) {
    params.speed = "fast";
    betas.push("fast-mode-2026-02-01");
  }
  if (betas.length) params.betas = betas;
  return params;
}

function startInstruction(s) {
  return s.autoQuestions ? START_INSTRUCTION_NO_QUESTIONS(s.autoQuestions) : START_INSTRUCTION;
}

function dialogueMessages(s, pendingUser) {
  const msgs = [
    { role: "user", content: [...docBlocks(s), { type: "text", text: startInstruction(s) }] },
    ...s.history,
  ];
  if (pendingUser) msgs.push(pendingUser);
  return msgs;
}

const META_RE = /<<<META\s*(\{[\s\S]*?\})\s*>>>/g;

function splitMeta(text) {
  let meta = null;
  for (const m of text.matchAll(META_RE)) {
    try {
      meta = JSON.parse(m[1]);
    } catch {
      /* ignore malformed meta */
    }
  }
  const visible = text.replace(META_RE, "").replace(/<<<META[\s\S]*$/, "").trim();
  return { visible, meta };
}

function textOf(content) {
  if (typeof content === "string") return content;
  return content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");
}

function applyMeta(s, meta) {
  if (!meta) return;
  s.meta = meta;
  const q = Number(meta.q) || 0;
  if (!q) return;
  s.record[q] ??= { summary_ja: "", sentences: [], final_en: "" };
  const r = s.record[q];
  if (meta.question) r.question = meta.question;
  if (meta.summary_ja) {
    r.summary_ja = meta.summary_ja;
    r.sentences = [];
  }
  if (meta.accepted?.en) r.sentences.push({ ja: meta.accepted.ja || "", en: meta.accepted.en });
  if (meta.final_en) r.final_en = meta.final_en;
}

// ---------------------------------------------------------------------------
// Streaming helpers
// ---------------------------------------------------------------------------
function sseStart(res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders?.();
  return (event, data) => {
    if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data ?? {})}\n\n`);
  };
}

/**
 * Runs one streamed request. Calls onText for each text delta.
 * Returns { content, stopReason } or throws. `aborted()` is polled.
 */
async function runStream(params, { onText, onThinking, signalRef }) {
  if (MOCK) return mockStream(params, { onText, signalRef });

  const attempt = async (p) => {
    const stream = client.beta.messages.stream(p);
    signalRef.abort = () => stream.abort();
    let thinkingNotified = false;
    for await (const event of stream) {
      if (event.type === "content_block_start" && event.content_block.type === "thinking") {
        if (!thinkingNotified) onThinking?.();
        thinkingNotified = true;
      } else if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        onText(event.delta.text);
      }
    }
    const final = await stream.finalMessage();
    return { content: final.content, stopReason: final.stop_reason, usage: final.usage };
  };

  try {
    return await attempt(params);
  } catch (err) {
    // Fast mode has its own rate limits; fall back to standard speed once.
    if (params.speed === "fast" && err instanceof Anthropic.APIError && !signalRef.aborted) {
      if (err instanceof Anthropic.BadRequestError) fastAvailable = false;
      const { speed, ...rest } = params;
      rest.betas = (rest.betas || []).filter((b) => b !== "fast-mode-2026-02-01");
      if (!rest.betas.length) delete rest.betas;
      return attempt(rest);
    }
    throw err;
  }
}

function errorMessage(err) {
  if (err instanceof Anthropic.AuthenticationError) return "APIキーが無効。ANTHROPIC_API_KEY を確認。";
  if (err instanceof Anthropic.RateLimitError) return "レート制限。少し待って再試行。";
  if (err instanceof Anthropic.BadRequestError) return `リクエストエラー: ${err.message}`;
  if (err instanceof Anthropic.APIError) return `APIエラー ${err.status ?? ""}: ${err.message}`;
  return String(err?.message || err);
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------
async function createSession(body) {
  const docs = [];
  for (const role of ["paper", "questions"]) {
    for (const f of body[role] || []) {
      if (f.kind === "text" && f.text?.trim()) docs.push({ role, kind: "text", name: f.name || "", text: f.text });
      else if (f.kind === "pdf" && f.data) docs.push({ role, kind: "pdf", name: f.name || "", data: f.data });
      else if (f.kind === "image" && f.data && /^image\/(png|jpeg|gif|webp)$/.test(f.mime))
        docs.push({ role, kind: "image", name: f.name || "", mime: f.mime, data: f.data });
    }
  }
  if (!docs.some((d) => d.role === "paper")) throw new Error("論文が空。");
  const hasQuestions = docs.some((d) => d.role === "questions");
  const s = {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    title: body.title || docs.find((d) => d.role === "paper")?.name || "論文",
    docs,
    translateMode: MODES.has(body.translateMode) ? body.translateMode : "full",
    autoQuestions: hasQuestions ? 0 : Math.min(5, Math.max(1, Number(body.autoQuestions) || 3)),
    translation: "",
    translationDone: false,
    history: [],
    record: {},
    meta: null,
    busy: false,
  };
  sessions.set(s.id, s);
  await saveSession(s);
  return s;
}

function publicState(s) {
  const transcript = [];
  for (const m of s.history) {
    if (m.role === "user") transcript.push({ role: "user", text: textOf(m.content) });
    else transcript.push({ role: "assistant", text: splitMeta(textOf(m.content)).visible });
  }
  return {
    id: s.id,
    title: s.title,
    autoQuestions: s.autoQuestions || 0,
    translation: s.translation,
    translationDone: s.translationDone,
    translateMode: s.translateMode || "full",
    started: s.history.length > 0,
    transcript,
    record: s.record,
    meta: s.meta,
  };
}

const MODES = new Set(["full", "summary", "none"]);

async function handleTranslate(s, body, req, res) {
  const send = sseStart(res);
  // Requests can arrive out of order when the user switches modes quickly: newest wins.
  const seq = Number(body.seq) || 0;
  if (seq && seq < (s.trSeq || 0)) {
    send("done", { stopReason: "stale" });
    return res.end();
  }
  if (seq) s.trSeq = seq;
  const mode = MODES.has(body.mode) ? body.mode : s.translateMode || "full";
  if (mode !== (s.translateMode || "full")) {
    s.trAbort?.();
    s.trGen = (s.trGen || 0) + 1;
    s.translateMode = mode;
    s.translationDone = false;
    s.translation = "";
  }
  s.translateMode ||= "full";
  if (s.translateMode === "none") {
    s.translation = "";
    s.translationDone = true;
    await saveSession(s);
    send("done", { stopReason: "end_turn" });
    return res.end();
  }
  if (s.translationDone) {
    send("delta", { text: s.translation });
    send("done", { stopReason: "end_turn" });
    return res.end();
  }
  // Only the newest translation request may write (mode switches abort the old one).
  s.trAbort?.();
  const gen = (s.trGen = (s.trGen || 0) + 1);
  const current = () => s.trGen === gen;
  const signalRef = { aborted: false };
  const abortMine = () => {
    signalRef.aborted = true;
    signalRef.abort?.();
  };
  s.trAbort = abortMine;
  res.on("close", () => {
    if (!res.writableFinished) abortMine();
  });

  s.translation = "";
  const messages = [
    {
      role: "user",
      content: [
        ...docBlocks(s),
        { type: "text", text: s.translateMode === "summary" ? SUMMARY_INSTRUCTION : TRANSLATE_INSTRUCTION },
      ],
    },
  ];
  try {
    for (let round = 0; round < MAX_TRANSLATE_ROUNDS; round++) {
      const result = await runStream(
        { ...baseParams(TRANSLATE_EFFORT, 64000), messages },
        {
          signalRef,
          onThinking: () => send("thinking", {}),
          onText: (t) => {
            if (!current()) return;
            s.translation += t;
            send("delta", { text: t });
          },
        },
      );
      if (!current()) break;
      if (result.stopReason === "refusal") {
        send("error", { message: "モデルが応答を拒否した(refusal)。" });
        break;
      }
      if (result.stopReason !== "max_tokens") {
        s.translationDone = true;
        break;
      }
      messages.push({ role: "assistant", content: result.content });
      messages.push({ role: "user", content: TRANSLATE_CONTINUE });
      s.translation += "\n\n";
      send("delta", { text: "\n\n" });
    }
    send("done", { stopReason: s.translationDone ? "end_turn" : "incomplete" });
  } catch (err) {
    if (!signalRef.aborted) send("error", { message: errorMessage(err) });
  } finally {
    if (s.trAbort === abortMine) s.trAbort = null;
    await saveSession(s);
    res.end();
  }
}

async function handleTurn(s, body, req, res) {
  if (s.busy) {
    // A newer turn supersedes the running one (barge-in).
    s.currentAbort?.();
    for (let i = 0; i < 50 && s.busy; i++) await new Promise((r) => setTimeout(r, 40));
    if (s.busy) {
      res.writeHead(409).end("busy");
      return;
    }
  }
  const isStart = !!body.start;
  const userText = String(body.text || "").trim();
  if (isStart && s.history.length) {
    // Already started: replay the existing first reply.
    const send = sseStart(res);
    send("done", { text: publicState(s).transcript.at(-1)?.text || "", meta: s.meta, replay: true });
    return res.end();
  }
  if (!isStart && !userText) {
    res.writeHead(400).end("empty");
    return;
  }

  s.busy = true;
  const send = sseStart(res);
  const signalRef = { aborted: false };
  s.currentAbort = () => {
    signalRef.aborted = true;
    signalRef.abort?.();
  };
  res.on("close", () => {
    if (!res.writableFinished) s.currentAbort?.();
  });

  let pendingUser = null;
  if (!isStart) {
    const last = s.history.at(-1);
    if (last?.role === "user") {
      // Previous user message never got a reply: merge (nothing depends on it yet).
      s.history.pop();
      pendingUser = { role: "user", content: `${textOf(last.content)}\n${userText}` };
    } else {
      pendingUser = { role: "user", content: userText };
    }
    s.history.push(pendingUser);
  }

  let streamed = "";
  try {
    const result = await runStream(
      { ...baseParams(DIALOG_EFFORT, 16000), messages: dialogueMessages(s) },
      {
        signalRef,
        onThinking: () => send("thinking", {}),
        onText: (t) => {
          streamed += t;
          send("delta", { text: t });
        },
      },
    );
    if (result.stopReason === "refusal") {
      if (pendingUser) s.history.pop();
      send("error", { message: "モデルが応答を拒否した(refusal)。言い換えて再入力。" });
    } else {
      // Keep the full content (incl. thinking blocks) unchanged: append-only history.
      s.history.push({ role: "assistant", content: result.content });
      const { visible, meta } = splitMeta(textOf(result.content));
      applyMeta(s, meta);
      send("done", { text: visible, meta, record: s.record });
    }
  } catch (err) {
    if (signalRef.aborted) {
      if (streamed.trim()) {
        const { visible } = splitMeta(streamed);
        s.history.push({
          role: "assistant",
          content: [{ type: "text", text: `${visible}\n(学習者の発話で中断)` }],
        });
      }
      // else: leave the user message; the next turn merges into it.
    } else {
      if (pendingUser && s.history.at(-1) === pendingUser) s.history.pop();
      send("error", { message: errorMessage(err) });
    }
  } finally {
    s.busy = false;
    s.currentAbort = null;
    await saveSession(s);
    res.end();
  }
}

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".webmanifest": "application/manifest+json",
};

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) throw Object.assign(new Error("ファイルが大きすぎる(上限45MB)。"), { status: 413 });
    chunks.push(c);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}

function json(res, status, obj) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
}

async function serveStatic(req, res) {
  const url = new URL(req.url, "http://x");
  let p = decodeURIComponent(url.pathname);
  if (p === "/") p = "/index.html";
  const file = path.normalize(path.join(PUBLIC_DIR, p));
  if (!file.startsWith(PUBLIC_DIR) || !existsSync(file)) {
    res.writeHead(404).end("not found");
    return;
  }
  res.writeHead(200, {
    "Content-Type": MIME[path.extname(file)] || "application/octet-stream",
    "Cache-Control": "no-cache",
  });
  res.end(await fs.readFile(file));
}

// Optional shared password (HTTP Basic auth) for public deployments.
function authorized(req) {
  if (!APP_PASSWORD) return true;
  const h = req.headers.authorization || "";
  if (!h.startsWith("Basic ")) return false;
  const pass = Buffer.from(h.slice(6), "base64").toString("utf8").split(":").slice(1).join(":");
  const a = Buffer.from(pass);
  const b = Buffer.from(APP_PASSWORD);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const server = http.createServer(async (req, res) => {
  if (req.url === "/healthz") {
    res.writeHead(200).end("ok");
    return;
  }
  if (!authorized(req)) {
    res.writeHead(401, { "WWW-Authenticate": 'Basic realm="paper-discussion", charset="UTF-8"' });
    res.end("password required");
    return;
  }
  try {
    const url = new URL(req.url, "http://x");
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts[0] !== "api") return serveStatic(req, res);

    if (req.method === "GET" && parts[1] === "config") {
      return json(res, 200, { model: MODEL, mock: MOCK, fast: fastAvailable });
    }
    if (req.method === "POST" && parts[1] === "session" && parts.length === 2) {
      const s = await createSession(await readJson(req));
      return json(res, 200, { id: s.id });
    }
    if (parts[1] === "session" && parts[2]) {
      const s = await loadSession(parts[2]);
      if (!s) return json(res, 404, { error: "session not found" });
      if (req.method === "GET" && parts.length === 3) return json(res, 200, publicState(s));
      if (req.method === "POST" && parts[3] === "translate") return handleTranslate(s, await readJson(req), req, res);
      if (req.method === "POST" && parts[3] === "turn") return handleTurn(s, await readJson(req), req, res);
    }
    json(res, 404, { error: "not found" });
  } catch (err) {
    console.error(err);
    if (!res.headersSent) json(res, err.status || 400, { error: String(err.message || err) });
    else res.end();
  }
});

server.listen(PORT, () => {
  console.log(`http://localhost:${PORT}  model=${MODEL}${MOCK ? " (MOCK)" : ""}${fastAvailable ? " fast" : ""}${APP_PASSWORD ? " password" : ""}`);
});
