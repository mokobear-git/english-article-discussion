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
      "設問は2つ。設問1。Do you think the results are clinically meaningful? この結果は臨床的に意味があると考えるか。\nステップ1。あなたの考えに最も近いのはどれか。\nA. 意味がある。死亡率が下がったため\nB. 一部の患者に限って意味がある\nC. まだ判断できない" +
      meta({ q: 1, total_q: 2, phase: "steps", expect: "ja", choices: ["A. 意味がある。死亡率が下がったため", "B. 一部の患者に限って意味がある", "C. まだ判断できない"] })
    );
  }
  if (turns === 1) {
    return (
      "意味があるという立場。理由は死亡率の低下。まとめると、死亡率が下がったため、この結果は臨床的に意味があると考える。こうですか?" +
      meta({ q: 1, total_q: 2, phase: "confirm", expect: "ja", choices: ["OK", "修正したい"] })
    );
  }
  if (turns === 2) {
    const summary = "1. この結果は臨床的に意味があると考える。2. 死亡率が下がったからである。";
    return (
      `解答文。\n${summary}\n1文目を英訳せよ。この結果は臨床的に意味があると考える。\n語彙ヒント: clinically meaningful(臨床的に意味がある)、consider(考える)` +
      meta({ q: 1, total_q: 2, phase: "english", expect: "en", summary_ja: summary, target_ja: "この結果は臨床的に意味があると考える。", progress: "1/2" })
    );
  }
  if (turns === 3) {
    return (
      "合格。I consider these results clinically meaningful. 次。死亡率が下がったからである。\n語彙ヒント: mortality(死亡率)、decrease(下がる)" +
      meta({
        q: 1, total_q: 2, phase: "english", expect: "en",
        accepted: { ja: "この結果は臨床的に意味があると考える。", en: "I consider these results clinically meaningful." },
        target_ja: "死亡率が下がったからである。", progress: "2/2",
      })
    );
  }
  return (
    "合格。完成版。I consider these results clinically meaningful. This is because mortality decreased. 次の設問へ進むか。" +
    meta({
      q: 1, total_q: 2, phase: "q_done", expect: "ja", choices: ["次の設問へ", "この設問をもう一度"],
      accepted: { ja: "死亡率が下がったからである。", en: "This is because mortality decreased." },
      final_en: "I consider these results clinically meaningful. This is because mortality decreased.",
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
