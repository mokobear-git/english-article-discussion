// =========================================================================
// 論文ディスカッション — フロントエンド
//   音声認識: Web Speech API (SpeechRecognition) — 途中結果を即時表示
//   読み上げ: speechSynthesis — ストリーミング中に文単位で即時読み上げ
//   通信:     fetch + Server-Sent Events(POST)
// =========================================================================

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

// ---------------------------------------------------------------- settings
// ttsMode: "answer" = 確定した推奨英文のみ / "all" = 応答をすべて / "off" = 読み上げなし
const DEFAULTS = { ttsMode: "answer", rate: 1.0, silenceMs: 1100, bargeIn: false, autoLang: true, voiceJa: "", voiceEn: "" };
const settings = (() => {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem("settings") || "{}") };
  } catch {
    return { ...DEFAULTS };
  }
})();
function saveSettings() {
  try {
    localStorage.setItem("settings", JSON.stringify(settings));
  } catch {}
}
const store = {
  get(k) {
    try { return localStorage.getItem(k); } catch { return null; }
  },
  set(k, v) {
    try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {}
  },
};

// ---------------------------------------------------------------- state
const state = {
  sessionId: null,
  translation: "",
  translationDone: false,
  mode: "full",
  started: false,
  startTurn: null,
  turn: null,
  record: {},
  meta: null,
  conv: false,
  lang: "ja",
  files: { paper: [], questions: [] },
};
const isBusy = () => !!(state.turn && !state.turn.done);

// ---------------------------------------------------------------- SSE over POST
async function postSSE(url, body, handlers, signal) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
    signal,
  });
  if (!res.ok) throw new Error((await res.text()) || `HTTP ${res.status}`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const chunk = buf.slice(0, i);
      buf = buf.slice(i + 2);
      let ev = "message";
      let data = "";
      for (const line of chunk.split("\n")) {
        if (line.startsWith("event:")) ev = line.slice(6).trim();
        else if (line.startsWith("data:")) data += line.slice(5).trim();
      }
      handlers[ev]?.(data ? JSON.parse(data) : {});
    }
  }
}

