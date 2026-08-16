#!/usr/bin/env node
import { chromium } from 'playwright';

const symbol = process.argv[2];
if (!symbol) {
  console.error('Usage: node scripts/stock_dashboard.mjs SYMBOL');
  process.exit(1);
}

const parseNumber = (value) => {
  if (value == null) return null;
  const cleaned = String(value).replace(/,/g, '').replace(/%/g, '').trim();
  const num = Number(cleaned);
  return Number.isFinite(num) ? num : null;
};

const parse52Week = (value) => {
  if (!value) return { low: null, high: null };
  const parts = value.split(' - ').map((p) => parseNumber(p));
  return {
    low: parts[0] || null,
    high: parts[1] || null,
  };
};

const trendClassifier = ({ price, ma50, ma200, rsi14, high52 }) => {
  const above200 = price != null && ma200 != null && price >= ma200;
  const above50 = price != null && ma50 != null && price >= ma50;
  const nearHigh = high52 != null && price != null ? price / high52 >= 0.75 : false;
  const pullbackPct = high52 != null && price != null ? ((high52 - price) / high52) * 100 : null;

  const isInitialPull = above200 && above50 && nearHigh && pullbackPct != null && pullbackPct >= 3 && pullbackPct <= 15 && rsi14 != null && rsi14 >= 35 && rsi14 <= 65;
  const isCrash = (price != null && ma200 != null && price < ma200) || (rsi14 != null && rsi14 < 30) || (pullbackPct != null && pullbackPct >= 25);

  if (isInitialPull) {
    return {
      signal: '高値圏からの初押し',
      confidence: 'medium',
      reasons: [
        '価格は200日線上・50日線上で、上昇トレンド継続の初押しと判定',
        `高値からの押し目幅は${pullbackPct != null ? pullbackPct.toFixed(1) + '%' : '不明'}です`,
      ],
    };
  }

  if (isCrash) {
    const downReason = [];
    if (price != null && ma200 != null && price < ma200) downReason.push('200日線割れ');
    if (rsi14 != null && rsi14 < 30) downReason.push('RSI 30以下');
    if (pullbackPct != null && pullbackPct >= 25) downReason.push('高値から25%以上下落');
    return {
      signal: 'ただの暴落',
      confidence: 'high',
      reasons: [`${downReason.join(' / ')} に該当`],
    };
  }

  return {
    signal: '判定保留',
    confidence: 'low',
    reasons: ['トレンド判定に十分な強弱がありません'],
  };
};

const resolveYahooSymbol = async (page, symbol) => {
  const url = `https://finance.yahoo.com/quote/${encodeURIComponent(symbol)}`;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(1500);
  const actualUrl = page.url();

  const isLookup = await page.evaluate(() => {
    const title = document.title || '';
    const body = document.body.innerText || '';
    const hasLookupTable = !!document.querySelector('table tbody tr');
    const hasSymbolLookup = /symbol lookup/i.test(title) || /symbol lookup/i.test(body) || /symbols similar to/i.test(body);
    return hasSymbolLookup || hasLookupTable;
  });

  if (!isLookup && actualUrl.includes('/quote/')) {
    const matched = actualUrl.match(/\/quote\/([^/?]+)/);
    if (matched) return matched[1];
  }

  if (isLookup) {
    const resolved = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('table tbody tr'));
      for (const row of rows) {
        const cells = Array.from(row.querySelectorAll('td'));
        if (cells.length >= 2) {
          const symbolText = cells[0].textContent?.trim();
          if (symbolText) return symbolText;
        }
      }
      return null;
    });
    return resolved;
  }

  return null;
};

const lookupValue = (values, labels) => {
  for (const label of labels) {
    if (values[label]) return values[label];
    const key = Object.keys(values).find((k) => k.toLowerCase() === label.toLowerCase());
    if (key) return values[key];
  }
  return null;
};

const extractRowValues = (rows) => {
  const values = {};
  for (const row of rows) {
    const cells = Array.from(row.querySelectorAll('td, th')).map((node) => node.textContent?.trim() || '');
    if (cells.length >= 2) {
      values[cells[0]] = cells[1];
    }
  }
  return values;
};

