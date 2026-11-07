'use strict';
/* 親戚稱謂小幫手 — 全部在手機瀏覽器本機執行,不上傳任何資料 */

const SCENES = { newyear: '過年', clan: '宗親會', all: '全部人' };
const MATCH_THRESHOLD = 0.5;   // 越小越嚴格
const $ = (id) => document.getElementById(id);

/* ---------- IndexedDB ---------- */
const DB = {
  db: null,
  open() {
    return new Promise((res, rej) => {
      const r = indexedDB.open('relative-call', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('people', { keyPath: 'id' });
      r.onsuccess = () => { this.db = r.result; res(); };
      r.onerror = () => rej(r.error);
    });
  },
  tx(mode, fn) {
    return new Promise((res, rej) => {
      const t = this.db.transaction('people', mode);
      const out = fn(t.objectStore('people'));
      t.oncomplete = () => res(out && out.result);
      t.onerror = () => rej(t.error);
    });
  },
  all() { return this.tx('readonly', (s) => s.getAll()); },
  put(p) { return this.tx('readwrite', (s) => s.put(p)); },
  del(id) { return this.tx('readwrite', (s) => s.delete(id)); },
  clearAndPutAll(list) {
    return this.tx('readwrite', (s) => { s.clear(); list.forEach((p) => s.put(p)); });
  },
};

/* ---------- 狀態 ---------- */
let people = [];
let scene = null;           // 'newyear' | 'clan' | 'all'
let modelsReady = null;
let stream = null, scanTimer = null, facing = 'environment';
let draftPhotos = [];       // {thumb, descriptor|null}
let editing = null;         // 正在編輯的 person

const inScene = (p) => scene === 'all' || p.groups.includes(scene);

/* ---------- 人臉模型 ---------- */
function loadModels() {
  if (modelsReady) return modelsReady;
  $('loading').hidden = false;
  modelsReady = Promise.all([
    faceapi.nets.tinyFaceDetector.loadFromUri('models'),
    faceapi.nets.ssdMobilenetv1.loadFromUri('models'),
    faceapi.nets.faceLandmark68Net.loadFromUri('models'),
    faceapi.nets.faceRecognitionNet.loadFromUri('models'),
  ]).then(() => { $('loading').hidden = true; })
    .catch((e) => { modelsReady = null; $('loading').hidden = true; alert('載入人臉模型失敗:' + e.message); throw e; });
  return modelsReady;
}

/* ---------- 導覽 ---------- */
function show(view) {
  $('view-home').hidden = view !== 'home';
  $('view-scene').hidden = view !== 'scene';
  $('backBtn').hidden = view === 'home';
  $('title').textContent = view === 'home' ? '親戚稱謂小幫手' : SCENES[scene];
}
function goHome() { stopCamera(); show('home'); refreshCounts(); }
function openScene(s) { scene = s; show('scene'); setTab('scan'); }
function setTab(name) {
  document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  ['scan', 'wall', 'add'].forEach((t) => { $('tab-' + t).hidden = t !== name; });
  if (name !== 'scan') stopCamera();
  if (name === 'wall') renderGrid();
  if (name === 'add' && !editing) resetForm();
}
function refreshCounts() {
  $('count-newyear').textContent = people.filter((p) => p.groups.includes('newyear')).length + ' 人';
  $('count-clan').textContent = people.filter((p) => p.groups.includes('clan')).length + ' 人';
}

/* ---------- 影像工具 ---------- */
function fileToImage(file) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = rej;
    img.src = URL.createObjectURL(file);
  });
}
function makeThumb(source, size = 240) {
  const w = source.videoWidth || source.naturalWidth || source.width;
  const h = source.videoHeight || source.naturalHeight || source.height;
  const s = Math.min(1, size / Math.min(w, h));
  const c = document.createElement('canvas');
  c.width = Math.round(w * s); c.height = Math.round(h * s);
  c.getContext('2d').drawImage(source, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.8);
}
// 縮小大圖以加快偵測
function downscale(img, max = 900) {
  const w = img.naturalWidth, h = img.naturalHeight, s = Math.min(1, max / Math.max(w, h));
  const c = document.createElement('canvas');
  c.width = Math.round(w * s); c.height = Math.round(h * s);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  return c;
}
// 偵測並回傳「最大那張臉」的特徵
async function describeBiggest(canvas) {
  const all = await faceapi.detectAllFaces(canvas, new faceapi.SsdMobilenetv1Options({ minConfidence: 0.5 }))
    .withFaceLandmarks().withFaceDescriptors();
  if (!all.length) return null;
  all.sort((a, b) => b.detection.box.area - a.detection.box.area);
  return { descriptor: Array.from(all[0].descriptor), count: all.length };
}

