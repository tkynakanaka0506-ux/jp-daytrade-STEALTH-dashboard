// ==================================================================
// kabutan.mjs — kabutan.jp 取得・パース（依存ゼロ）
//
//  v7.0 で scraper.mjs に直書きしていたものを、AMBUSHスクリーナと
//  共用するために切り出したもの。ロジックは変更していない。
// ==================================================================

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36';
export const REQ_GAP = 600; // kabutanへの最小リクエスト間隔(ms)

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function getText(url, retries = 2) {
  for (let i = 0; ; i++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA } });
      if (res.ok) return res.text();
      throw new Error(`HTTP ${res.status}`);
    } catch (e) {
      if (i >= retries) throw new Error(`${e.message} — ${url}`);
      await sleep(1000 * 2 ** i);
    }
  }
}

// ------------------------------------------------------------------
// 軽量HTMLテーブルパーサ
// ------------------------------------------------------------------
export const stripTags = (s) => s.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();

export const toNum = (v) => {
  if (v == null) return null;
  const n = parseFloat(String(v).replace(/,/g, '').replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : null;
};

export function parseTables(html) {
  const tables = [];
  for (const t of html.matchAll(/<table[^>]*>([\s\S]*?)<\/table>/gi)) {
    const rows = [];
    for (const r of t[1].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
      const cells = [...r[1].matchAll(/<(th|td)[^>]*>([\s\S]*?)<\/\1>/gi)].map((c) => stripTags(c[2]));
      if (cells.length) rows.push(cells);
    }
    if (rows.length) tables.push(rows);
  }
  return tables;
}

// ヘッダ語をすべて含むテーブルを返す（複数該当時は行数が最大のもの）
export function findTable(tables, keywords) {
  let best = null;
  for (const rows of tables) {
    const hIdx = rows.findIndex((r) => keywords.every((k) => r.some((c) => c.includes(k))));
    if (hIdx === -1) continue;
    if (!best || rows.length > best.rows.length) best = { rows, hIdx };
  }
  return best;
}

// 列ヘッダ表から、その列に数値が入っている最後の行の値を取る
// （「前年同期比」などの非数値行を自動的に読み飛ばす）
export function pickByHeader(tables, keyword) {
  for (const rows of tables) {
    const hIdx = rows.findIndex((r) => r.some((c) => c.includes(keyword)));
    if (hIdx === -1) continue;
    const col = rows[hIdx].findIndex((c) => c.includes(keyword));
    const header = rows[hIdx][col];
    const body = rows.slice(hIdx + 1).filter((r) => r.length === rows[hIdx].length);
    for (let i = body.length - 1; i >= 0; i--) {
      const v = toNum(body[i][col]);
      if (v !== null) return { value: v, header };
    }
  }
  return { value: null, header: null };
}

// ------------------------------------------------------------------
// kabuka ページ … 現在値・30日分の終値/出来高・マクロが1枚に載っている
// ------------------------------------------------------------------
export function parseKabuka(html) {
  const tables = parseTables(html);

  const today = findTable(tables, ['本日', '終値']);
  const hist = findTable(tables, ['日付', '終値']);
  if (!hist) throw new Error('時系列テーブルが見つかりません');

  const col = (t, name) => t.rows[t.hIdx].findIndex((c) => c.includes(name));

  const hClose = col(hist, '終値');
  const hVol = col(hist, '売買高');
  const series = hist.rows
    .slice(hist.hIdx + 1)
    .filter((r) => r.length === hist.rows[hist.hIdx].length && toNum(r[hClose]) !== null)
    .map((r) => ({ close: toNum(r[hClose]), vol: toNum(r[hVol]) }))
    .reverse(); // 古い → 新しい

  let price = null, changePct = null, vol = null;
  if (today) {
    const row = today.rows[today.hIdx + 1];
    if (row) {
      price = toNum(row[col(today, '終値')]);
      changePct = toNum(row[col(today, '前日比％')]);
      vol = toNum(row[col(today, '売買高')]);
      series.push({ close: price, vol });
    }
  }
  if (price === null && series.length) {
    price = series.at(-1).close;
    vol = series.at(-1).vol;
  }

  let macro = { nikkei: null, usdjpy: null };
  const mt = findTable(tables, ['日経平均', '米ドル円']);
  if (mt) {
    const row = mt.rows[mt.hIdx + 1];
    if (row) macro = { nikkei: toNum(row[0]), usdjpy: toNum(row[2]) };
  }

  // 市場区分（東証Ｐ/Ｓ/Ｇ）はkabukaページのヘッダに既に載っている。
  // 別ページを叩かなくて済むので、全銘柄フィルターをここに乗せられる。
  const mkt = html.match(/<span class="market">([^<]*)</);
  const market = mkt ? stripTags(mkt[1]) : null;

  return {
    price,
    changePct,
    vol,
    closes: series.map((s) => s.close),
    volumes: series.map((s) => s.vol),
    macro,
    market,
  };
}

export async function fetchIntraday(code) {
  return parseKabuka(await getText(`https://kabutan.jp/stock/kabuka?code=${code}`));
}

// ------------------------------------------------------------------
// 個別ページ … 信用倍率・PER・業種
// ------------------------------------------------------------------
export function parseMain(html) {
  const tables = parseTables(html);
  const loan = pickByHeader(tables, '信用倍率');
  const per = pickByHeader(tables, 'PER');
  // 業種は "/themes/?industry=16&market=1">電気機器" の形で入っている
  const sec = html.match(/href="\/themes\/\?industry=(\d+)[^"]*"[^>]*>([^<]+)</);
  const mkt = html.match(/<span class="market">([^<]*)</);
  return {
    loanRatio: loan.value,
    per: per.value,
    sectorId: sec ? sec[1] : null,
    sectorName: sec ? stripTags(sec[2]) : null,
    market: mkt ? stripTags(mkt[1]) : null,
  };
}

export async function fetchMain(code) {
  return parseMain(await getText(`https://kabutan.jp/stock/?code=${code}`));
}

// ------------------------------------------------------------------
// 東証【業種別】騰落ランキング … 33業種が3ページ（15+15+3）に載っている
//
//  Yahoo/stooq が使えないため、セクターモメンタムはここから取る。
//  1日の騰落率しか載っていないので、複数日のモメンタムは
//  日次で指数値を貯めて後から算出する（screener側で履歴を保持）。
// ------------------------------------------------------------------
export async function fetchSectorMomentum() {
  const out = {};
  for (let p = 1; p <= 3; p++) {
    if (p > 1) await sleep(REQ_GAP);
    const html = await getText(`https://kabutan.jp/warning/?mode=9_1&page=${p}`);
    for (const rows of parseTables(html)) {
      if (!rows[0]?.includes('銘柄数')) continue;
      for (const r of rows.slice(1)) {
        // [コード, 業種名, 銘柄数, '', 指数, '', 前日比, 前日比%, PER, PBR, 利回り]
        const name = r[1];
        const idx = toNum(r[4]);
        const pct = toNum(r[7]);
        if (name && idx !== null) out[name] = { sectorCode: r[0], index: idx, changePct: pct, count: toNum(r[2]) };
      }
    }
  }
  return out;
}

// ------------------------------------------------------------------
// 週次信用残ページ … 買い残/売り残/信用倍率の週次推移（約30週分）
//
//  「スマート・エントリー」3パターンの信用残トレンド判定に使う。
//  kabuka ページのヘッダにある「週次信用残」リンク先（実測: &ashi=shin）。
//  配列は新しい週が先頭（ページ表示順のまま）。
// ------------------------------------------------------------------
export function parseWeeklyCredit(html) {
  const tables = parseTables(html);
  const t = findTable(tables, ['買い残', '信用倍率']);
  if (!t) throw new Error('週次信用残テーブルが見つかりません');
  const header = t.rows[t.hIdx];
  const col = (name) => header.findIndex((c) => c.includes(name));
  const cDate = col('日付'), cBuy = col('買い残'), cSell = col('売り残'), cRatio = col('信用倍率');
  return t.rows
    .slice(t.hIdx + 1)
    .filter((r) => r.length === header.length)
    .map((r) => ({ date: r[cDate], buy: toNum(r[cBuy]), sell: toNum(r[cSell]), loanRatio: toNum(r[cRatio]) }))
    .filter((r) => r.buy !== null);
}

export async function fetchWeeklyCredit(code) {
  return parseWeeklyCredit(await getText(`https://kabutan.jp/stock/kabuka?code=${code}&ashi=shin`));
}

// 決算ページ … 進捗率（SBIの達成率が取れない銘柄の予備）
//
//  見出しは「対通期進捗率」と「対上期進捗率」の2種類がある（実測）。
//  同じ「進捗率」でも分母が通期予想か上期予想かで意味が変わるので、
//  見出しをそのまま返して折返し基準の計算は screener 側に任せる。
//  ここで基準を決め打ちしてはいけない（次回決算期の情報が無いため）。
// 決算実績（決算期,営業益,発表日を持つテーブル全て）から、発表日が最も新しい
// 行の営業益を拾う。年度・中間・四半期のテーブルが複数あり同じ列名を
// 共有しているため、テーブル単位ではなく「発表日」という実日付で最新を
// 判定する（決算期の表記=年度は"2026.03"、中間は"25.04-09"、四半期は
// "24.07-09"とバラバラで期間長の異なる値は直接比較できないが、発表日は
// 全テーブル共通で "23/10/31" 形式の実日付なので文字列比較で安全に最新が
// 取れる）。
function parseLatestOperatingProfit(tables) {
  let latest = null;
  for (const rows of tables) {
    const hIdx = rows.findIndex((r) => ['決算期', '営業益', '発表日'].every((k) => r.some((c) => c.includes(k))));
    if (hIdx === -1) continue;
    const header = rows[hIdx];
    const cPeriod = 0;
    const cOp = header.findIndex((c) => c.includes('営業益'));
    const cDate = header.findIndex((c) => c.includes('発表日'));
    for (const r of rows.slice(hIdx + 1)) {
      if (r.length !== header.length) continue;
      // 「決算期」列に「予」が付く行は会社予想（まだ実現していない数値）。
      // 実測: 同じ発表日に実績行と予想行が同居する（例: 6981の26/07/31は
      // 実績 26.04-06=98,454 と、同時発表の通期予想 2027.03=430,000 が
      // 同日付で並ぶ）。日付だけで最新を決めると予想を実績と誤認するため、
      // 予想行はここで弾く。
      if (r[cPeriod]?.includes('予')) continue;
      const opProfit = toNum(r[cOp]);
      const date = r[cDate];
      if (opProfit === null || !/^\d{2}\/\d{2}\/\d{2}$/.test(date)) continue;
      if (!latest || date > latest.date) latest = { date, opProfit };
    }
  }
  return latest;
}

export async function fetchFinance(code) {
  const tables = parseTables(await getText(`https://kabutan.jp/stock/finance?code=${code}`));
  const prog = pickByHeader(tables, '進捗率');
  const equity = pickByHeader(tables, '自己資本比率');
  const opProfit = parseLatestOperatingProfit(tables);
  return {
    progress: prog.value,
    progressLabel: prog.header ?? null,
    // 赤字/債務超過フィルター用。opProfitDateは「いつ時点の実績か」の表示に使う。
    latestOpProfit: opProfit?.opProfit ?? null,
    latestOpProfitDate: opProfit?.date ?? null,
    equityRatio: equity.value,
  };
}
