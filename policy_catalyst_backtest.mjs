// ==================================================================
// policy_catalyst_backtest.mjs — Phase3「検証」用の記録基盤
//
// 目的: 「政策材料(Policy Catalyst Score)は既存BUY SCOREだけでは
// 拾えない追加情報を持っているか」を、後で前方リターンと突き合わせて
// 検証するための材料を貯めること。このファイル自体は検証(分析)を
// 行わない — 記録するだけ。分析はNが十分に溜まってから別途行う
// (jp-daytrade-dashboard側のbacktest.pyと同じ方針: 「有効性は未検証
// であって、無効ではない」。小標本で結論を急がない)。
//
// 1日1回、その日最初に見たスナップショットだけを記録する(このMJS
// プロジェクトは5分間隔で再実行されるため、同じ日に何度も上書きすると
// イントラデイの値動きノイズが「別のサンプル」のように紛れ込んでしまう。
// sector_history.mjsと違い、こちらは「その日の代表値=1つ」にしたいので
// 上書きではなく「既にあれば何もしない」にする)。
//
// ユーザー指示(2026-09-13、再現性の確保): スコア計算ロジックを後日
// 変更しても「記録した当時、この銘柄をこう評価していた」が再現できる
// よう、当時の値をそのままコピーして保存する(計算式への参照ではなく
// 生の数値を保存する)。scoreTrio()の画面表示(BUY/EXPECTATION/SURPRISE/
// UNPRICED/TIMING/RISK/CONFIDENCE)と1対1で対応する形にしてある。
// ==================================================================
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { riskLevel } from './indicators.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(__dirname, 'policy_catalyst_backtest_cache.json');
// 検証には数ヶ月単位のサンプルが要るため、他のキャッシュ(30日等)より
// 長めに保持する。
const KEEP_DAYS = 365;

export function loadPolicyCatalystBacktest(filePath = FILE) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return {};
  }
}

// results: amb.results / smart.results(policyCatalystScoreが付与された後のもの)。
// policyCatalystScoreがnull(政策材料なし)の銘柄は記録しない
// (=既存のBUY SCOREだけの銘柄まで無駄にログを膨らませない)。
//
// keyは`${code}|${eventId}`。同一銘柄が防衛政策と半導体政策のように
// 複数の政策イベントを同時に持つ場合、代表イベントが日によって入れ替わる
// ことがある(policy_catalyst_score.mjsのtopScore選択ロジック次第)ため、
// eventIdまで含めて別サンプルとして記録できるようにしている。
export function recordPolicyCatalystSnapshot(today, results, filePath = FILE) {
  const hist = loadPolicyCatalystBacktest(filePath);
  const day = hist[today] ?? (hist[today] = {});
  let added = 0;
  for (const r of results ?? []) {
    const pcs = r.policyCatalystScore;
    if (!pcs) continue;
    const key = `${r.code}|${pcs.eventId}`;
    if (day[key]) continue; // 同日内は最初の1回だけ(場中再実行での重複記録を防ぐ)
    day[key] = {
      // 識別情報
      date: today,
      eventId: pcs.eventId,
      code: r.code,
      name: r.name,
      theme: pcs.theme,
      direction: pcs.direction ?? null, // Python側の値をそのまま保存(再判定しない)
      price: Number.isFinite(r.price) ? r.price : null,

      // 既存BUY SCORE側の内訳(記録時点の生の値。後でbuyScore()の計算式が
      // 変わっても、この行だけで「当時どう評価したか」が再現できるように
      // コピーして保存する)
      policyImpactScore: pcs.parts.policy, // Python側の生のPolicy Impact Score
      buyScore: r.buyScore?.score ?? null,
      buyConfidence: r.buyScore?.confidence ?? null,
      expectationScore: r.expectationScore?.score ?? null,
      earningsSurpriseScore: r.earningsSurpriseScore?.score ?? null,
      unpriced: r.buyScore?.detail?.unpriced?.value ?? null, // BUY SCORE内訳のUNPRICED
      timing: r.buyScore?.detail?.timing?.value ?? null, // BUY SCORE内訳のTIMING(Policy CatalystのTIMINGとは別概念)
      risk: riskLevel(r), // LOW/MED/HIGH

      // Policy Catalyst Score側(Phase3の独立スコア)
      policyCatalystScore: pcs.score,
      policyCatalystConfidence: pcs.confidence,
      policyCatalystParts: pcs.parts, // {policy, unpriced, timing, exposure}
    };
    added += 1;
  }
  if (added > 0) {
    const dates = Object.keys(hist).sort();
    while (dates.length > KEEP_DAYS) delete hist[dates.shift()];
    fs.writeFileSync(filePath, JSON.stringify(hist, null, 2));
  }
  return added;
}

// 現状のログ蓄積状況。検証(前方リターンとの突き合わせ)にはまだ使わない、
// 進捗確認専用(Python側のBACKTEST_STATUSと同じ「今どれだけ溜まっているか
// を素直に報告する」という位置づけ)。
export function policyCatalystBacktestStatus(filePath = FILE) {
  const hist = loadPolicyCatalystBacktest(filePath);
  const dates = Object.keys(hist).sort();
  const totalSnapshots = dates.reduce((n, d) => n + Object.keys(hist[d]).length, 0);
  return {
    days: dates.length,
    totalSnapshots,
    firstDate: dates[0] ?? null,
    lastDate: dates[dates.length - 1] ?? null,
  };
}