/* ---------- 比對 ---------- */
function bestMatch(descriptor, pool) {
  let best = null;
  for (const p of pool) {
    for (const d of p.descriptors) {
      const dist = faceapi.euclideanDistance(descriptor, d);
      if (!best || dist < best.dist) best = { person: p, dist };
    }
  }
  return best && best.dist <= MATCH_THRESHOLD ? best : null;
}
function personLabel(p) { return p.name ? `${p.title}(${p.name})` : p.title; }

/* ---------- 相機辨識 ---------- */
async function startCamera() {
  const pool = people.filter((p) => inScene(p) && p.descriptors.length);
  if (!pool.length) { $('camMsg').hidden = false; $('camMsg').textContent = '這個場合還沒有建檔的人,先到「＋ 新增」加入。'; return; }
  await loadModels();
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: facing, width: { ideal: 960 } }, audio: false });
  } catch (e) {
    $('camMsg').hidden = false;
    $('camMsg').textContent = '無法開啟相機:' + e.message + '(請允許相機權限,且需使用 https)';
    return;
  }
  const v = $('video');
  v.srcObject = stream;
  await v.play();
  $('camMsg').hidden = true;
  $('camToggle').textContent = '關閉相機';
  scanLoop(pool);
}
function stopCamera() {
  clearTimeout(scanTimer); scanTimer = null;
  if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; }
  $('video').srcObject = null;
  const o = $('overlay'); o.getContext('2d').clearRect(0, 0, o.width, o.height);
  $('camToggle').textContent = '開啟相機';
  $('camMsg').hidden = false; $('camMsg').textContent = '按下「開啟相機」開始';
  $('result').innerHTML = '';
}
async function scanLoop(pool) {
  if (!stream) return;
  const v = $('video'), o = $('overlay');
  if (v.videoWidth) {
    o.width = v.videoWidth; o.height = v.videoHeight;
    const ctx = o.getContext('2d');
    ctx.clearRect(0, 0, o.width, o.height);
    const found = await faceapi.detectAllFaces(v, new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.5 }))
      .withFaceLandmarks().withFaceDescriptors();
    if (!stream) return;
    const rows = [];
    for (const f of found) {
      const m = bestMatch(f.descriptor, pool);
      const b = f.detection.box;
      const text = m ? personLabel(m.person) : '認不出來';
      ctx.lineWidth = Math.max(3, o.width / 200);
      ctx.strokeStyle = m ? '#2e7d32' : '#e0a000';
      ctx.strokeRect(b.x, b.y, b.width, b.height);
      const fs = Math.max(20, o.width / 20);
      ctx.font = `bold ${fs}px sans-serif`;
      const tw = ctx.measureText(text).width + 14;
      ctx.fillStyle = m ? '#2e7d32' : '#e0a000';
      ctx.fillRect(b.x, Math.max(0, b.y - fs - 10), tw, fs + 10);
      ctx.fillStyle = '#fff';
      ctx.fillText(text, b.x + 7, Math.max(fs, b.y - 8));
      rows.push({ m, area: b.width * b.height });
    }
    rows.sort((a, b) => b.area - a.area);
    renderResults(rows.map((r) => r.m));
  }
  scanTimer = setTimeout(() => scanLoop(pool), 350);
}
function renderResults(matches) {
  if (!matches.length) { $('result').innerHTML = '<div class="res unknown">畫面中沒有偵測到人臉</div>'; return; }
  $('result').innerHTML = matches.map((m) => m
    ? `<div class="res"><img src="${m.person.photo}" alt=""><div><div class="t">叫他:${esc(m.person.title)}</div><div class="n">${esc(m.person.name || '')} ${esc(m.person.note || '')}</div></div></div>`
    : '<div class="res unknown">認不出來 — 可以到「照片牆」手動找</div>').join('');
}

