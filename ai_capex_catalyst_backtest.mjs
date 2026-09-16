// ==================================================================
// ai_capex_catalyst_backtest.mjs — AI CAPEX CATALYSTの記録基盤
// (policy_catalyst_backtest.mjsと同じ「検証はまだしない、貯めるだけ」
// という方針。ai_capex_impact_scoreがBUY SCOREだけでは拾えない追加情報を
// 持っているかを、後で前方リターンと突き合わせて検証するための材料)。
//
// IMPORTANT: ai_demand_risk(riskFlags)はスコアではないため、ここでは
// riskFlagCountとしてのみ記録し、aiCapexImpactScoreには混ぜない
// (ユーザー指示: ai_demand_riskを買い材料/売りシグナルに変換しない)。
// ==================================================================
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { riskLevel } from './indicators.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(__dirname, 'ai_capex_catalyst_backtest_cache.json');
const KEEP_DAYS = 365;

export function loadAiCapexCatalystBacktest(filePath = FILE) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return {};
  }
}

// results: amb.results / smart.results(aiCapexCatalystが付与された後のもの)。
// events(スコア付き材料)もriskFlags(警戒材料)も無い銘柄は記録しない。
export function recordAiCapexCatalystSnapshot(today, results, filePath = FILE) {
  const hist = loadAiCapexCatalystBacktest(filePath);
  const day = hist[today] ?? (hist[today] = {});
  let added = 0;
  for (const r of results ?? []) {
    const ac = r.aiCapexCatalyst;
    if (!ac) continue;
    const hasScore = Array.isArray(ac.events) && ac.events.length > 0;
    const hasRisk = Array.isArray(ac.riskFlags) && ac.riskFlags.length > 0;
    if (!hasScore && !hasRisk) continue;

    // スコア付き材料が無くriskFlagsだけの銘柄は、eventIdが無いため
    // `${code}|risk-only`をキーにする(同日内の重複記録防止のため)。
    const top = hasScore ? ac.events.reduce((a, b) => ((b.score ?? 0) > (a.score ?? 0) ? b : a)) : null;
    const key = `${r.code}|${top ? top.eventId : 'risk-only'}`;
    if (day[key]) continue;

    day[key] = {
      date: today,
      eventId: top ? top.eventId : null,
      code: r.code,
      name: r.name,
      theme: top ? top.theme : (ac.riskFlags[0]?.theme ?? null),
      direction: top ? (top.direction ?? null) : null,
      price: Number.isFinite(r.price) ? r.price : null,

      // 既存BUY SCORE側の内訳(記録時点の生の値。policy_catalyst_backtest.mjs
      // と同じ理由でコピー保存する)
      buyScore: r.buyScore?.score ?? null,
      buyConfidence: r.buyScore?.confidence ?? null,
      expectationScore: r.expectationScore?.score ?? null,
      earningsSurpriseScore: r.earningsSurpriseScore?.score ?? null,
      unpriced: r.buyScore?.detail?.unpriced?.value ?? null,
      timing: r.buyScore?.detail?.timing?.value ?? null,
      risk: riskLevel(r),

      // AI CAPEX CATALYST側(policy_impact_scoreとは別物、合算しない)
      aiCapexImpactScore: ac.topScore ?? null,
      riskFlagCount: ac.riskFlags.length,
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

export function aiCapexCatalystBacktestStatus(filePath = FILE) {
  const hist = loadAiCapexCatalystBacktest(filePath);
  const dates = Object.keys(hist).sort();
  const totalSnapshots = dates.reduce((n, d) => n + Object.keys(hist[d]).length, 0);
  return {
    days: dates.length,
    totalSnapshots,
    firstDate: dates[0] ?? null,
    lastDate: dates[dates.length - 1] ?? null,
  };
}
