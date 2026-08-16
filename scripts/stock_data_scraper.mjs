#!/usr/bin/env node
import { chromium } from 'playwright';

const symbol = process.argv[2];
if (!symbol) {
  console.error('Usage: node scripts/stock_data_scraper.mjs SYMBOL');
  process.exit(1);
}

const symbolEncoded = encodeURIComponent(symbol);
const url = `https://finance.yahoo.com/quote/${symbolEncoded}/technical?p=${symbolEncoded}`;

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 11_0_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  locale: 'en-US',
  viewport: { width: 1280, height: 960 },
});
const page = await context.newPage();

console.log(`Opening ${url} ...`);
try {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForSelector('section[data-test="qsp-technical"]', { timeout: 30000 }).catch(() => null);
  await page.waitForSelector('table', { timeout: 30000 });
} catch (error) {
  console.error('ページ読み込みに失敗しました:', error.message);
  await browser.close();
  process.exit(1);
}

const result = await page.evaluate(() => {
  const firstText = (selector) => {
    const el = document.querySelector(selector);
    return el?.textContent?.trim() || null;
  };

  const price = firstText('fin-streamer[data-field="regularMarketPrice"]');
  const change = firstText('fin-streamer[data-field="regularMarketChangePercent"]');

  const rows = Array.from(document.querySelectorAll('table tr'));
  const values = {};
  for (const row of rows) {
    const cells = Array.from(row.querySelectorAll('td, th')).map((node) => node.textContent?.trim() || '');
    if (cells.length >= 2) {
      const key = cells[0];
      const value = cells[1];
      if (key && value) {
        values[key] = value;
      }
    }
  }

  const getValue = (labels) => {
    for (const label of labels) {
      if (values[label]) {
        return values[label];
      }
      const normalized = Object.keys(values).find((k) => k.toLowerCase() === label.toLowerCase());
      if (normalized) {
        return values[normalized];
      }
    }
    return null;
  };

  return {
    currentPrice: price,
    changePct: change,
    movingAverages: {
      ma50: getValue(['50-Day Moving Average', '50-day moving average', '50 Day Moving Average']),
      ma25: getValue(['25-Day Moving Average', '25-day moving average', '25 Day Moving Average']),
      ma200: getValue(['200-Day Moving Average', '200-day moving average', '200 Day Moving Average']),
    },
    rsi14: getValue(['RSI (14)', 'RSI', 'RSI (14)']),
    rawTable: values,
  };
});

await browser.close();

const output = {
  symbol,
  url,
  data: result,
  timestamp: new Date().toISOString(),
};

console.log(JSON.stringify(output, null, 2));
