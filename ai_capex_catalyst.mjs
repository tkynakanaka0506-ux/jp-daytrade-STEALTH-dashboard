// ==================================================================
// ai_capex_catalyst.mjs — AI CAPEX CATALYST(Phase1/2相当、読み込み・
// 集約のみ。Policy Catalystのcompute*Score/verdictに相当するものは
// まだ作らない)
//
// policy_catalyst.mjsと同じJSON(jp-daytrade-dashboard/newssite/data/
// policy_catalyst_signals.json)から、Python側でintelligence_layer=
// "corporate_capex"と判定された分だけを抜き出して銘柄コード別に集約する。
//
// IMPORTANT(ユーザー指示、必ず守ること):
//  - POLICY CATALYST(政府・政策起点、policy_catalyst.mjs)とは完全に
//    別の入力として扱う。ai_capex_impact_scoreをpolicy_impact_scoreと
//    合算・平均・比較しない(このファイルはpolicy_catalyst.mjsを一切
//    参照しない)
//  - ai_demand_risk(資金負担リスク、Python側でwatch専用の弱いシグナル
//    として設計されたテーマ)は「買い材料としてのスコア(topScore)」に
//    加算しない。riskFlagsという別枠にのみ格納し、売りシグナルにも
//    変換しない(表示側で「⚠ 警戒材料がある」とだけ示す)
//  - BUY SCORE等の既存指標・AMBUSH/SMART ENTRYの順位ロジックには一切触れない
// ==================================================================

import { loadPolicyCatalystData } from './policy_catalyst.mjs';

// ai_demand_riskは「買い材料の強さ」ではなく「資金負担の警戒」を表すため、
// topScoreの計算対象からは除外し、riskFlagsという別枠に集約する
// (Python側のrules.jsonでtheme id="ai_demand_risk"として定義済み)。
const AI_DEMAND_RISK_THEME_ID = 'ai_demand_risk';

// events(policy_catalyst_signals.jsonのevents配列、Python側の
// build_event_signalsが生成)を銘柄コード別に集約する。
// 同一銘柄に複数のAI Capexイベントが同時に存在しうる(例: あるニュースで
// Meta向け・Microsoft向けの両方の言及があり、同じ半導体商社が両方に
// 紐づくケース)。代表スコア(topScore)はai_demand_risk以外のイベントの
// 中から最大値を採用する(policy_catalyst.mjsのbuildPolicyCatalystByCode
// と同じ考え方: 平均すると強い材料が薄まり、合計すると多重計上になる)。
//
// 同一policy_event_id(続報系列)は公開日時が一番新しいものだけをevents/
// riskFlagsそれぞれで残す(続報を件数として多重計上しないため。
// policy_catalyst.mjsのbuildPolicyCatalystByCodeと同じ理由)。
// policy_event_state===CLOSED(施策実施済み)の政策は既に実現した話なので
// この集約から除外する。
export function buildAiCapexCatalystByCode(events) {
  const byCodeMap = {};
  for (const event of events ?? []) {
    if (event.policy_event_state === 'CLOSED') continue;
    for (const stock of event.stocks ?? []) {
      const code = stock?.code;
      if (!code) continue;
      const layer = stock.intelligence_layer ?? event.intelligence_layer;
      if (layer !== 'corporate_capex') continue;

      if (!byCodeMap[code]) byCodeMap[code] = { events: new Map(), riskFlags: new Map() };
      const themeId = stock.theme_id ?? event.theme_id;
      const publishedAt = event.published_at ?? '';

      if (themeId === AI_DEMAND_RISK_THEME_ID) {
        const flag = {
          eventId: event.event_id,
          theme: stock.theme || event.theme || '',
          reason: event.reason ?? '',
          source: event.source ?? '',
          url: event.url ?? '',
          publishedAt,
        };
        const existingFlag = byCodeMap[code].riskFlags.get(flag.eventId);
        if (!existingFlag || publishedAt >= (existingFlag.publishedAt || '')) {
          byCodeMap[code].riskFlags.set(flag.eventId, flag);
        }
        continue;
      }

      const score = stock.ai_capex_impact_score ?? event.ai_capex_impact_score ?? null;
      const entry = {
        eventId: event.event_id,
        theme: stock.theme || event.theme || '',
        direction: stock.impact, // Python側で確定した値をそのまま使う(再判定しない)
        tier: stock.tier ?? null,
        score,
        matchedKeyword: event.matched_keyword ?? null,
        reason: event.reason ?? '',
        source: event.source ?? '',
        url: event.url ?? '',
        publishedAt,
      };
      const existing = byCodeMap[code].events.get(entry.eventId);
      if (!existing || publishedAt >= (existing.publishedAt || '')) {
        byCodeMap[code].events.set(entry.eventId, entry);
      }
    }
  }
  const byCode = {};
  for (const [code, maps] of Object.entries(byCodeMap)) {
    const entries = [...maps.events.values()];
    const topScore = entries.reduce((max, e) => Math.max(max, e.score ?? 0), 0);
    byCode[code] = { topScore, events: entries, riskFlags: [...maps.riskFlags.values()] };
  }
  return byCode;
}

// scraper.mjs から呼ぶ想定の一括ロード関数。読み込みに失敗しても
// available:falseを返すだけで、呼び出し側の既存処理は止まらない
// (policy_catalyst.mjsのloadPolicyCatalystByCodeと同じ方針)。
export function loadAiCapexCatalystByCode(jsonPath) {
  const data = loadPolicyCatalystData(jsonPath);
  if (!data.available) {
    return { available: false, reason: data.reason, byCode: {} };
  }
  return { available: true, byCode: buildAiCapexCatalystByCode(data.events), generatedAt: data.generatedAt };
}
