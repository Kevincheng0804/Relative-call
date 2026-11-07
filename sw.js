const CACHE = 'relative-call-v2';
const FILES = [
  './', 'index.html', 'style.css', 'app.js', 'manifest.json', 'icon.svg', 'lib/face-api.js',
  'models/tiny_face_detector_model-weights_manifest.json', 'models/tiny_face_detector_model.bin',
  'models/ssd_mobilenetv1_model-weights_manifest.json', 'models/ssd_mobilenetv1_model.bin',
  'models/face_landmark_68_model-weights_manifest.json', 'models/face_landmark_68_model.bin',
  'models/face_recognition_model-weights_manifest.json', 'models/face_recognition_model.bin',
];
self.addEventListener('install', (e) => e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting())));
self.addEventListener('activate', (e) => e.waitUntil(
  caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const heavy = /\/(models|lib)\//.test(e.request.url);
  if (heavy) { e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request))); return; }
  // 程式檔:優先抓最新版,沒網路才用快取
  e.respondWith(fetch(e.request).then((r) => {
    const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); return r;
  }).catch(() => caches.match(e.request)));
});
