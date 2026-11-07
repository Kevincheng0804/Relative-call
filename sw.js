const CACHE = 'relative-call-v1';
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
  e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request)));
});
