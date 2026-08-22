// ==================================================================
// sector_history.mjs — 業種別騰落率の日次履歴（出遅れ修正/セクターローテ用）
//
//  fetchSectorMomentum() は「今日」の業種騰落率しか返さない。個別銘柄が
//  「業種は既に反発済みなのに自分だけ出遅れている」状態かどうかを見るには、
//  業種側の複数日トレンドが要る。日次バッチのたびに今日の値を積み増して
//  ローリングJSONに保持する（KEEP_DAYS日分）。
//
//  ■ データが無い期間について
//  この仕組みを入れた日から履歴が始まるため、最初のKEEP_DAYS営業日は
//  トレンド判定に必要な日数が足りず null（判定不能）になる。推測で
//  埋めない（仕様書§25と同じ方針）。
// ==================================================================
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(__dirname, 'sector_history_cache.json');
const KEEP_DAYS = 30;

export function loadSectorHistory() {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf-8'));
  } catch {
    return {};
  }
}

// 今日の業種騰落率を履歴に積み増す。同日に複数回呼ばれても（場中5分更新）
// 上書きするだけで重複は増えない。
export function appendSectorHistory(today, sectors) {
  const hist = loadSectorHistory();
  hist[today] = Object.fromEntries(
    Object.entries(sectors).map(([name, s]) => [name, s.changePct])
  );
  const dates = Object.keys(hist).sort();
  while (dates.length > KEEP_DAYS) {
    delete hist[dates.shift()];
  }
  fs.writeFileSync(FILE, JSON.stringify(hist, null, 2));
  return hist;
}

// 業種の直近N営業日の累積騰落率（%）。日数が足りなければnull。
// 「今日」はまだ完了していない場中の値のことがあるので含めない
// （前日までの確定値でトレンドを見る）。
export function sectorTrendPct(history, sectorName, today, days = 5) {
  if (!sectorName) return null;
  const dates = Object.keys(history).filter((d) => d < today).sort();
  const recent = dates.slice(-days);
  if (recent.length < days) return null;
  let cum = 0;
  for (const d of recent) {
    const pct = history[d]?.[sectorName];
    if (!Number.isFinite(pct)) return null;
    cum += pct;
  }
  return Math.round(cum * 10) / 10;
}
