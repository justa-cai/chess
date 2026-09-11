/**
 * 为 GitHub Pages 响应补充 COOP/COEP，使 SharedArrayBuffer 与 WASM pthread 可用。
 */

'use strict';

if (typeof window === 'undefined') {
  self.addEventListener('install', function () { self.skipWaiting(); });
  self.addEventListener('activate', function (event) {
    event.waitUntil(self.clients.claim());
  });
  self.addEventListener('fetch', function (event) {
    if (event.request.cache === 'only-if-cached' && event.request.mode !== 'same-origin') return;
    event.respondWith(fetch(event.request).then(function (response) {
      const headers = new Headers(response.headers);
      headers.set('Cross-Origin-Opener-Policy', 'same-origin');
      headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: headers
      });
    }));
  });
} else if ('serviceWorker' in navigator && !window.crossOriginIsolated) {
  navigator.serviceWorker.register('./coi-serviceworker.js').then(function () {
    if (!navigator.serviceWorker.controller) {
      return navigator.serviceWorker.ready.then(function () { window.location.reload(); });
    }
  }).catch(function (error) {
    console.error('Pikafish 多线程隔离环境初始化失败：', error);
  });
}
