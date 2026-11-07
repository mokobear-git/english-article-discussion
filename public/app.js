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
const DEFAULTS = { fontSize: "auto", ttsMode: "answer", rate: 1.0, voiceJa: "", voiceEn: "" };
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

function setStatus() {
  $("#go-bar").hidden = state.started || document.body.dataset.view !== "study";
  let msg = "";
  if (isBusy()) msg = state.turn.full ? "応答中…" : "考え中…";
  else if (speaker.speaking) msg = "読み上げ中";
  $("#live").textContent = msg;
}
speaker.onChange = setStatus;
speaker.onIdle = setStatus;

// 入力欄の言語ヒント(英訳時は英語)。スマホの音声入力はキーボードの言語に従う。
function setInputLang(expect) {
  const en = expect === "en";
  const el = $("#input");
  el.lang = en ? "en" : "ja";
  el.setAttribute("autocapitalize", en ? "sentences" : "off");
  el.placeholder = el.disabled ? el.placeholder : en ? "英文を入力(音声入力も可)" : "入力(音声入力も可)";
}

// 画面を離れたら読み上げを止める
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") speaker.hush();
});

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
      // "A. 〜" 形式なら、スマホでは記号(A)だけを表示する。送信は全文。
      const key = String(c).match(/^\s*([A-HＡ-Ｈ])\s*[.．、:：)）]/)?.[1];
      if (key) {
        b.classList.add("keyed");
        b.innerHTML = `<span class="c-full">${escapeHtml(c)}</span><span class="c-key">${escapeHtml(key)}</span>`;
        b.setAttribute("aria-label", c);
        b.title = c;
      } else b.textContent = c;
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

  if (meta) setInputLang(meta.expect);
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
        ${r.question ? `<p class="muted">${escapeHtml(r.question).replace(/\n/g, "<br>")}</p>` : ""}
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
    md += `## 設問 ${q}\n\n${r.question ? `${r.question}\n\n` : ""}### 日本語解答\n\n${r.summary_ja || ""}\n\n### 英訳\n\n`;
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
    } else speaker.feed("", true); // 読み上げなし
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

function submitUser(text) {
  text = String(text || "").trim();
  if (!text || !state.started) return;
  // Barge-in: abort the running turn (server keeps the partial reply).
  if (isBusy()) {
    state.turn.aborted = true;
    state.turn.ctrl.abort();
  }
  speaker.cancel();
  addBubble("user", text);
  $("#choices").innerHTML = "";
  beginTurn({ text });
}

function setComposeEnabled(on) {
  $("#input").disabled = !on;
  $("#input").placeholder = on ? "入力(音声入力も可)" : "「設問へ進む」を押すと入力できる";
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
  const body = {
    paper: [...state.files.paper],
    questions: [...state.files.questions],
    translateMode: mode,
    autoQuestions: Number($("#auto-q").value) || 3,
  };
  const tp = $("#text-paper").value.trim();
  const tq = $("#text-questions").value.trim();
  if (tp) body.paper.push({ kind: "text", name: "貼り付け本文", text: tp });
  if (tq) body.questions.push({ kind: "text", name: "貼り付け設問", text: tq });
  if (!body.paper.length) return alert("論文を指定。");
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
    $("#set-fontsize").value = settings.fontSize;
    $("#set-rate").value = settings.rate;
    $("#out-rate").textContent = settings.rate;
    loadVoices();
    dlg.showModal();
  };
  $("#set-rate").oninput = (e) => ($("#out-rate").textContent = e.target.value);
  dlg.addEventListener("close", () => {
    settings.ttsMode = $("#set-ttsmode").value;
    settings.fontSize = $("#set-fontsize").value;
    applyFontSize();
    settings.rate = Number($("#set-rate").value);
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
  $("#btn-hint").onclick = () => submitUser("ヒント");
  $("#btn-hush").onclick = () => speaker.hush();
  $("#btn-export").onclick = exportMarkdown;
  $("#record").addEventListener("click", (e) => {
    const el = e.target.closest(".speak");
    if (!el) return;
    speaker.reset();
    speaker.feed(el.textContent, true);
  });
  const input = $("#input");
  const autoGrow = () => {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 180) + "px";
  };
  const send = () => {
    const v = input.value;
    if (!v.trim()) return;
    input.value = "";
    autoGrow();
    submitUser(v);
  };
  $("#compose").onsubmit = (e) => {
    e.preventDefault();
    send();
  };
  input.addEventListener("input", autoGrow);
  // Enter で送信、Shift+Enter で改行。日本語変換の確定中(isComposing)は送信しない。
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
      e.preventDefault();
      send();
    }
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") speaker.hush();
  });
  if (window.speechSynthesis) speechSynthesis.onvoiceschanged = loadVoices;
  loadVoices();
}

// 文字サイズ: 自動ではスマホ幅で1.25倍
function applyFontSize() {
  const v = settings.fontSize === "auto" ? (matchMedia("(max-width: 600px)").matches ? 1.25 : 1) : Number(settings.fontSize) || 1;
  document.documentElement.style.setProperty("--fs", String(v));
}

async function init() {
  applyFontSize();
  matchMedia("(max-width: 600px)").addEventListener?.("change", applyFontSize);
  bind();
  setStatus();
  renderRecord();
  fetch("/api/config")
    .then((r) => r.json())
    .then((c) => {
      $("#status").textContent = `${c.model}${c.mock ? "(モック)" : ""}${c.fast ? " fast" : ""}`;
    })
    .catch(() => {});
  const id = store.get("sessionId");
  if (id && (await restore(id).catch(() => false))) return;
  store.set("sessionId", null);
  document.body.dataset.view = "setup";
}
init();
