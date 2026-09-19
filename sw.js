// sw.js — 最小構成のService Worker。
//
// このダッシュボードは株価・シグナルの鮮度が命なので、index.html を
// キャッシュして「更新したのに古い画面が出る」事故を起こしてはいけない
// （server.mjsがCache-Control: no-storeを付けているのと同じ理由）。
// そのため今はオフラインキャッシュを一切行わず、fetchはネットワークへ
// そのまま素通しするだけにしてある。
//
// 今回追加した目的は「PWAとしてインストール可能にする」ための最低条件
// （Service Workerの登録実績）を満たすことと、将来のPush通知に備えて
// pushイベントの受け口だけ用意しておくこと。
self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', () => {
  // 何もしない = ブラウザの通常のネットワーク処理に任せる。
});

// 将来のPush通知用（現状はHTTPS化していないため送信元は無く、
// このイベントが発火することはまだ無い）。
self.addEventListener('push', (event) => {
  if (!event.data) return;
  let payload;
  try {
    payload = event.data.json();
  } catch (e) {
    payload = { title: 'STEALTH', body: event.data.text() };
  }
  event.waitUntil(
    self.registration.showNotification(payload.title ?? 'STEALTH', {
      body: payload.body ?? '',
      icon: '/icon-192.png',
      badge: '/icon-192.png',
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(self.clients.openWindow(event.notification.data?.url ?? '/'));
});