// ---------------------------------------------------------------- text utils
const META_START = "<<<";
function visiblePart(full) {
  const i = full.indexOf(META_START);
  if (i >= 0) return full.slice(0, i);
  return full.replace(/<{1,2}$/, ""); // hold back a possibly incomplete marker
}
const hasJa = (t) => /[぀-ヿ㐀-鿿！-～]/.test(t);
function cleanForSpeech(t) {
  return t
    .replace(/[#*`_>|]/g, "")
    .replace(/[「」『』“”"]/g, "")
    .replace(/→|⇒/g, "、")
    .replace(/\s+/g, " ")
    .trim();
}
const ABBR = /(e\.g|i\.e|vs|et al|Fig|Figs|No|approx|Dr|cf)$/i;
function findBoundary(s) {
  let segStart = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    let hit = false;
    if (c === "\n" || "。！？".includes(c)) hit = true;
    else if (".!?".includes(c)) {
      if (i + 1 >= s.length) return -1; // wait to see the next char
      if (/\s/.test(s[i + 1]) && !(c === "." && ABBR.test(s.slice(Math.max(0, i - 7), i)))) hit = true;
    }
    if (!hit) continue;
    if (c !== "\n" && i - segStart < 3) continue; // avoid "1." / "A." fragments
    let j = i;
    while (j + 1 < s.length && "」』）)\"'”".includes(s[j + 1])) j++;
    return j;
  }
  return -1;
}
function escapeHtml(t) {
  return t.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
function renderMarkdown(md) {
  return md
    .split(/\n{2,}/)
    .map((block) => {
      const b = block.trim();
      if (!b) return "";
      const inline = (t) => escapeHtml(t).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>").replace(/\n/g, "<br>");
      if (b.startsWith("### ")) return `<h3>${inline(b.slice(4))}</h3>`;
      if (b.startsWith("## ")) return `<h2>${inline(b.slice(3))}</h2>`;
      if (b.startsWith("# ")) return `<h2>${inline(b.slice(2))}</h2>`;
      return `<p>${inline(b)}</p>`;
    })
    .join("");
}

// ---------------------------------------------------------------- voices
let voices = [];
function loadVoices() {
  voices = window.speechSynthesis ? speechSynthesis.getVoices() : [];
  fillVoiceSelect($("#set-voice-ja"), "ja", settings.voiceJa);
  fillVoiceSelect($("#set-voice-en"), "en", settings.voiceEn);
}
const PREFERRED = /Google|Natural|Online|Siri|Enhanced|Premium|Kyoko|O-ren|Samantha|Aria|Nanami/i;
function candidates(lang) {
  const list = voices.filter((v) => v.lang.toLowerCase().startsWith(lang));
  if (lang === "en") list.sort((a, b) => (b.lang === "en-US") - (a.lang === "en-US"));
  return list.sort((a, b) => PREFERRED.test(b.name) - PREFERRED.test(a.name));
}
function pickVoice(lang) {
  const name = lang === "ja" ? settings.voiceJa : settings.voiceEn;
  return voices.find((v) => v.name === name) || candidates(lang)[0] || null;
}
function fillVoiceSelect(sel, lang, current) {
  if (!sel) return;
  const list = candidates(lang);
  sel.innerHTML = `<option value="">自動</option>` + list.map((v) => `<option>${escapeHtml(v.name)}</option>`).join("");
  sel.value = list.some((v) => v.name === current) ? current : "";
}

// ---------------------------------------------------------------- Speaker (TTS)
class Speaker {
  constructor() {
    this.consumed = 0;
    this.pending = 0;
    this.ended = true;
    this.gen = 0;
    this.onIdle = null;
    this.onChange = null;
  }
  get speaking() {
    return this.pending > 0;
  }
  reset() {
    this.cancel();
    this.consumed = 0;
    this.ended = false;
  }
  feed(text, final = false) {
    if (window.speechSynthesis) {
      let rest = text.slice(this.consumed);
      let idx;
      while ((idx = findBoundary(rest)) >= 0) {
        const sentence = rest.slice(0, idx + 1);
        this.consumed += sentence.length;
        rest = rest.slice(idx + 1);
        this.say(sentence);
      }
      if (final && rest.trim()) {
        this.consumed += rest.length;
        this.say(rest);
      }
    }
    if (final) {
      this.ended = true;
      this.check();
    }
  }
  say(t) {
    const clean = cleanForSpeech(t);
    if (!clean || !/[\p{L}\p{N}]/u.test(clean)) return;
    const u = new SpeechSynthesisUtterance(clean);
    const ja = hasJa(clean);
    u.lang = ja ? "ja-JP" : "en-US";
    const v = pickVoice(ja ? "ja" : "en");
    if (v) u.voice = v;
    u.rate = settings.rate;
    const g = this.gen;
    this.pending++;
    this.onChange?.();
    u.onend = u.onerror = () => {
      if (g !== this.gen) return;
      this.pending = Math.max(0, this.pending - 1);
      this.onChange?.();
      this.check();
    };
    speechSynthesis.speak(u);
  }
  cancel() {
    this.gen++;
    this.pending = 0;
    if (window.speechSynthesis) speechSynthesis.cancel();
    this.onChange?.();
  }
  hush() {
    this.cancel();
    this.ended = true;
    this.check();
  }
  check() {
    if (this.ended && this.pending === 0) this.onIdle?.();
  }
}
const speaker = new Speaker();

// ---------------------------------------------------------------- Listener (STT)
class Listener {
  constructor() {
    this.SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    this.want = false;
    this.rec = null;
    this.running = false;
    this.lang = "ja-JP";
    this.finalText = "";
    this.interim = "";
    this.timer = null;
    this.onText = () => {};
    this.onSubmit = () => {};
    this.onState = () => {};
    this.onError = () => {};
  }
  get supported() {
    return !!this.SR;
  }
  start(lang) {
    if (!this.supported) return;
    if (lang && lang !== this.lang) {
      this.lang = lang;
      this.kill();
    }
    this.want = true;
    this.spawn();
  }
  stop() {
    this.want = false;
    this.kill();
  }
  setLang(lang) {
    if (lang === this.lang) return;
    this.lang = lang;
    if (this.want) {
      this.kill();
      this.spawn();
    }
  }
  spawn() {
    if (this.rec || !this.want) return;
    const r = new this.SR();
    r.lang = this.lang;
    r.continuous = true;
    r.interimResults = true;
    r.maxAlternatives = 1;
    r.onstart = () => {
      this.running = true;
      this.onState();
    };
    r.onresult = (e) => {
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        if (res.isFinal) this.finalText += res[0].transcript;
        else interim += res[0].transcript;
      }
      this.interim = interim;
      const t = (this.finalText + interim).trim();
      if (t) this.onText(t);
      this.arm();
    };
    r.onerror = (e) => {
      if (e.error === "not-allowed" || e.error === "service-not-allowed") {
        this.want = false;
        this.onError("マイクの使用が許可されていない。ブラウザの設定を確認。");
      } else if (e.error === "audio-capture") {
        this.onError("マイクが見つからない。");
      }
    };
    r.onend = () => {
      if (this.rec === r) {
        this.rec = null;
        this.running = false;
        this.onState();
      }
      if (this.want) setTimeout(() => this.spawn(), 100); // Chrome ends sessions on its own
    };
    this.rec = r;
    try {
      r.start();
    } catch {
      this.rec = null;
    }
  }
  kill() {
    clearTimeout(this.timer);
    const r = this.rec;
    this.rec = null;
    this.running = false;
    if (r) {
      r.onend = r.onresult = r.onerror = null;
      try {
        r.abort();
      } catch {}
    }
    this.finalText = "";
    this.interim = "";
    this.onState();
  }
  // Submit after a short silence (no new result for silenceMs).
  arm() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      const t = (this.finalText + this.interim).trim();
      if (!t) return;
      this.kill(); // drop recogniser buffer, start fresh for next utterance
      this.onSubmit(t);
      if (this.want) this.spawn();
    }, settings.silenceMs);
  }
}
const listener = new Listener();
const langCode = (l) => (l === "en" ? "en-US" : "ja-JP");

