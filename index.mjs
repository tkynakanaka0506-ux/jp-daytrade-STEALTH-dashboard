import fs from 'fs';
import path from 'path';
import os from 'os';
import { exec } from 'child_process';
import { chromium } from 'playwright';

const targetPath = '/Users/takuya/Desktop/保存/mjs保存先';
const icloudCandidate = path.join(os.homedir(), 'Library/Mobile Documents/com~apple~CloudDocs/Desktop/保存/mjs保存先');
const saveDir = fs.existsSync(targetPath) ? targetPath : fs.existsSync(icloudCandidate) ? icloudCandidate : targetPath;

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function openFinder(dir) {
  exec(`open ${JSON.stringify(dir)}`, (err) => {
    if (err) {
      console.error('Finder を開けませんでした:', err.message);
    } else {
      console.log('✅ Finder を開きました:', dir);
    }
  });
}

console.log('=== スクリーンショット保存診断 ===');
console.log('ホームディレクトリ:', os.homedir());
console.log('カレントディレクトリ:', process.cwd());
console.log('指定パス:', targetPath);
console.log('iCloud候補パス:', icloudCandidate);
console.log('有効な保存先:', saveDir);

ensureDir(saveDir);
const savePath = path.join(saveDir, 'screenshot.png');
console.log('スクリーンショット保存先:', savePath);

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
await page.goto('https://www.google.com', { waitUntil: 'networkidle' });
await page.screenshot({ path: savePath, fullPage: true });
await browser.close();

if (fs.existsSync(savePath)) {
  console.log('✅ 保存完了:', savePath);
} else {
  console.error('❌ 保存失敗: ファイルが見つかりません');
}
openFinder(saveDir);
