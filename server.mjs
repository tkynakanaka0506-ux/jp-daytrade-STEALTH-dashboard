// ==================================================================
// server.mjs — index.html を LAN に配信する常駐サーバー（依存ゼロ）
//
//  ■ なぜ必要か
//  iCloud経由だとiPhoneでは「ファイル」アプリのプレビューで開かれ、
//  Safariのタブとして扱われない（＝ブックマーク/ホーム画面追加/自動リロード
//  が期待通りに動かない）。Safariで普通のURLとして開くには HTTP で
//  配信する必要がある。
//
//  ■ python3 -m http.server を使わない理由
//  (1) Cache-Control を付けられない。Safariはキャッシュが強く、更新しても
//      古いHTMLを表示し続ける（＝「ちゃんと更新されない」の主因）。
//  (2) 同じディレクトリを丸ごと公開してしまう。ここには
//      tdnet_cache.json (1.2MB) や ambush_cache.json が置かれており、
//      ディレクトリ一覧から誰でも取れてしまう。
//  そのため許可したパスだけを返す最小サーバーを自前で持つ。
//
//  ■ 公開範囲
//  0.0.0.0 にbindするので、同じWi-Fiにいる端末からは誰でも見られる。
//  認証は付けていない（家庭内LAN前提）。カフェ等の共有Wi-Fiでは
//  BIND=127.0.0.1 で起動すること。
// ==================================================================
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT ?? 8765);
const BIND = process.env.BIND ?? '0.0.0.0';

// 明示的な許可リスト。ここに無いものは404。
// キャッシュJSON等を絶対に出さないため、パスの組み立てはしない。
const ROUTES = {
  '/': 'index.html',
  '/index.html': 'index.html',
};

const nowJst = () => new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });

function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    // Safariに古いHTMLを握らせない。これが無いと
    // 生成し直しても画面が変わらない。
    'Cache-Control': 'no-store, must-revalidate',
    'Pragma': 'no-cache',
    'Expires': '0',
    'X-Content-Type-Options': 'nosniff',
    'Content-Length': Buffer.byteLength(body),
    ...headers,
  });
  res.end(body);
}

const errorPage = (title, detail) => `<!DOCTYPE html><html lang="ja"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark"><title>${title}</title></head>
<body style="margin:0;padding:40px 24px;background:#05060a;color:#e6edf6;
font:15px/1.7 -apple-system,BlinkMacSystemFont,'Hiragino Sans',sans-serif">
<h1 style="font-size:19px;margin:0 0 14px">${title}</h1>
<p style="color:#8b98ab;margin:0">${detail}</p>
</body></html>`;

const server = http.createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return send(res, 405, errorPage('405', 'GET のみ受け付けます。'), { Allow: 'GET, HEAD' });
  }

  // クエリ・ハッシュを落としてから許可リストに照合する
  const pathname = decodeURIComponent((req.url ?? '/').split('?')[0].split('#')[0]);
  const file = ROUTES[pathname];

  if (!file) {
    return send(res, 404, errorPage('404', `${pathname} は配信していません。 / を開いてください。`));
  }

  let html;
  try {
    html = fs.readFileSync(path.join(__dirname, file));
  } catch {
    // まだ一度もスクレイプしていない、あるいは生成中に落ちた場合
    return send(res, 503, errorPage(
      'まだ生成されていません',
      'index.html がありません。寄り前バッチ（平日07:00）を待つか、<code>node scraper.mjs</code> を実行してください。',
    ));
  }

  if (req.method === 'HEAD') {
    return send(res, 200, Buffer.alloc(0), { 'Content-Length': html.length });
  }
  return send(res, 200, html);
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`❌ ポート ${PORT} は使用中です。既にサーバーが動いていないか確認してください。`);
    process.exit(1);
  }
  throw e;
});

// Bonjour名はDHCPでIPが変わっても追随するので、こちらを主に案内する
function hostnames() {
  const out = [];
  const local = os.hostname().replace(/\.local\.?$/, '');
  if (local) out.push(`http://${local}.local:${PORT}/`);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const n of list ?? []) {
      if (n.family === 'IPv4' && !n.internal) out.push(`http://${n.address}:${PORT}/`);
    }
  }
  return out;
}

server.listen(PORT, BIND, () => {
  console.log(`🛰  AMBUSH server 起動 ${nowJst()}  (bind ${BIND}:${PORT})`);
  for (const u of hostnames()) console.log(`    ${u}`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log(`🛑 ${sig} 受信 — 停止します ${nowJst()}`);
    server.close(() => process.exit(0));
  });
}