// ---------------------------------------------------------------- DOM helpers
const log = $("#log");
function scrollLog() {
  log.scrollTop = log.scrollHeight;
}
function addBubble(role, text = "", cls = "") {
  const div = document.createElement("div");
  div.className = `msg ${role} ${cls}`.trim();
  div.textContent = text;
  log.appendChild(div);
  scrollLog();
  return div;
}
function addSayButton(bubble) {
  const b = document.createElement("button");
  b.className = "say";
  b.textContent = "▶ 読む";
  b.onclick = () => {
    speaker.reset();
    speaker.feed(bubble.dataset.text || "", true);
  };
  bubble.prepend(b);
}
function setBubbleText(bubble, text) {
  bubble.dataset.text = text;
  const btn = bubble.querySelector(".say");
  bubble.textContent = text;
  if (btn) bubble.prepend(btn);
}

let draft = null;
function showDraft(text) {
  if (!draft) draft = addBubble("user", "", "draft");
  draft.textContent = text;
  scrollLog();
}
function clearDraft() {
  draft?.remove();
  draft = null;
}

function setStatus() {
  const mic = $("#btn-mic");
  mic.setAttribute("aria-pressed", String(state.conv));
  mic.classList.toggle("listening", listener.running);
  $("#mic-label").textContent = state.conv ? (listener.running ? "聞き取り中" : "会話 ON") : "会話";
  $("#go-bar").hidden = state.started || document.body.dataset.view !== "study";
  const live = $("#live");
  let msg = "";
  if (isBusy()) msg = state.turn.full ? "応答中…" : "考え中…";
  else if (speaker.speaking) msg = settings.bargeIn ? "読み上げ中(話すと止まる)" : "読み上げ中";
  else if (state.conv && listener.running) msg = `聞き取り中(${state.lang === "en" ? "English" : "日本語"})…`;
  else if (state.conv) msg = "待機中";
  else msg = listener.supported ? "会話モードをONにすると音声で回答できる" : "このブラウザは音声認識に非対応。Chrome / Edge / Safari を推奨。";
  live.textContent = msg;
  live.classList.toggle("hearing", state.conv && listener.running);
}
speaker.onChange = setStatus;
listener.onState = setStatus;

function setLang(l) {
  state.lang = l;
  $$("#lang-seg button").forEach((b) => b.classList.toggle("on", b.dataset.lang === l));
  listener.setLang(langCode(l));
  setStatus();
}