async function scanFromPhoto(file) {
  const pool = people.filter((p) => inScene(p) && p.descriptors.length);
  if (!pool.length) { alert('這個場合還沒有建檔的人。'); return; }
  await loadModels();
  $('loading').hidden = false;
  try {
    const canvas = downscale(await fileToImage(file));
    const found = await faceapi.detectAllFaces(canvas, new faceapi.SsdMobilenetv1Options({ minConfidence: 0.5 }))
      .withFaceLandmarks().withFaceDescriptors();
    found.sort((a, b) => b.detection.box.area - a.detection.box.area);
    renderResults(found.map((f) => bestMatch(f.descriptor, pool)));
  } finally { $('loading').hidden = true; }
}

/* ---------- 照片牆 ---------- */
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function renderGrid() {
  const q = $('search').value.trim().toLowerCase();
  const list = people.filter(inScene)
    .filter((p) => !q || [p.title, p.name, p.note].join(' ').toLowerCase().includes(q))
    .sort((a, b) => a.title.localeCompare(b.title, 'zh-Hant'));
  $('grid').innerHTML = list.length ? list.map((p) => `
    <div class="card" data-id="${p.id}">
      <img src="${p.photo}" alt="">
      <div class="b">
        <div class="t">${esc(p.title)}</div>
        <div class="n">${esc(p.name)}</div>
        <div class="m">${esc(p.note)}</div>
        <div class="a"><button data-act="edit">編輯</button><button data-act="del">刪除</button></div>
      </div>
    </div>`).join('') : '<div class="empty">沒有符合的人</div>';
}

/* ---------- 新增 / 編輯 ---------- */
function resetForm() {
  editing = null; draftPhotos = [];
  $('form').reset(); $('f-id').value = '';
  if (scene && scene !== 'all') $('g-' + scene).checked = true;
  $('cancelEdit').hidden = true; $('saveBtn').textContent = '儲存';
  renderThumbs(); $('photoStatus').textContent = '';
}
function renderThumbs() {
  $('thumbs').innerHTML = draftPhotos.map((p, i) =>
    `<div class="th"><img src="${p.thumb}" alt=""><button type="button" data-i="${i}" aria-label="移除">×</button></div>`).join('');
}
async function addPhotos(files) {
  if (!files.length) return;
  await loadModels();
  const st = $('photoStatus');
  let ok = 0, bad = 0;
  $('loading').hidden = false;
  try {
    for (const f of files) {
      st.textContent = `處理中…(${ok + bad + 1}/${files.length})`;
      const img = await fileToImage(f);
      const r = await describeBiggest(downscale(img));
      if (!r) { bad++; continue; }
      draftPhotos.push({ thumb: makeThumb(img), descriptor: r.descriptor }); ok++;
    }
  } finally { $('loading').hidden = true; }
  renderThumbs();
  st.textContent = `已加入 ${ok} 張` + (bad ? `,${bad} 張找不到人臉(已略過)` : '') + `。目前共 ${draftPhotos.length} 張。`;
}
async function savePerson(e) {
  e.preventDefault();
  const groups = ['newyear', 'clan'].filter((g) => $('g-' + g).checked);
  if (!groups.length) { alert('請至少選一個場合。'); return; }
  if (!draftPhotos.length) { alert('請至少加入一張有人臉的照片。'); return; }
  const p = {
    id: editing ? editing.id : (crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random())),
    title: $('f-title').value.trim(),
    name: $('f-name').value.trim(),
    note: $('f-note').value.trim(),
    groups,
    photo: draftPhotos[0].thumb,
    descriptors: draftPhotos.map((d) => d.descriptor),
    thumbs: draftPhotos.map((d) => d.thumb),
  };
  await DB.put(p);
  people = await DB.all();
  const wasEditing = !!editing;
  resetForm(); refreshCounts();
  setTab('wall');
  if (!wasEditing) alert('已儲存!');
}
function startEdit(id) {
  const p = people.find((x) => x.id === id); if (!p) return;
  setTab('add'); editing = p;
  $('f-title').value = p.title; $('f-name').value = p.name; $('f-note').value = p.note;
  $('g-newyear').checked = p.groups.includes('newyear'); $('g-clan').checked = p.groups.includes('clan');
  const th = p.thumbs || [p.photo];
  draftPhotos = p.descriptors.map((d, i) => ({ thumb: th[i] || p.photo, descriptor: d }));
  renderThumbs();
  $('photoStatus').textContent = `目前 ${draftPhotos.length} 張照片,可再加入或移除。`;
  $('cancelEdit').hidden = false; $('saveBtn').textContent = '更新';
}

