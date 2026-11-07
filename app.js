'use strict';
/* 親戚稱謂小幫手 — 全部在手機瀏覽器本機執行,不上傳任何資料 */

const APP_VERSION = 'v1.5';   // 每次更新請一起調整,首頁底部會顯示
const SCENES = { newyear: '過年', clan: '宗親會', all: '全部人' };
const MATCH_THRESHOLD = 0.55;  // 越小越嚴格
const MATCH_MARGIN = 0.04;     // 第一名要比「別人」的最佳距離至少近這麼多,否則視為不確定
const UNKNOWN_SAME = 0.6;      // 兩張臉距離小於此值,視為同一個陌生人
const Q = { score: 0.6, size: 0.10, yaw: 0.35, sharp: 60 };   // 即時辨識的畫質門檻(臉寬佔畫面比例、正臉程度、清晰度)
const NEED_HITS = { known: 2, unknown: 3 };                   // 連續看到幾次才列入清單
const MAX_SAMPLES = 20;        // 每個人最多保留幾張臉部樣本
const $ = (id) => document.getElementById(id);

/* ---------- IndexedDB ---------- */
const DB = {
  db: null,
  mem: null,                 // IndexedDB 不能用時改存記憶體(關掉頁面就消失)
  open() {
    return new Promise((res) => {
      const fail = (e) => { this.mem = new Map(); res(e); };
      try {
        const r = indexedDB.open('relative-call', 1);
        r.onupgradeneeded = () => r.result.createObjectStore('people', { keyPath: 'id' });
        r.onsuccess = () => { this.db = r.result; res(null); };
        r.onerror = () => fail(r.error || new Error('IndexedDB 開啟失敗'));
        r.onblocked = () => fail(new Error('IndexedDB 被封鎖'));
      } catch (e) { fail(e); }
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
  async all() { return this.mem ? [...this.mem.values()] : this.tx('readonly', (s) => s.getAll()); },
  async put(p) { return this.mem ? void this.mem.set(p.id, p) : this.tx('readwrite', (s) => s.put(p)); },
  async del(id) { return this.mem ? void this.mem.delete(id) : this.tx('readwrite', (s) => s.delete(id)); },
  async clearAndPutAll(list) {
    if (this.mem) { this.mem.clear(); list.forEach((p) => this.mem.set(p.id, p)); return; }
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
let seen = [];              // 這次遇到的人 {id, kind:'known'|'unknown', thumb, descriptor, person}(只存在記憶體,重新整理就清空)

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

/* ---------- 這次遇到的人(辨識到與沒辨識到的都列出來) ---------- */
function cropFace(source, box) {
  const sw = source.videoWidth || source.width, sh = source.videoHeight || source.height;
  const m = 0.3;
  const x = Math.max(0, box.x - box.width * m), y = Math.max(0, box.y - box.height * m);
  const w = Math.min(sw - x, box.width * (1 + 2 * m)), h = Math.min(sh - y, box.height * (1 + 2 * m));
  const c = document.createElement('canvas');
  const k = Math.min(1, 200 / Math.max(w, h));
  c.width = Math.max(1, Math.round(w * k)); c.height = Math.max(1, Math.round(h * k));
  c.getContext('2d').drawImage(source, x, y, w, h, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.85);
}
// 加入清單(同一個人不會重複);回傳是否有新增
function addSeen(kind, thumb, descriptor, person) {
  if (kind === 'known') {
    if (seen.some((x) => x.kind === 'known' && x.person.id === person.id)) return false;
  } else if (seen.some((x) => x.kind === 'unknown' && faceapi.euclideanDistance(x.descriptor, descriptor) <= UNKNOWN_SAME)) {
    return false;
  }
  seen.unshift({ id: String(Date.now() + Math.random()), kind, thumb, descriptor, person: person || null });
  if (seen.length > 16) seen.pop();
  return true;
}
// 用照片辨識:直接加入
function rememberFace(source, face, match) {
  return addSeen(match ? 'known' : 'unknown', cropFace(source, face.detection.box), Array.from(face.descriptor), match && match.person);
}

/* 畫質檢查:模糊、側臉、太小的臉不拿去比對 */
function sharpness(source, box) {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(source, box.x, box.y, box.width, box.height, 0, 0, 64, 64);
  const d = ctx.getImageData(0, 0, 64, 64).data, g = new Float32Array(64 * 64);
  for (let i = 0; i < g.length; i++) g[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
  let sum = 0, sq = 0, n = 0;
  for (let y = 1; y < 63; y++) for (let x = 1; x < 63; x++) {
    const i = y * 64 + x, l = 4 * g[i] - g[i - 1] - g[i + 1] - g[i - 64] - g[i + 64];
    sum += l; sq += l * l; n++;
  }
  return sq / n - (sum / n) ** 2;     // 拉普拉斯變異數,越大越清晰
}
function faceQuality(face, source) {
  const W = source.videoWidth || source.width, b = face.detection.box, p = face.landmarks.positions;
  const nose = p[30].x, l = nose - p[0].x, r = p[16].x - nose;
  const yaw = Math.min(l, r) / Math.max(l, r, 1e-6);
  const size = b.width / W, sharp = sharpness(source, b), score = face.detection.score;
  let why = '';
  if (score < Q.score || size < Q.size) why = '請靠近一點';
  else if (yaw < Q.yaw) why = '請看鏡頭';
  else if (sharp < Q.sharp) why = '請拿穩';
  return { ok: !why, why, sharp };
}

/* 連續確認:同一個人要連續認出幾次才列入清單,並挑最清楚的那張當縮圖 */
let pending = [];
function observe(source, face, match, q) {
  const now = Date.now(), d = Array.from(face.descriptor);
  pending = pending.filter((x) => now - x.last < 4000);
  const kind = match ? 'known' : 'unknown';
  let it = match
    ? pending.find((x) => x.kind === 'known' && x.person.id === match.person.id)
    : pending.find((x) => x.kind === 'unknown' && faceapi.euclideanDistance(x.descriptor, d) <= UNKNOWN_SAME);
  if (!it) { it = { kind, person: match ? match.person : null, descriptor: d, hits: 0, sharp: -1, thumb: null }; pending.push(it); }
  it.hits++; it.last = now;
  if (q.sharp > it.sharp) { it.sharp = q.sharp; it.thumb = cropFace(source, face.detection.box); it.descriptor = d; }
  return it.hits >= NEED_HITS[kind] ? addSeen(kind, it.thumb, it.descriptor, it.person) : false;
}

function renderSeen() {
  const box = $('seenBox');
  if (!seen.length) { box.hidden = true; box.innerHTML = ''; return; }
  box.hidden = false;
  box.innerHTML = `<div class="u-head"><b>這次遇到的人</b><button type="button" data-u="clear">全部清除</button></div>
    <div class="u-list">${[...seen].sort((a, b) => (a.kind === 'known' ? 0 : 1) - (b.kind === 'known' ? 0 : 1)).map((u) => u.kind === 'known' ? `
      <div class="u-item known" data-id="${u.id}"><img src="${u.thumb}" alt="">
        <div class="u-t">${esc(u.person.title)}</div>
        <div class="u-n">${esc(u.person.name || '')}</div>
        <div class="u-n">${esc(u.person.note || '')}</div>
        <button type="button" data-u="del">移除</button></div>` : `
      <div class="u-item" data-id="${u.id}"><img src="${u.thumb}" alt="">
        <div class="u-t u-unk">認不出來</div>
        <button type="button" data-u="who">是已建檔的人</button>
        <button type="button" data-u="add">新建檔</button><button type="button" data-u="del">移除</button></div>`).join('')}</div>`;
}
function openPicker(id) {
  const list = people.filter(inScene).sort((a, b) => a.title.localeCompare(b.title, 'zh-Hant'));
  if (!list.length) { alert('這個場合還沒有建檔的人。'); return; }
  $('pickList').innerHTML = list.map((p) => `<button type="button" class="pick" data-pid="${p.id}" data-sid="${id}"><img src="${p.photo}" alt=""><span><b>${esc(p.title)}</b> ${esc(p.name)}</span></button>`).join('');
  $('pickSheet').hidden = false;
}
async function addSample(pid, sid) {
  const p = people.find((x) => x.id === pid), u = seen.find((x) => x.id === sid);
  $('pickSheet').hidden = true;
  if (!p || !u) return;
  p.thumbs = p.thumbs || p.descriptors.map(() => p.photo);
  p.descriptors.push(u.descriptor); p.thumbs.push(u.thumb);
  while (p.descriptors.length > MAX_SAMPLES) { p.descriptors.splice(3, 1); p.thumbs.splice(3, 1); }   // 保留最初幾張,汰換較舊的新增樣本
  await DB.put(p);
  seen = seen.filter((x) => x.id !== sid);
  renderSeen();
}
function enrollSeen(id) {
  const u = seen.find((x) => x.id === id && x.kind === 'unknown'); if (!u) return;
  setTab('add'); resetForm();
  draftPhotos = [{ thumb: u.thumb, descriptor: u.descriptor }];
  renderThumbs();
  $('photoStatus').textContent = '已帶入這張臉,請填寫稱謂,再補幾張不同角度的照片會更準。';
  seen = seen.filter((x) => x.id !== id);
  renderSeen();
}

/* ---------- 比對 ---------- */
function bestMatch(descriptor, pool) {
  let best = null, second = Infinity;
  for (const p of pool) {
    let dist = Infinity;
    for (const d of p.descriptors) dist = Math.min(dist, faceapi.euclideanDistance(descriptor, d));
    if (!best || dist < best.dist) { if (best) second = Math.min(second, best.dist); best = { person: p, dist }; }
    else second = Math.min(second, dist);
  }
  if (!best || best.dist > MATCH_THRESHOLD) return null;
  // 很像兩個人時(第一、第二名太接近)寧可不認,避免認錯
  if (best.dist >= 0.4 && second - best.dist < MATCH_MARGIN) return null;
  return best;
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
  clearTimeout(scanTimer); scanTimer = null; pending = [];
  if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; }
  $('video').srcObject = null;
  const o = $('overlay'); o.getContext('2d').clearRect(0, 0, o.width, o.height);
  $('camToggle').textContent = '開啟相機';
  $('camMsg').hidden = false; $('camMsg').textContent = '按下「開啟相機」開始';
}
async function scanLoop(pool) {
  if (!stream) return;
  const v = $('video'), o = $('overlay');
  if (v.videoWidth) {
    o.width = v.videoWidth; o.height = v.videoHeight;
    const ctx = o.getContext('2d');
    ctx.clearRect(0, 0, o.width, o.height);
    const found = await faceapi.detectAllFaces(v, new faceapi.TinyFaceDetectorOptions({ inputSize: 416, scoreThreshold: 0.5 }))
      .withFaceLandmarks().withFaceDescriptors();
    if (!stream) return;
    let added = false;
    for (const f of found) {
      const q = faceQuality(f, v);
      const m = q.ok ? bestMatch(f.descriptor, pool) : null;
      if (q.ok && observe(v, f, m, q)) added = true;
      const b = f.detection.box;
      const text = !q.ok ? q.why : m ? personLabel(m.person) : '認不出來';
      const color = !q.ok ? '#757575' : m ? '#2e7d32' : '#e0a000';
      ctx.lineWidth = Math.max(3, o.width / 200);
      ctx.strokeStyle = color;
      ctx.strokeRect(b.x, b.y, b.width, b.height);
      const fs = Math.max(20, o.width / 20);
      ctx.font = `bold ${fs}px sans-serif`;
      const tw = ctx.measureText(text).width + 14;
      ctx.fillStyle = color;
      ctx.fillRect(b.x, Math.max(0, b.y - fs - 10), tw, fs + 10);
      ctx.fillStyle = '#fff';
      ctx.fillText(text, b.x + 7, Math.max(fs, b.y - 8));
    }
    if (added) renderSeen();
  }
  scanTimer = setTimeout(() => scanLoop(pool), 350);
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
    if (!found.length) { alert('照片裡沒有偵測到人臉。'); return; }
    let added = false;
    for (const f of found) if (rememberFace(canvas, f, bestMatch(f.descriptor, pool))) added = true;
    if (added) renderSeen();
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
  $('seenBox').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-u]'); if (!b) return;
    if (b.dataset.u === 'clear') seen = [];
    else {
      const id = b.closest('.u-item').dataset.id;
      if (b.dataset.u === 'add') return enrollSeen(id);
      if (b.dataset.u === 'who') return openPicker(id);
      seen = seen.filter((x) => x.id !== id);
    }
    renderSeen();
  });
  $('pickList').addEventListener('click', (e) => { const b = e.target.closest('.pick'); if (b) addSample(b.dataset.pid, b.dataset.sid); });
  $('pickCancel').addEventListener('click', () => { $('pickSheet').hidden = true; });
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

/* ---------- 更新:發現新版就提示,點一下立刻換上 ---------- */
function setupUpdates() {
  const hadController = !!navigator.serviceWorker.controller;
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || reloading) return;      // 第一次安裝不用提示
    $('updateBar').hidden = false;
  });
  $('updateBtn').addEventListener('click', () => { reloading = true; location.reload(); });
  navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then((reg) => {
    reg.update().catch(() => {});
    document.addEventListener('visibilitychange', () => { if (!document.hidden) reg.update().catch(() => {}); });
  }).catch(() => {});
}

(async function init() {
  $('version').textContent = '版本 ' + APP_VERSION;   // 先顯示版本,方便確認是不是新版
  bind();
  const err = await DB.open();
  if (err) {
    const w = $('storageWarn');
    w.hidden = false;
    w.textContent = '⚠️ 這個瀏覽器不允許儲存資料,現在輸入的資料關掉頁面就會消失。' +
      '請改用 Safari(或 Chrome)直接開啟網址,不要用 App 內建瀏覽器,也不要用無痕模式。(原因:' + (err.message || err.name || err) + ')';
  }
  try { people = await DB.all(); } catch (e) { people = []; }
  refreshCounts(); show('home');
  if (!err && 'serviceWorker' in navigator) setupUpdates();
})();