// ---------------------------------------------------------------- screen wake lock (phones)
let wakeLock = null;
async function updateWakeLock() {
  try {
    if (state.conv && document.visibilityState === "visible" && "wakeLock" in navigator) {
      if (!wakeLock) {
        wakeLock = await navigator.wakeLock.request("screen");
        wakeLock.addEventListener("release", () => (wakeLock = null));
      }
    } else if (wakeLock) {
      await wakeLock.release();
      wakeLock = null;
    }
  } catch {
    wakeLock = null;
  }
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") {
    listener.stop();
    speaker.hush();
  } else {
    resumeListening();
  }
  updateWakeLock();
});

// ---------------------------------------------------------------- listening control
function resumeListening() {
  if (!state.conv || !listener.supported || !state.started) return;
  if (isBusy() || (speaker.speaking && !settings.bargeIn)) return;
  listener.start(langCode(state.lang));
}
function pauseListening() {
  if (settings.bargeIn) return;
  listener.stop();
}
speaker.onIdle = () => {
  setStatus();
  resumeListening();
};

listener.onText = (t) => {
  if (!state.started) return;
  if (speaker.speaking && settings.bargeIn) speaker.hush();
  showDraft(t);
};
listener.onSubmit = (t) => submitUser(t, { fromVoice: true });
listener.onError = (m) => {
  state.conv = false;
  updateWakeLock();
  addBubble("assistant", m, "error");
  setStatus();
};

// ---------------------------------------------------------------- meta → UI
const PHASE_LABEL = {
  steps: "スモールステップ",
  confirm: "確認",
  english: "英訳練習",
  q_done: "設問完了",
  done: "全設問完了",
};
function applyMetaUI(meta) {
  if (meta) state.meta = meta;
  const m = state.meta || {};
  const prog = $("#progress");
  if (m.q) {
    prog.innerHTML = `<b>設問 ${m.q}${m.total_q ? ` / ${m.total_q}` : ""}</b>  ${PHASE_LABEL[m.phase] || ""}${m.progress ? `  ${escapeHtml(m.progress)}` : ""}`;
  } else prog.textContent = state.started ? "" : "訳文の確認";

  const box = $("#choices");
  box.innerHTML = "";
  if (!isBusy()) {
    for (const c of m.choices || []) {
      const b = document.createElement("button");
      b.textContent = c;
      b.onclick = () => submitUser(c);
      box.appendChild(b);
    }
  }
  const target = $("#target");
  if (m.phase === "english" && m.target_ja) {
    target.hidden = false;
    $("#target-text").textContent = m.target_ja;
    $("#target-progress").textContent = m.progress || "";
  } else target.hidden = true;

  if (meta && settings.autoLang && meta.expect) setLang(meta.expect === "en" ? "en" : "ja");
}

function renderRecord() {
  const el = $("#record");
  const qs = Object.keys(state.record).map(Number).sort((a, b) => a - b);
  if (!qs.length) {
    el.innerHTML = `<p class="muted">設問ごとの日本語解答と、確定した英文がここにたまる。</p>`;
    return;
  }
  el.innerHTML = qs
    .map((q) => {
      const r = state.record[q];
      const pairs = (r.sentences || [])
        .map((p) => `<div class="pair"><div class="ja">${escapeHtml(p.ja)}</div><div class="en speak" title="タップで読み上げ">${escapeHtml(p.en)}</div></div>`)
        .join("");
      return `<div class="q-block"><h3>設問 ${q}</h3>
        ${r.summary_ja ? `<p>${escapeHtml(r.summary_ja).replace(/\n/g, "<br>")}</p>` : ""}
        ${pairs}
        ${r.final_en ? `<p><strong>完成版</strong><br><span class="speak" title="タップで読み上げ">${escapeHtml(r.final_en)}</span></p>` : ""}</div>`;
    })
    .join("");
}

function exportMarkdown() {
  const qs = Object.keys(state.record).map(Number).sort((a, b) => a - b);
  let md = `# 論文ディスカッション記録\n\n`;
  for (const q of qs) {
    const r = state.record[q];
    md += `## 設問 ${q}\n\n### 日本語解答\n\n${r.summary_ja || ""}\n\n### 英訳\n\n`;
    for (const p of r.sentences || []) md += `- ${p.ja}\n  - ${p.en}\n`;
    if (r.final_en) md += `\n### 完成版\n\n${r.final_en}\n`;
    md += "\n";
  }
  if (state.translation) md += `---\n\n# 訳文\n\n${state.translation}\n`;
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([md], { type: "text/markdown" }));
  a.download = `discussion-${new Date().toISOString().slice(0, 10)}.md`;
  a.click();
  URL.revokeObjectURL(a.href);
}