const extractRange = (rows) => {
  let rangeValue = null;
  for (const row of rows) {
    const cells = Array.from(row.querySelectorAll('td, th')).map((node) => node.textContent?.trim() || '');
    if (cells.length >= 2) {
      const label = cells[0].replace(/\s+/g, ' ').toLowerCase();
      if (label.includes('52 week range') || label.includes('52週範囲')) {
        rangeValue = cells[1];
        break;
      }
    }
  }
  return rangeValue;
};

async function fetchStockData(symbol) {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 11_0_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
    locale: 'en-US',
    viewport: { width: 1280, height: 960 },
  });
  const page = await context.newPage();
  const resolvedSymbol = await resolveYahooSymbol(page, symbol) || symbol;
  const summaryUrl = `https://finance.yahoo.com/quote/${encodeURIComponent(resolvedSymbol)}`;
  const technicalUrl = `https://finance.yahoo.com/quote/${encodeURIComponent(resolvedSymbol)}/technical?p=${encodeURIComponent(resolvedSymbol)}`;

  const result = {
    symbol,
    resolvedSymbol,
    summaryUrl,
    technicalUrl,
    scraped: {},
    timestamp: new Date().toISOString(),
  };

  try {
    await page.goto(summaryUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForSelector('fin-streamer[data-field="regularMarketPrice"]', { timeout: 30000 });
    await page.waitForTimeout(1500);

    const summaryData = await page.evaluate(() => {
      const text = (selector) => document.querySelector(selector)?.textContent?.trim() || null;
      const rows = Array.from(document.querySelectorAll('section[data-test="qsp-statistics"] tr, section[data-test="qsp-summary"] tr, table tr'));
      return {
        price: text('fin-streamer[data-field="regularMarketPrice"]'),
        changePct: text('fin-streamer[data-field="regularMarketChangePercent"]'),
        range52: (() => {
          for (const row of rows) {
            const cells = Array.from(row.querySelectorAll('td, th')).map((node) => node.textContent?.trim() || '');
            if (cells.length >= 2 && /52\s*week\s*range/i.test(cells[0])) {
              return cells[1];
            }
          }
          return null;
        })(),
      };
    });

    result.scraped.summary = summaryData;
  } catch (error) {
    result.scraped.summaryError = error.message;
  }

  try {
    await page.goto(technicalUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(2000);
    await page.waitForSelector('table', { timeout: 30000 });

    const technicalData = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('table tr'));
      const values = {};
      for (const row of rows) {
        const cells = Array.from(row.querySelectorAll('td, th')).map((node) => node.textContent?.trim() || '');
        if (cells.length >= 2) {
          values[cells[0]] = cells[1];
        }
      }

      const lookup = (labels) => {
        for (const label of labels) {
          if (values[label]) return values[label];
          const normalized = Object.keys(values).find((k) => k.toLowerCase() === label.toLowerCase());
          if (normalized) return values[normalized];
        }
        return null;
      };

      return {
        ma25: lookup(['25-Day Moving Average', '25-day moving average', '25 Day Moving Average']),
        ma50: lookup(['50-Day Moving Average', '50-day moving average', '50 Day Moving Average']),
        ma200: lookup(['200-Day Moving Average', '200-day moving average', '200 Day Moving Average']),
        rsi14: lookup(['RSI (14)', 'RSI', 'RSI (14)']),
        rawTable: values,
      };
    });

    result.scraped.technical = technicalData;
  } catch (error) {
    result.scraped.technicalError = error.message;
  }

  await browser.close();
  return result;
}

const main = async () => {
  const data = await fetchStockData(symbol);
  const price = parseNumber(data.scraped.summary?.price);
  const changePct = parseNumber(data.scraped.summary?.changePct);
  const range52 = parse52Week(data.scraped.summary?.range52);
  const ma25 = parseNumber(data.scraped.technical?.ma25);
  const ma50 = parseNumber(data.scraped.technical?.ma50);
  const ma200 = parseNumber(data.scraped.technical?.ma200);
  const rsi14 = parseNumber(data.scraped.technical?.rsi14);

  const classification = trendClassifier({
    price,
    ma25,
    ma50,
    ma200,
    rsi14,
    high52: range52.high,
    low52: range52.low,
  });

  const output = {
    ...data,
    analysis: {
      price,
      changePct,
      range52,
      ma25,
      ma50,
      ma200,
      rsi14,
      classification,
    },
  };

  console.log(JSON.stringify(output, null, 2));
};

await main();