/* ---------- 備份 ---------- */
function exportData() {
  const blob = new Blob([JSON.stringify({ v: 1, people }, null, 0)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `親戚稱謂備份-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
}
async function importData(file) {
  try {
    const data = JSON.parse(await file.text());
    if (!Array.isArray(data.people)) throw new Error('格式不正確');
    if (!confirm(`將以備份內的 ${data.people.length} 人取代目前資料,確定嗎?`)) return;
    await DB.clearAndPutAll(data.people);
    people = await DB.all(); refreshCounts();
  } catch (e) { alert('匯入失敗:' + e.message); }
}

/* ---------- 事件 ---------- */
function bind() {
  document.querySelectorAll('[data-scene]').forEach((b) => b.addEventListener('click', () => openScene(b.dataset.scene)));
  $('backBtn').addEventListener('click', goHome);
  document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => setTab(b.dataset.tab)));
  $('camToggle').addEventListener('click', () => (stream ? stopCamera() : startCamera()));
  $('camFlip').addEventListener('click', async () => {
    facing = facing === 'environment' ? 'user' : 'environment';
    if (stream) { stopCamera(); await startCamera(); }
  });
  $('scanPhoto').addEventListener('change', (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) scanFromPhoto(f); });
  $('search').addEventListener('input', renderGrid);
  $('grid').addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-act]'); if (!btn) return;
    const id = btn.closest('.card').dataset.id;
    if (btn.dataset.act === 'edit') startEdit(id);
    else if (confirm('確定刪除這個人?')) { await DB.del(id); people = await DB.all(); refreshCounts(); renderGrid(); }
  });
  $('form').addEventListener('submit', savePerson);
  ['f-cam', 'f-photos'].forEach((id) => $(id).addEventListener('change', (e) => { const fs = [...e.target.files]; e.target.value = ''; addPhotos(fs); }));
  $('thumbs').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-i]'); if (!b) return;
    draftPhotos.splice(+b.dataset.i, 1); renderThumbs();
  });
  $('cancelEdit').addEventListener('click', () => { resetForm(); setTab('wall'); });
  $('exportBtn').addEventListener('click', exportData);
  $('importFile').addEventListener('change', (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) importData(f); });
  document.addEventListener('visibilitychange', () => { if (document.hidden) stopCamera(); });
}

(async function init() {
  await DB.open();
  people = await DB.all();
  bind(); refreshCounts(); show('home');
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
})();