// ---------------------------------------------------------------- turns
function beginTurn(body, { revealed = true } = {}) {
  const turn = {
    ctrl: new AbortController(),
    full: "",
    revealed,
    done: false,
    aborted: false,
    error: null,
    meta: null,
    bubble: addBubble("assistant", "", "thinking"),
  };
  turn.bubble.hidden = !revealed;
  if (revealed) {
    state.turn = turn;
    speaker.reset();
  }
  applyMetaUI(null); // hide choices while busy
  setStatus();

  postSSE(
    `/api/session/${state.sessionId}/turn`,
    body,
    {
      delta({ text }) {
        turn.full += text;
        renderTurn(turn);
      },
      done(d) {
        if (!turn.full && d.text) turn.full = d.text;
        turn.meta = d.meta || null;
        if (d.record) state.record = d.record;
      },
      error(e) {
        turn.error = e.message || "エラー";
      },
    },
    turn.ctrl.signal,
  )
    .catch((err) => {
      if (!turn.aborted) turn.error = String(err.message || err);
    })
    .finally(() => {
      turn.done = true;
      if (turn.revealed) finishTurn(turn);
    });
  return turn;
}

let rafPending = false;
function renderTurn(turn) {
  if (!turn.revealed) return;
  const vis = visiblePart(turn.full);
  if (vis.trim()) turn.bubble.classList.remove("thinking");
  if (!rafPending) {
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      setBubbleText(turn.bubble, visiblePart(turn.full).trim());
      scrollLog();
      setStatus();
    });
  }
  if (state.turn === turn && settings.ttsMode === "all") speaker.feed(vis);
}

function finishTurn(turn) {
  turn.bubble.classList.remove("thinking");
  const vis = visiblePart(turn.full).trim();
  if (turn.aborted) {
    setBubbleText(turn.bubble, vis ? `${vis} …(中断)` : "(中断)");
    if (!vis) turn.bubble.remove();
    return;
  }
  setBubbleText(turn.bubble, vis);
  addSayButton(turn.bubble);
  if (turn.error) addBubble("assistant", turn.error, "error");
  if (!vis && !turn.error) turn.bubble.remove();
  renderRecord();
  if (state.turn === turn) {
    applyMetaUI(turn.meta);
    const answer = turn.meta?.accepted?.en;
    if (settings.ttsMode === "all") speaker.feed(visiblePart(turn.full), true);
    else if (settings.ttsMode === "answer" && answer) {
      // 推奨される英文(確定英文)だけを英語で読み上げる
      speaker.reset();
      speaker.feed(answer, true);
    } else speaker.feed("", true); // 読み上げなし → すぐ聞き取りへ
  }
  scrollLog();
  setStatus();
}

function revealStartTurn() {
  if (!state.startTurn) state.startTurn = beginTurn({ start: true }, { revealed: false });
  const turn = state.startTurn;
  state.started = true;
  $("#gate").hidden = true;
  setComposeEnabled(true);
  turn.revealed = true;
  turn.bubble.hidden = false;
  state.turn = turn;
  speaker.reset();
  renderTurn(turn);
  if (turn.done) finishTurn(turn);
  setStatus();
}

function submitUser(text, { fromVoice = false } = {}) {
  text = String(text || "").trim();
  if (!text || !state.started) return;
  // Barge-in: abort the running turn (server keeps the partial reply).
  if (isBusy()) {
    state.turn.aborted = true;
    state.turn.ctrl.abort();
  }
  speaker.cancel();
  if (draft && fromVoice) {
    draft.classList.remove("draft");
    draft.textContent = text;
    draft = null;
  } else {
    clearDraft();
    addBubble("user", text);
  }
  $("#choices").innerHTML = "";
  pauseListening();
  beginTurn({ text });
}

