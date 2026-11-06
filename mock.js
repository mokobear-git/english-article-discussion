// MOCK=1 で API を呼ばずに UI を試すための疑似ストリーム。
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function lastUserText(messages) {
  const m = messages.at(-1);
  if (typeof m.content === "string") return m.content;
  return m.content.filter((b) => b.type === "text").map((b) => b.text).join("");
}

function scriptFor(params) {
  const text = lastUserText(params.messages);
  if (text.includes("タスクA")) {
    return "## 要旨\n\n背景:本研究は模擬データによる表示確認用である。\n\n## 方法\n\n対象者(participants)1,234名を解析した。\n\n## 結果\n\nハザード比(HR)0.72、95% CI 0.60–0.86。";
  }
  const turns = params.messages.filter((m) => m.role === "assistant").length;
  const meta = (o) => `\n<<<META ${JSON.stringify(o)}>>>`;
  if (text.includes("タスクB")) {
    return (
      "設問は2つ。設問1。What was the primary outcome? 主要評価項目は何か。\nステップ1。この設問が求めているのは次のどれか。\nA. 研究が最も重視した評価の指標\nB. 研究対象者の特徴\nC. 統計解析の方法" +
      meta({ q: 1, total_q: 2, phase: "steps", expect: "ja", choices: ["A. 研究が最も重視した評価の指標", "B. 研究対象者の特徴", "C. 統計解析の方法"] })
    );
  }
  if (turns === 1) {
    return (
      "正解。研究の中心となる指標を答える設問。方法の節に記載があり、全死亡と定められている。まとめると、主要評価項目は全死亡である。こうですか?" +
      meta({ q: 1, total_q: 2, phase: "confirm", expect: "ja", choices: ["OK", "修正したい"] })
    );
  }
  if (turns === 2) {
    const summary = "1. 主要評価項目は全死亡であった。2. 追跡期間は5年であった。";
    return (
      `解答文。\n${summary}\n1文目を英訳せよ。主要評価項目は全死亡であった。\n語彙ヒント: primary outcome(主要評価項目)、all-cause mortality(全死亡)` +
      meta({ q: 1, total_q: 2, phase: "english", expect: "en", summary_ja: summary, target_ja: "主要評価項目は全死亡であった。", progress: "1/2" })
    );
  }
  if (turns === 3) {
    return (
      "合格。The primary outcome was all-cause mortality. 次。追跡期間は5年であった。\n語彙ヒント: follow-up(追跡)、median(中央値)" +
      meta({
        q: 1, total_q: 2, phase: "english", expect: "en",
        accepted: { ja: "主要評価項目は全死亡であった。", en: "The primary outcome was all-cause mortality." },
        target_ja: "追跡期間は5年であった。", progress: "2/2",
      })
    );
  }
  return (
    "合格。完成版。The primary outcome was all-cause mortality. The follow-up period was 5 years. 次の設問へ進むか。" +
    meta({
      q: 1, total_q: 2, phase: "q_done", expect: "ja", choices: ["次の設問へ", "この設問をもう一度"],
      accepted: { ja: "追跡期間は5年であった。", en: "The follow-up period was 5 years." },
      final_en: "The primary outcome was all-cause mortality. The follow-up period was 5 years.",
    })
  );
}

export async function mockStream(params, { onText, signalRef }) {
  const full = scriptFor(params);
  await sleep(250);
  for (let i = 0; i < full.length; i += 3) {
    if (signalRef.aborted) throw new Error("aborted");
    onText(full.slice(i, i + 3));
    await sleep(12);
  }
  return { content: [{ type: "text", text: full }], stopReason: "end_turn" };
}
