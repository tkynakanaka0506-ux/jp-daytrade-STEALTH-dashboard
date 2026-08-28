// ==================================================================
// us_yahoo.mjs — Yahoo Finance非公式チャートAPIから米国株の日足OHLCVを取得
//
//  ■ データソース選定の経緯（実装前に実データで検証済み）
//  当初はkabutan.mjsと同じ「依存ゼロ・無料・鍵不要」の方針でStooq
//  （https://stooq.com/q/d/l/）を使う想定だったが、実データ検証で
//  JavaScriptのbot対策チャレンジが入っており直接取得できないことが
//  判明した。Finnhub（決算カレンダー用に別途契約済み）の`/stock/candle`
//  も試したが無料プランでは403（有料プラン限定）。Yahoo Financeの
//  非公式チャートAPIは鍵不要で実データ取得に成功したため、これを使う。
//  非公式APIのため時々429（レート制限）が返るのは実測済みで、
//  kabutan.mjs等と同じ指数バックオフのリトライで吸収する。
// ==================================================================

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
export const REQ_GAP = 600;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// kabutan.mjs/irbank.mjs等と同じ理由（Macのスリープ中にfetchが無期限に
// 応答待ちになりプロセス全体がハングする事象の再発防止）でタイムアウトを
// 設ける。
const FETCH_TIMEOUT_MS = 30_000;

async function getJson(url, retries = 3) {
  for (let i = 0; ; i++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: ac.signal });
      if (res.ok) return await res.json();
      throw new Error(`HTTP ${res.status}`);
    } catch (e) {
      if (i >= retries) throw new Error(`${e.message} — ${url}`);
      await sleep(1000 * 2 ** i); // 429対策で他ファイルよりリトライ回数を1回多くしてある
    } finally {
      clearTimeout(timer);
    }
  }
}

// 日足OHLCV。timestamp配列は古い→新しい順で、indicators.mjsのkairi/rsi/
// volumeZScoreが期待する並び（closes.at(-1)が最新）とそのまま一致するため
// 反転は不要（kabutanの週次信用残データが新しい→古い順なのとは対照的）。
//
// Yahooのquote配列は稀にclose/volumeがnull（休場日・データ欠損）になる
// 行を含むため、close===nullの行はtimestampごと除外して整合を保つ。
//
// ■ 「まだ引けていない今日の足」を実データで実際に踏んだ再発防止
// 米国市場の取引時間中にfetchすると、配列の最後の要素が「今日の途中経過」
// （close=現在値、volume=その時点までの出来高のみ）になっている（実測:
// 日本時間22:31＝寄り付き直後にAAPLを取得したところ、最後の出来高だけ
// 桁違いに少なく(約150万株、前日は3000万株超)、変化率も前日比+19.6%という
// 明らかに異常な値になった）。これを他の日足とまぜてkairi/rsi/
// volumeZScoreに渡すと「出来高が異常に少ない日」を誤検出する。
// meta.regularMarketTimeがその日の取引時間(currentTradingPeriod.regular)
// の終了前なら、最後の1本は未確定として除外する。
export async function fetchDailyBars(ticker, { range = '6mo' } = {}) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=${range}&interval=1d`;
  const json = await getJson(url);
  const result = json?.chart?.result?.[0];
  const err = json?.chart?.error;
  if (err) throw new Error(`Yahoo Finance: ${err.description ?? err.code} (${ticker})`);
  if (!result) throw new Error(`Yahoo Finance: レスポンスが空です (${ticker})`);

  const ts = result.timestamp ?? [];
  const q = result.indicators?.quote?.[0] ?? {};
  const closesRaw = q.close ?? [];
  const volumesRaw = q.volume ?? [];

  const regularEnd = result.meta?.currentTradingPeriod?.regular?.end ?? null;
  const marketTime = result.meta?.regularMarketTime ?? null;
  const todayStillOpen = Number.isFinite(regularEnd) && Number.isFinite(marketTime) && marketTime < regularEnd;
  const lastIdx = todayStillOpen ? ts.length - 2 : ts.length - 1; // 未確定の最終足を除外

  const closes = [];
  const volumes = [];
  for (let i = 0; i <= lastIdx; i++) {
    if (!Number.isFinite(closesRaw[i])) continue; // 休場日等の欠損行を除外
    closes.push(closesRaw[i]);
    volumes.push(Number.isFinite(volumesRaw[i]) ? volumesRaw[i] : null);
  }
  if (closes.length === 0) throw new Error(`Yahoo Finance: 有効な終値が1件も取得できませんでした (${ticker})`);

  // 表示用の現在値は生きたregularMarketPriceを使うが（場中でも最新値を
  // 見せたいため）、変化率は必ず「確定済みの前営業日終値」との比較にする
  // （meta.chartPreviousCloseは実測で配列内の値と食い違うことがあり
  // 信頼できなかったため使わない）。
  // todayStillOpenならclosesは既に未確定足を除外済み＝closes.at(-1)が
  // 前営業日の確定終値。市場が閉まっていればclosesの最後は当日の確定
  // 終値なので、その1つ前(closes.at(-2))と比較する必要がある
  // （同じ日同士を比べて変化率0%になるのを防ぐ）。
  const price = result.meta?.regularMarketPrice ?? closes.at(-1);
  const prevClose = todayStillOpen ? closes.at(-1) : (closes.at(-2) ?? null);
  const changePct = Number.isFinite(prevClose) && prevClose !== 0
    ? Math.round(((price - prevClose) / prevClose) * 1000) / 10
    : null;

  return { price, changePct, closes, volumes, currency: result.meta?.currency ?? null };
}