function setComposeEnabled(on) {
  $("#input").disabled = !on;
  $("#input").placeholder = on ? "入力して Enter(音声も可)" : "「設問へ進む」を押すと入力できる";
  $("#compose button").disabled = !on;
  $("#btn-hint").disabled = !on;
}

// ---------------------------------------------------------------- translation
let trRaf = false;
function renderTranslation() {
  if (trRaf) return;
  trRaf = true;
  requestAnimationFrame(() => {
    trRaf = false;
    const el = $("#panel-translation");
    if (state.mode === "none") {
      el.innerHTML = `<p class="muted">訳文・要約は表示しない設定。上の「全文訳」「要約」で後から表示できる。「設問へ進む」で始める。</p>`;
      return;
    }
    el.innerHTML = renderMarkdown(state.translation) || `<p class="muted">${state.mode === "summary" ? "要約" : "翻訳"}を準備中…</p>`;
    if (!state.translationDone) el.lastElementChild?.classList.add("cursor");
  });
}
function maybePrefetch() {
  // Start the first tutoring turn in the background so it is ready when the user moves on.
  if (!state.started && !state.startTurn) state.startTurn = beginTurn({ start: true }, { revealed: false });
}
const FALLBACK_NOTE = "全文訳の代わりに要約";
function translationLabel(phase) {
  const word = state.mode === "summary" ? "要約" : "翻訳";
  if (phase === "busy") return `${word}中…`;
  if (phase === "prep") return `${word}準備中…`;
  if (phase === "incomplete") return `${word}が途中で終了`;
  if (state.mode === "none") return "";
  if (state.mode === "full" && state.translation.slice(0, 80).includes(FALLBACK_NOTE)) return "全文訳できないため要約を表示";
  return `${word}完了`;
}
function setModeSeg() {
  $$("#mode-seg button").forEach((b) => b.classList.toggle("on", b.dataset.mode === state.mode));
}
let trCtrl = null;
let trSeq = 0;
async function runTranslation(mode) {
  trSeq = Math.max(Date.now(), trSeq + 1);
  const seq = trSeq;
  if (mode) state.mode = mode;
  setModeSeg();
  trCtrl?.abort();
  const ctrl = (trCtrl = new AbortController());
  const st = $("#translation-state");
  st.textContent = state.mode === "none" ? "" : translationLabel("busy");
  state.translation = "";
  state.translationDone = false;
  renderTranslation();
  let first = true;
  try {
    await postSSE(
      `/api/session/${state.sessionId}/translate`,
      { mode: state.mode, seq },
      {
        thinking() {
          st.textContent = translationLabel("prep");
        },
        delta({ text }) {
          state.translation += text;
          if (first) {
            first = false;
            st.textContent = translationLabel("busy");
            maybePrefetch();
          }
          renderTranslation();
        },
        done({ stopReason }) {
          state.translationDone = stopReason === "end_turn";
          st.textContent = translationLabel(state.translationDone ? "done" : "incomplete");
        },
        error(e) {
          st.textContent = `エラー: ${e.message}`;
        },
      },
      ctrl.signal,
    );
  } catch (err) {
    if (ctrl.signal.aborted) return;
    st.textContent = `エラー: ${err.message}`;
  }
  if (trCtrl !== ctrl) return;
  renderTranslation();
  maybePrefetch();
}

// ---------------------------------------------------------------- study view
function showStudy() {
  document.body.dataset.view = "study";
  setTab(state.started ? "chat" : "translation");
  setStatus();
}
function setTab(tab) {
  document.body.dataset.tab = tab;
  $$("#tabs button").forEach((b) => b.classList.toggle("on", b.dataset.tab === tab));
  if (tab !== "chat") setLeft(tab);
  else requestAnimationFrame(scrollLog);
}
function setLeft(which) {
  $("#panel-translation").hidden = which !== "translation";
  $("#panel-record").hidden = which !== "record";
  $$(".pane-head .seg.leftsel button").forEach((b) => b.classList.toggle("on", b.dataset.left === which));
  $("#mode-seg").hidden = which !== "translation";
}

