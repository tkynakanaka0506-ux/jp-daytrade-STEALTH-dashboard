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

// th/td一対の行（見出し+値の2セル行）からキーワード一致する行の値を拾う。
// pickByHeader が前提とする「見出し行→複数の本体行」という表形式ではなく、
// 「時価総額」「発行済株式数」のように1行=1項目で載っている箇所に使う。
export function pickRowValue(tables, keyword) {
  for (const rows of tables) {
    for (const r of rows) {
      if (r[0]?.includes(keyword)) {
        const v = toNum(r[1]);
        if (v !== null) return v;
      }
    }
  }
  return null;
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

  const hOpen = col(hist, '始値');
  const hHigh = col(hist, '高値');
  const hLow = col(hist, '安値');
  const hClose = col(hist, '終値');
  const hVol = col(hist, '売買高');
  const series = hist.rows
    .slice(hist.hIdx + 1)
    .filter((r) => r.length === hist.rows[hist.hIdx].length && toNum(r[hClose]) !== null)
    .map((r) => ({
      open: toNum(r[hOpen]), high: toNum(r[hHigh]), low: toNum(r[hLow]),
      close: toNum(r[hClose]), vol: toNum(r[hVol]),
    }))
    .reverse(); // 古い → 新しい

  let price = null, changePct = null, vol = null;
  if (today) {
    const row = today.rows[today.hIdx + 1];
    if (row) {
      price = toNum(row[col(today, '終値')]);
      changePct = toNum(row[col(today, '前日比％')]);
      vol = toNum(row[col(today, '売買高')]);
      series.push({
        open: toNum(row[col(today, '始値')]), high: toNum(row[col(today, '高値')]),
        low: toNum(row[col(today, '安値')]), close: price, vol,
      });
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
    opens: series.map((s) => s.open),
    highs: series.map((s) => s.high),
    lows: series.map((s) => s.low),
    closes: series.map((s) => s.close),
    volumes: series.map((s) => s.vol),
    macro,
    market,
  };
}

export async function fetchIntraday(code) {
  return parseKabuka(await getText(`https://kabutan.jp/stock/kabuka?code=${code}`));
}

// kabukaページの&page=Nで過去分に遡れる（実測: 1ページ=約30営業日、
// page2は page1 の最古日の前日から更に約30営業日）。セリングクライマックス
// 判定は直近15営業日+20日平均の基準が要るため35日以上欲しいが、
// 通常の1ページ(30日)だけでは足りない。候補銘柄だけに絞って呼ぶ用途
// （全銘柄には使わない＝コストが見合わないため）。
export async function fetchIntradayExtended(code, pages = 2) {
  const base = await fetchIntraday(code);
  let opens = base.opens, highs = base.highs, lows = base.lows, closes = base.closes, volumes = base.volumes;
  for (let p = 2; p <= pages; p++) {
    await sleep(REQ_GAP);
    let tables;
    try {
      tables = parseTables(await getText(`https://kabutan.jp/stock/kabuka?code=${code}&page=${p}`));
    } catch {
      break; // これ以上遡れない/取得失敗。ここまでの日数で判定する
    }
    const hist = findTable(tables, ['日付', '終値']);
    if (!hist) break;
    const header = hist.rows[hist.hIdx];
    const col = (name) => header.findIndex((c) => c.includes(name));
    const hOpen = col('始値'), hHigh = col('高値'), hLow = col('安値'), hClose = col('終値'), hVol = col('売買高');
    const older = hist.rows
      .slice(hist.hIdx + 1)
      .filter((r) => r.length === header.length && toNum(r[hClose]) !== null)
      .map((r) => ({
        open: toNum(r[hOpen]), high: toNum(r[hHigh]), low: toNum(r[hLow]),
        close: toNum(r[hClose]), vol: toNum(r[hVol]),
      }))
      .reverse(); // ページ内は新→古なので古→新に揃える
    if (!older.length) break;
    opens = [...older.map((o) => o.open), ...opens];
    highs = [...older.map((o) => o.high), ...highs];
    lows = [...older.map((o) => o.low), ...lows];
    closes = [...older.map((o) => o.close), ...closes];
    volumes = [...older.map((o) => o.vol), ...volumes];
  }
  return { ...base, opens, highs, lows, closes, volumes };
}

// ------------------------------------------------------------------
// 個別ページ … 信用倍率・PER・業種
// ------------------------------------------------------------------
export function parseMain(html) {
  const tables = parseTables(html);
  const loan = pickByHeader(tables, '信用倍率');
  const per = pickByHeader(tables, 'PER');
  const pbr = pickByHeader(tables, 'PBR');
  const dividendYield = pickByHeader(tables, '利回り');
  // 「時価総額」「発行済株式数」は見出し+値の1行完結セルなのでpickRowValueで拾う。
  // 時価総額は億円単位（実測: "1,819億円"）なので百万円に揃える（×100）。
  const marketCapOku = pickRowValue(tables, '時価総額');
  // 業種は "/themes/?industry=16&market=1">電気機器" の形で入っている
  const sec = html.match(/href="\/themes\/\?industry=(\d+)[^"]*"[^>]*>([^<]+)</);
  const mkt = html.match(/<span class="market">([^<]*)</);
  return {
    loanRatio: loan.value,
    per: per.value,
    pbr: pbr.value,
    dividendYield: dividendYield.value,
    marketCap: marketCapOku !== null ? marketCapOku * 100 : null, // 百万円
    sharesOutstanding: pickRowValue(tables, '発行済株式数'),
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
        if (name && idx !== null) {
          // 業種平均PER/PBR/利回り。個別銘柄と比べて「業種内でどの位置に
          // あるか」を見る用（このページは既に取得済みなので追加リクエスト
          // は無し）。
          out[name] = {
            sectorCode: r[0], index: idx, changePct: pct, count: toNum(r[2]),
            per: toNum(r[8]), pbr: toNum(r[9]), dividendYield: toNum(r[10]),
          };
        }
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
// 決算期テーブルから「直近の実績値」を1つ拾う共通ヘルパー。
//
// ■ 再発防止の経緯
// この関数ができる前は、営業益・自己資本・ROEをそれぞれ別々のコードで
// 個別に抽出しており、「決算期セルの『予』始まり行＝会社予想（まだ実現
// していない数値）を除外する」というガードを、なぜかROEの抽出コードにだけ
// 入れ忘れていた（実測: 7921で会社予想ROE 10.79 を実績 10.78 の代わりに
// 表示してしまっていたバグ）。同じ抽出パターンを3箇所に手書きで複製する
// 限り、この種の「1箇所だけガードを書き忘れる」再発を防げないため、
// 抽出ロジックそのものを1つの関数に統合した。
//
// 発表日列がある表（営業益・財務系）は発表日の実日付で最新行を比較する
// （決算期の表記は年度/半期/四半期でバラバラな期間長のため直接比較できない
// が、発表日は全テーブル共通で"23/10/31"形式なので文字列比較で安全）。
// 発表日列が無い表（ROEなど収益性テーブル）は、テーブル内の掲載順（古→新）
// をそのまま信頼し、予想行を除いた最後の行を採用する。
export function pickLatestActual(tables, { findKeywords, valueKeyword, exactValueMatch = false }) {
  const t = findTable(tables, findKeywords);
  if (!t) return null;
  const header = t.rows[t.hIdx];
  const cPeriod = 0;
  // '自己資本'は'自己資本比率'の部分文字列でもあるため、まず完全一致を
  // 優先する（includes()だけだと比率(%)の列を誤って掴む）。
  const exact = exactValueMatch ? header.findIndex((c) => c === valueKeyword) : -1;
  const cVal = exact !== -1 ? exact : header.findIndex((c) => c.includes(valueKeyword));
  const cDate = header.findIndex((c) => c.includes('発表日'));
  let latest = null;
  for (const r of t.rows.slice(t.hIdx + 1)) {
    if (r.length !== header.length) continue;
    // 「決算期」列に「予」が付く行は会社予想（まだ実現していない数値）。
    // 実測: 同じ発表日に実績行と予想行が同居する（例: 6981の26/07/31は
    // 実績 26.04-06=98,454 と、同時発表の通期予想 2027.03=430,000 が
    // 同日付で並ぶ）。日付だけで最新を決めると予想を実績と誤認するため、
    // 予想行はここで必ず弾く。
    if (r[cPeriod]?.includes('予')) continue;
    const v = toNum(r[cVal]);
    if (v === null) continue;
    if (cDate !== -1) {
      const date = r[cDate];
      if (!/^\d{2}\/\d{2}\/\d{2}$/.test(date)) continue;
      if (!latest || date > latest.date) latest = { date, value: v };
    } else {
      latest = { date: null, value: v }; // 発表日列が無い表は掲載順(古→新)を信頼する
    }
  }
  return latest;
}

function parseLatestOperatingProfit(tables) {
  const r = pickLatestActual(tables, { findKeywords: ['決算期', '営業益', '発表日'], valueKeyword: '営業益' });
  return r ? { date: r.date, opProfit: r.value } : null;
}

// 現金等残高・総資産・自己資本（ネットネット判定用）は「決算期,発表日」を
// 持つ財務テーブルから発表日最新の行を拾う。
function parseLatestBalance(tables, keyword) {
  const r = pickLatestActual(tables, { findKeywords: [keyword, '発表日'], valueKeyword: keyword, exactValueMatch: true });
  return r?.value ?? null;
}

// 通期決算（決算期が"YYYY.MM"の年度表記のみ、四半期/中間は対象外）の
// 売上高を新しい順に2期ぶん拾い、直近の前期比成長率(%)を返す。
// 売上債権(IR Bank)の伸びと比較して「回収サイクルが伸びていないか」の
// 判定に使う。粒度をkabutan/IR Bank双方とも年度決算に揃えることで、
// 四半期と年度を誤って比較しない（実測: 決算期の書式で見分けられる）。
export function parseAnnualRevenueYoY(tables) {
  const rowsAll = [];
  for (const rows of tables) {
    const hIdx = rows.findIndex((r) => ['決算期', '売上高', '発表日'].every((k) => r.some((c) => c.includes(k))));
    if (hIdx === -1) continue;
    const header = rows[hIdx];
    const cPeriod = 0;
    const cSales = header.findIndex((c) => c.includes('売上高'));
    for (const r of rows.slice(hIdx + 1)) {
      if (r.length !== header.length) continue;
      if (r[cPeriod]?.includes('予')) continue; // 会社予想はまだ実現していない数値
      // 決算期表記には先頭に会計基準の注記「I 」（IFRS等、実測:6981）や
      // 末尾に「*」（実測:456A）が付くことがある。年度判定そのものには
      // 影響しないので除去してから判定する。
      const period = (r[cPeriod] ?? '').replace(/^I\s+/, '').replace(/\*$/, '');
      if (!/^\d{4}\.\d{2}$/.test(period)) continue; // 年度決算のみ（四半期/中間を除く）
      const sales = toNum(r[cSales]);
      if (sales === null) continue;
      // このテーブルは古い年度の発表日を「－」としか出さない実測がある
      // （456A: 2023〜2025年度は発表日なし、2026年度のみ実日付）ため、
      // 発表日の有無では絞らず、テーブル内の掲載順（古→新の実測）を使う。
      rowsAll.push({ period, sales });
    }
  }
  const uniq = [...new Map(rowsAll.map((r) => [r.period, r])).values()].sort((a, b) => a.period.localeCompare(b.period));
  if (uniq.length < 2) return null;
  const [prev, latest] = uniq.slice(-2);
  if (prev.sales === 0) return null;
  return { growthPct: Math.round(((latest.sales - prev.sales) / prev.sales) * 1000) / 10, latestPeriod: latest.period, prevPeriod: prev.period };
}

// 決算のクセ（季節性）— 次回がQ1（当期最初の四半期）の銘柄は進捗率の
// 分母が定義できず常にN/Aになるが（reportedQuarters('1Q')=0）、過去の
// 同じ四半期(Q1)が年間実績に占めていた比率が分かれば「1Q発表を待たずに
// どの程度を期待してよいか」の目安になる。kabutanの四半期実績テーブル
// （純粋な単四半期。中間/累計/年度ではない行、書式"YY.MM-MM"で判別）を
// 決算期の新しい順に並べ、直近行から4行おきに遡ってQ1を特定する
// （「次回1Q」＝直前の開示がQ4という定義そのものを使い、テーブル末尾を
// Q4と仮定する。他の四半期(2Q/3Q)が次回のケースへの一般化はしていない）。
export function parseQ1Seasonality(tables) {
  const rowsAll = [];
  for (const rows of tables) {
    const hIdx = rows.findIndex((r) => ['決算期', '営業益', '発表日'].every((k) => r.some((c) => c.includes(k))));
    if (hIdx === -1) continue;
    const header = rows[hIdx];
    const cOp = header.findIndex((c) => c.includes('営業益'));
    for (const r of rows.slice(hIdx + 1)) {
      if (r.length !== header.length) continue;
      // "YY.MM-MM"という書式は単四半期(3ヶ月, 例:06-08)にも中間累計
      // (6ヶ月, 例:06-11)にも使われ、文字列パターンだけでは区別できない
      // （実測: 7921で両方が混在し、中間累計を単四半期と誤認していた）。
      // 開始月・終了月の差から実際の月数を計算し、3ヶ月の行だけを残す。
      const m = r[0]?.match(/^\d{2}\.(\d{2})-(\d{2})$/);
      if (!m) continue;
      const span = ((Number(m[2]) - Number(m[1]) + 12) % 12) + 1;
      if (span !== 3) continue;
      const op = toNum(r[cOp]);
      if (op === null) continue;
      rowsAll.push({ period: r[0], op });
    }
  }
  const uniq = [...new Map(rowsAll.map((r) => [r.period, r])).values()].sort((a, b) => a.period.localeCompare(b.period));
  const n = uniq.length;
  if (n < 4) return null; // 四半期実績が1年分も無い

  const years = [];
  for (let idx = n - 4; idx >= 0; idx -= 4) {
    const q1 = uniq[idx];
    const annual = q1.op + uniq[idx + 1].op + uniq[idx + 2].op + uniq[idx + 3].op;
    if (annual === 0) continue;
    years.push({ period: q1.period, q1Profit: q1.op, annualProfit: annual, sharePct: Math.round((q1.op / annual) * 1000) / 10 });
  }
  if (!years.length) return null;
  const avgSharePct = Math.round((years.reduce((s, y) => s + y.sharePct, 0) / years.length) * 10) / 10;
  return { years, avgSharePct };
}

export async function fetchFinance(code) {
  const tables = parseTables(await getText(`https://kabutan.jp/stock/finance?code=${code}`));
  const prog = pickByHeader(tables, '進捗率');
  const equity = pickByHeader(tables, '自己資本比率');
  const opProfit = parseLatestOperatingProfit(tables);
  return {
    progress: prog.value,
    progressLabel: prog.header ?? null,
    // ネットネット判定用（簡易版・現金ベース。売掛金の内訳データは非対応）。
    latestTotalAssets: parseLatestBalance(tables, '総資産'),
    latestEquity: parseLatestBalance(tables, '自己資本'),
    // 現金等残高テーブルには発表日が無いため決算期の新しい順（末尾）で拾う。
    latestCash: (() => {
      const t = findTable(tables, ['現金等残高']);
      if (!t) return null;
      const header = t.rows[t.hIdx];
      const cPeriod = 0, cCash = header.findIndex((c) => c.includes('現金等残高'));
      for (let i = t.rows.length - 1; i > t.hIdx; i--) {
        const r = t.rows[i];
        if (r.length !== header.length || r[cPeriod]?.includes('予')) continue;
        const v = toNum(r[cCash]);
        if (v !== null) return v;
      }
      return null;
    })(),
    // 赤字/債務超過フィルター用。opProfitDateは「いつ時点の実績か」の表示に使う。
    latestOpProfit: opProfit?.opProfit ?? null,
    latestOpProfitDate: opProfit?.date ?? null,
    equityRatio: equity.value,
    // 売上債権の伸びとの比較用（年度決算ベースの前期比成長率）。
    revenueGrowth: parseAnnualRevenueYoY(tables),
    // 次回がQ1で進捗率がN/Aになる銘柄向けの「決算のクセ」参考値。
    q1Seasonality: parseQ1Seasonality(tables),
    // 同業他社比較用のROE（最新期）。業種平均ROEはkabutan側に該当する
    // ページが見当たらず非対応（個別銘柄の値のみ表示する）。
    // 予想行の除外はpickLatestActual側で共通処理する（後述のコメント参照）。
    latestRoe: pickLatestActual(tables, { findKeywords: ['ＲＯＥ', '売上営業利益率'], valueKeyword: 'ＲＯＥ' })?.value ?? null,
  };
}