async function restore(id) {
  const res = await fetch(`/api/session/${id}`);
  if (!res.ok) return false;
  const s = await res.json();
  state.sessionId = s.id;
  state.translation = s.translation || "";
  state.translationDone = s.translationDone;
  state.mode = s.translateMode || "full";
  setModeSeg();
  state.record = s.record || {};
  state.started = s.started;
  for (const m of s.transcript) {
    const b = addBubble(m.role, m.text);
    if (m.role === "assistant") {
      setBubbleText(b, m.text);
      addSayButton(b);
    }
  }
  $("#gate").hidden = state.started;
  setComposeEnabled(state.started);
  applyMetaUI(s.meta);
  renderRecord();
  showStudy();
  if (state.translationDone) {
    $("#translation-state").textContent = translationLabel("done");
    renderTranslation();
    maybePrefetch();
  } else runTranslation();
  return true;
}

// ---------------------------------------------------------------- setup view
function fileKind(f) {
  if (f.type === "application/pdf" || /\.pdf$/i.test(f.name)) return "pdf";
  if (/^image\/(png|jpeg|gif|webp)$/.test(f.type)) return "image";
  if (f.type.startsWith("text/") || /\.(txt|md|markdown)$/i.test(f.name)) return "text";
  return null;
}
function readFile(f) {
  const kind = fileKind(f);
  return new Promise((resolve, reject) => {
    if (!kind) return reject(new Error(`${f.name}: 非対応の形式(PDF・テキスト・画像のみ。Wordは PDF に変換)`));
    const r = new FileReader();
    r.onerror = () => reject(r.error);
    if (kind === "text") {
      r.onload = () => resolve({ kind, name: f.name, text: r.result });
      r.readAsText(f);
    } else {
      r.onload = () => resolve({ kind, name: f.name, mime: f.type, data: String(r.result).split(",")[1] });
      r.readAsDataURL(f);
    }
  });
}
async function addFiles(role, files) {
  for (const f of files) {
    try {
      state.files[role].push(await readFile(f));
    } catch (e) {
      alert(e.message);
    }
  }
  renderFileList(role);
}
function renderFileList(role) {
  const ul = $(`#list-${role}`);
  ul.innerHTML = "";
  state.files[role].forEach((f, i) => {
    const li = document.createElement("li");
    li.innerHTML = `<span>${escapeHtml(f.name)}</span>`;
    const x = document.createElement("button");
    x.textContent = "削除";
    x.onclick = () => {
      state.files[role].splice(i, 1);
      renderFileList(role);
    };
    li.appendChild(x);
    ul.appendChild(li);
  });
}
function setupDrop(role) {
  const input = $(`#file-${role}`);
  const label = input.closest(".drop");
  input.onchange = () => {
    addFiles(role, [...input.files]);
    input.value = "";
  };
  label.ondragover = (e) => {
    e.preventDefault();
    label.classList.add("over");
  };
  label.ondragleave = () => label.classList.remove("over");
  label.ondrop = (e) => {
    e.preventDefault();
    label.classList.remove("over");
    addFiles(role, [...e.dataTransfer.files]);
  };
}

async function startNew() {
  const mode = document.querySelector('input[name="tmode"]:checked')?.value || "full";
  const body = { paper: [...state.files.paper], questions: [...state.files.questions], translateMode: mode };
  const tp = $("#text-paper").value.trim();
  const tq = $("#text-questions").value.trim();
  if (tp) body.paper.push({ kind: "text", name: "貼り付け本文", text: tp });
  if (tq) body.questions.push({ kind: "text", name: "貼り付け設問", text: tq });
  if (!body.paper.length) return alert("論文を指定。");
  if (!body.questions.length) return alert("設問を指定。");
  const btn = $("#btn-start");
  btn.disabled = true;
  btn.textContent = "送信中…";
  // Unlock speech synthesis on this user gesture (iOS/Safari).
  try {
    speechSynthesis.speak(new SpeechSynthesisUtterance(""));
  } catch {}
  try {
    const res = await fetch("/api/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const j = await res.json();
    if (!res.ok) throw new Error(j.error || res.statusText);
    state.sessionId = j.id;
    store.set("sessionId", j.id);
    setComposeEnabled(false);
    applyMetaUI(null);
    renderRecord();
    showStudy();
    runTranslation(mode);
  } catch (e) {
    alert(`開始できない: ${e.message}`);
    btn.disabled = false;
    btn.textContent = "開始";
  }
}

// ---------------------------------------------------------------- settings dialog
function bindSettings() {
  const dlg = $("#settings");
  $("#btn-settings").onclick = () => {
    $("#set-ttsmode").value = settings.ttsMode;
    $("#set-rate").value = settings.rate;
    $("#out-rate").textContent = settings.rate;
    $("#set-silence").value = settings.silenceMs;
    $("#set-bargein").checked = settings.bargeIn;
    $("#set-autolang").checked = settings.autoLang;
    loadVoices();
    dlg.showModal();
  };
  $("#set-rate").oninput = (e) => ($("#out-rate").textContent = e.target.value);
  dlg.addEventListener("close", () => {
    settings.ttsMode = $("#set-ttsmode").value;
    settings.rate = Number($("#set-rate").value);
    settings.silenceMs = Math.max(400, Number($("#set-silence").value) || DEFAULTS.silenceMs);
    settings.bargeIn = $("#set-bargein").checked;
    settings.autoLang = $("#set-autolang").checked;
    settings.voiceJa = $("#set-voice-ja").value;
    settings.voiceEn = $("#set-voice-en").value;
    saveSettings();
    if (settings.ttsMode === "off") speaker.hush();
    setStatus();
  });
}

// ---------------------------------------------------------------- wiring
function bind() {
  setupDrop("paper");
  setupDrop("questions");
  bindSettings();
  $("#btn-start").onclick = startNew;
  $("#btn-new").onclick = () => {
    if (state.sessionId && !confirm("新しい論文で始める。現在の記録はサーバーに残る。")) return;
    store.set("sessionId", null);
    location.reload();
  };
  const go = () => {
    try {
      speechSynthesis.speak(new SpeechSynthesisUtterance(""));
    } catch {}
    if (listener.supported) state.conv = true; // 会話モードで開始
    updateWakeLock();
    revealStartTurn();
    setTab("chat");
  };
  $("#btn-go").onclick = go;
  $("#btn-go2").onclick = go;
  $$("#tabs button").forEach((b) => (b.onclick = () => setTab(b.dataset.tab)));
  $$(".pane-head .seg.leftsel button").forEach((b) => (b.onclick = () => setLeft(b.dataset.left)));
  $$("#mode-seg button").forEach(
    (b) =>
      (b.onclick = () => {
        if (b.dataset.mode === state.mode && state.translation) return;
        runTranslation(b.dataset.mode);
      }),
  );
  $$("#lang-seg button").forEach((b) => (b.onclick = () => setLang(b.dataset.lang)));
  $("#btn-mic").onclick = () => {
    if (!listener.supported) return alert("このブラウザは音声認識に非対応。Chrome / Edge / Safari を推奨。");
    state.conv = !state.conv;
    if (state.conv) {
      if (speaker.speaking && !settings.bargeIn) speaker.hush();
      listener.start(langCode(state.lang));
    } else {
      listener.stop();
      clearDraft();
    }
    updateWakeLock();
    setStatus();
  };
  $("#btn-hint").onclick = () => submitUser("ヒント");
  $("#btn-hush").onclick = () => speaker.hush();
  $("#btn-export").onclick = exportMarkdown;
  $("#record").addEventListener("click", (e) => {
    const el = e.target.closest(".speak");
    if (!el) return;
    speaker.reset();
    speaker.feed(el.textContent, true);
  });
  $("#compose").onsubmit = (e) => {
    e.preventDefault();
    const v = $("#input").value;
    $("#input").value = "";
    submitUser(v);
  };
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") speaker.hush();
  });
  if (window.speechSynthesis) speechSynthesis.onvoiceschanged = loadVoices;
  loadVoices();
}

async function init() {
  bind();
  setStatus();
  renderRecord();
  fetch("/api/config")
    .then((r) => r.json())
    .then((c) => {
      $("#status").textContent = `${c.model}${c.mock ? "(モック)" : ""}${c.fast ? " fast" : ""}`;
    })
    .catch(() => {});
  if (!listener.supported) $("#env-note").textContent = "注: このブラウザは音声認識に非対応。Chrome / Edge / Safari を推奨。テキスト入力は可能。";
  const id = store.get("sessionId");
  if (id && (await restore(id).catch(() => false))) return;
  store.set("sessionId", null);
  document.body.dataset.view = "setup";
}
init();
