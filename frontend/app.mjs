import {createDocument, addPoint, deletePoint, undo, applyDetection, nearestPoint, metrics, exportRecord, keepRecent} from './model.mjs';

const $ = id => document.getElementById(id);
const canvas = $('photoCanvas');
const context = canvas.getContext('2d');
const viewport = $('viewport');
let documents = [], current = null, mode = 'edit', zoom = 1, fitScale = 1;
let busy = false, requestController = null, requestGeneration = 0, loadGeneration = 0;
let pointer = null, message = '选好照片，就可以开始了。', messageError = false;
let requiresToken = false;
const hints = {edit:'点击空白补点，点击红点删点。放大后检查更清楚。', add:'点击种子中心补上一个红点。', erase:'点击需要删除的红点。', pan:'拖动照片查看其他区域；也可以用滚动条移动。'};

function options() {
  return {background: $('background').value, sensitivity: Number($('sensitivity').value),
    min_area_percent: Number($('minArea').value), split: $('split').value};
}

function status(text, error = false) { message = text; messageError = error; renderStatus(); }
function renderStatus() { $('statusMessage').textContent = message; $('statusMessage').classList.toggle('error', messageError); }

function dispose(doc) {
  URL.revokeObjectURL(doc.url);
  doc.image.src = '';
  doc.file = null;
  doc.image = null;
  doc.points = [];
  doc.history = [];
  doc.result = null;
}

function cancelRequest(showMessage = true) {
  requestGeneration++;
  requestController?.abort();
  requestController = null;
  busy = false;
  if (showMessage) status('请求已取消。服务器会在本次处理结束后清理照片。');
  render();
}

async function selectFile(file) {
  if (!file) return;
  const load = ++loadGeneration;
  if (file.size > 20 * 1024 * 1024) return status('照片不能超过 20 MB，请选择较小的照片。', true);
  if (!/\.(jpe?g|png|webp)$/i.test(file.name) && !['image/jpeg','image/png','image/webp'].includes(file.type)) {
    return status('请使用 JPG、PNG 或 WebP。iPhone 可在相机设置中选择“兼容性最佳”。', true);
  }
  const url = URL.createObjectURL(file);
  const image = new Image();
  image.src = url;
  try {
    await image.decode();
    if (load !== loadGeneration) { URL.revokeObjectURL(url); image.src = ''; return; }
    if (image.naturalWidth * image.naturalHeight > 24_000_000 || Math.min(image.naturalWidth, image.naturalHeight) < 32) {
      throw new Error('请使用不超过 2400 万像素、宽高至少 32 像素的照片。');
    }
    cancelRequest(false);
    const doc = createDocument(file, image, url);
    documents = keepRecent(documents, doc, dispose);
    current = doc;
    zoom = 1;
    $('showDots').checked = true;
    status('照片已就绪。点击“开始识别”，或直接手动补点。');
    render();
    fit();
  } catch (error) {
    URL.revokeObjectURL(url);
    image.src = '';
    status(error.message === 'The source image cannot be decoded.' ? '无法显示照片，请重新选择 JPG、PNG 或 WebP。' : error.message, true);
  }
}

function choose(input) { $(input).value = ''; $(input).click(); }
for (const id of ['chooseEmpty','chooseButton']) $(id).addEventListener('click', () => choose('fileInput'));
for (const id of ['cameraEmpty','cameraButton']) $(id).addEventListener('click', () => choose('cameraInput'));
for (const id of ['fileInput','cameraInput']) $(id).addEventListener('change', event => selectFile(event.target.files[0]));
// File inputs must not keep a third File reference after the two-photo buffer evicts it.
for (const id of ['fileInput','cameraInput']) $(id).addEventListener('change', () => { $(id).value = ''; });

function render() {
  const loaded = Boolean(current);
  $('emptyState').hidden = loaded;
  $('editor').hidden = !loaded;
  $('photoName').textContent = loaded ? current.file.name : '还没有照片';
  $('photoName').title = loaded ? current.file.name : '';
  $('clearButton').disabled = !loaded;
  $('detectButton').disabled = !loaded || busy;
  $('detectButton').classList.toggle('busy', busy);
  $('detectButton').querySelector('.button-label').textContent = busy ? '正在上传并识别…' : (current?.result ? '重新识别' : '开始识别');
  $('cancelButton').hidden = !busy;
  $('undoButton').disabled = !loaded || busy || !current.history.length;
  for (const id of ['exportImage','exportData','coordinateAdd','deleteById','confirmButton']) $(id).disabled = !loaded || busy;
  document.querySelectorAll('[data-mode]').forEach(button => { button.disabled = busy; });
  $('showDots').disabled = busy;
  const data = loaded ? metrics(current) : null;
  $('count').textContent = loaded ? data.count : '—';
  $('autoCount').textContent = data?.auto ?? '—';
  $('manualCount').textContent = loaded ? `${data.adjustment > 0 ? '+' : ''}${data.adjustment}` : '—';
  $('reviewCount').textContent = data ? (current.confirmed ? '已复核' : data.review) : '—';
  $('resultState').textContent = busy ? '识别中' : !loaded ? '等待照片' : current.confirmed ? '已人工确认' : current.result ? '请复核' : current.points.length ? '人工标记' : '照片就绪';
  $('countSubtitle').textContent = current?.confirmed ? '已确认 · 结果以当前红点总数为准' : '以当前照片上的红点总数为准';
  $('warnings').replaceChildren();
  $('warnings').hidden = !current?.warnings.length;
  for (const warning of current?.warnings ?? []) { const p = document.createElement('p'); p.textContent = warning; $('warnings').append(p); }
  $('recentPhotos').replaceChildren();
  documents.forEach((doc, index) => {
    const button = document.createElement('button');
    button.classList.toggle('active', doc === current);
    button.setAttribute('aria-pressed', String(doc === current));
    const thumbnail = document.createElement('img'); thumbnail.src = doc.url; thumbnail.alt = '';
    const label = document.createElement('span'); label.textContent = `${index + 1} · ${doc.file.name}`;
    button.append(thumbnail, label);
    button.addEventListener('click', () => { if (doc === current) return; cancelRequest(false); current = doc; zoom = 1; status('已切换照片，标记保留。'); render(); fit(); });
    $('recentPhotos').append(button);
  });
  $('coordinateX').max = loaded ? current.width - 0.01 : 0;
  $('coordinateY').max = loaded ? current.height - 0.01 : 0;
  renderStatus();
  if (loaded) draw();
}

function fit() {
  if (!current) return;
  fitScale = Math.min((viewport.clientWidth - 32) / current.width, (viewport.clientHeight - 32) / current.height);
  fitScale = Math.max(0.001, fitScale);
  draw();
  viewport.scrollLeft = 0;
  viewport.scrollTop = 0;
}

function draw() {
  if (!current) return;
  const scale = fitScale * zoom;
  const visibleWidth = current.width * scale;
  const visibleHeight = current.height * scale;
  canvas.style.width = `${visibleWidth}px`;
  canvas.style.height = `${visibleHeight}px`;
  // Bound display backing store; full-resolution input remains available for
  // recognition/export, while displaying the page uses no model inference.
  const resolution = Math.min(window.devicePixelRatio || 1, 2, 2600 / Math.max(visibleWidth, visibleHeight));
  canvas.width = Math.max(1, Math.round(visibleWidth * resolution));
  canvas.height = Math.max(1, Math.round(visibleHeight * resolution));
  context.setTransform(canvas.width / current.width, 0, 0, canvas.height / current.height, 0, 0);
  context.drawImage(current.image, 0, 0, current.width, current.height);
  if ($('showDots').checked) drawPoints(context, current.points, 4.5 / scale, false);
  $('zoomLabel').textContent = `${Math.round(zoom * 100)}%`;
  $('zoomOut').disabled = zoom <= 1;
  $('zoomIn').disabled = zoom >= 10;
}

function drawPoints(ctx, points, radius, numbers) {
  points.forEach((point, index) => {
    ctx.beginPath(); ctx.arc(point.x, point.y, radius, 0, Math.PI * 2);
    ctx.fillStyle = '#ed343e'; ctx.fill();
    ctx.strokeStyle = '#fff'; ctx.lineWidth = Math.max(0.6, radius * 0.22); ctx.stroke();
    if (point.review && !current.confirmed) { ctx.beginPath(); ctx.arc(point.x, point.y, radius * 1.65, 0, Math.PI * 2); ctx.strokeStyle = '#e2aa27'; ctx.lineWidth = radius * 0.3; ctx.stroke(); }
    if (numbers) { ctx.font = `${Math.max(10, radius * 2.2)}px sans-serif`; ctx.lineWidth = radius * 0.5; ctx.strokeStyle = '#fff'; ctx.strokeText(String(index + 1), point.x + radius * 2, point.y); ctx.fillStyle = '#b92430'; ctx.fillText(String(index + 1), point.x + radius * 2, point.y); }
  });
}

function setZoom(value) {
  if (!current) return;
  const old = zoom;
  zoom = Math.max(1, Math.min(10, value));
  const centerX = viewport.scrollLeft + viewport.clientWidth / 2;
  const centerY = viewport.scrollTop + viewport.clientHeight / 2;
  draw();
  viewport.scrollLeft = centerX * zoom / old - viewport.clientWidth / 2;
  viewport.scrollTop = centerY * zoom / old - viewport.clientHeight / 2;
}
$('zoomIn').addEventListener('click', () => setZoom(zoom * 1.5));
$('zoomOut').addEventListener('click', () => setZoom(zoom / 1.5));
$('fitButton').addEventListener('click', () => { zoom = 1; fit(); });
$('showDots').addEventListener('change', draw);
new ResizeObserver(() => { if (current) { fitScale = Math.max(.001, Math.min((viewport.clientWidth - 32) / current.width, (viewport.clientHeight - 32) / current.height)); draw(); } }).observe(viewport);

document.querySelectorAll('[data-mode]').forEach(button => button.addEventListener('click', () => {
  mode = button.dataset.mode;
  document.querySelectorAll('[data-mode]').forEach(item => { const active = item.dataset.mode === mode; item.classList.toggle('selected', active); item.setAttribute('aria-pressed', String(active)); });
  canvas.style.cursor = mode === 'pan' ? 'grab' : 'crosshair';
  canvas.style.touchAction = mode === 'pan' ? 'none' : 'pan-x pan-y';
  $('editHint').textContent = hints[mode];
}));
canvas.addEventListener('pointerdown', event => {
  if (!current || busy) return;
  if (pointer) { pointer = null; return; }
  pointer = {id: event.pointerId, x: event.clientX, y: event.clientY, moved: false, left: viewport.scrollLeft, top: viewport.scrollTop};
  if (mode === 'pan') { canvas.setPointerCapture(event.pointerId); canvas.style.cursor = 'grabbing'; }
});
canvas.addEventListener('pointermove', event => {
  if (!pointer || pointer.id !== event.pointerId) return;
  if (Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y) > 6) pointer.moved = true;
  if (mode === 'pan') { viewport.scrollLeft = pointer.left - (event.clientX - pointer.x); viewport.scrollTop = pointer.top - (event.clientY - pointer.y); }
});
canvas.addEventListener('pointercancel', () => { pointer = null; });
canvas.addEventListener('pointerleave', () => { if (mode !== 'pan') pointer = null; });
canvas.addEventListener('pointerup', event => {
  const start = pointer; pointer = null;
  if (mode === 'pan') { canvas.style.cursor = 'grab'; return; }
  if (!start || start.id !== event.pointerId || start.moved || !current || busy) return;
  if (!$('showDots').checked) return status('请先打开“显示红点”，再修改标记。', true);
  const rect = canvas.getBoundingClientRect();
  const x = (event.clientX - rect.left) / rect.width * current.width;
  const y = (event.clientY - rect.top) / rect.height * current.height;
  const index = nearestPoint(current, x, y, 13 / (fitScale * zoom));
  let changed = false;
  if ((mode === 'edit' || mode === 'erase') && index >= 0) changed = deletePoint(current, index);
  else if (mode !== 'erase') changed = addPoint(current, x, y);
  if (changed) { status('标记已更新，数量已同步。'); render(); }
});

function undoEdit() { if (current && !busy && undo(current)) { status('已撤销上一步。'); render(); } }
$('undoButton').addEventListener('click', undoEdit);
document.addEventListener('keydown', event => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z' && !['INPUT','SELECT','TEXTAREA'].includes(event.target.tagName)) { event.preventDefault(); undoEdit(); }
});
$('coordinateAdd').addEventListener('click', () => {
  if (!current || busy) return;
  const x = $('coordinateX').value === '' ? NaN : Number($('coordinateX').value);
  const y = $('coordinateY').value === '' ? NaN : Number($('coordinateY').value);
  if (addPoint(current, x, y)) { status('已按坐标补点。'); render(); } else status('请输入照片范围内的有效 X、Y 坐标。', true);
});
$('deleteById').addEventListener('click', () => {
  if (!current || busy) return;
  if (deletePoint(current, Number($('pointId').value) - 1)) { status('已删除指定红点，编号按当前顺序重新排列。'); render(); } else status('请输入有效的红点编号。', true);
});
$('sensitivity').addEventListener('input', () => { $('sensitivityValue').value = $('sensitivity').value; });
$('clearButton').addEventListener('click', () => {
  ++loadGeneration; cancelRequest(false);
  documents.forEach(dispose); documents = []; current = null;
  canvas.width = 1; canvas.height = 1;
  $('fileInput').value = ''; $('cameraInput').value = '';
  status('照片和标记已从当前页面清空。'); render();
});
$('cancelButton').addEventListener('click', () => cancelRequest());

function approveReplace() {
  if (!current.edited) return Promise.resolve(true);
  const dialog = $('replaceDialog');
  return new Promise(resolve => { dialog.addEventListener('close', () => resolve(dialog.returnValue === 'confirm'), {once:true}); dialog.returnValue = 'cancel'; dialog.showModal(); });
}

$('detectButton').addEventListener('click', async () => {
  if (!current || busy) return;
  const doc = current;
  if (!await approveReplace() || doc !== current || busy) return;
  if (requiresToken && !$('accessToken').value) { status('服务器设置了访问口令，请在“访问口令与精确修正”中输入。', true); document.querySelector('.advanced').open = true; $('accessToken').focus(); return; }
  busy = true;
  const generation = ++requestGeneration;
  const controller = new AbortController(); requestController = controller;
  const timeout = setTimeout(() => controller.abort('timeout'), 120_000);
  const selectedOptions = options();
  status('正在上传并识别，请稍候。'); render();
  try {
    const headers = {'Content-Type':'application/octet-stream'};
    if ($('accessToken').value) headers.Authorization = `Bearer ${$('accessToken').value}`;
    const response = await fetch(`/api/detect?${new URLSearchParams(selectedOptions)}`, {
      method:'POST', headers, body:doc.file, signal:controller.signal, cache:'no-store',
    });
    const result = await response.json();
    if (!response.ok) throw new Error(typeof result.detail === 'string' ? result.detail : '识别请求失败，请检查设置后重试。');
    if (generation !== requestGeneration || doc !== current) return;
    result.options = selectedOptions;
    applyDetection(doc, result);
    $('showDots').checked = true;
    status(`识别完成，共标记 ${doc.points.length} 粒。用时 ${(result.elapsed_ms / 1000).toFixed(1)} 秒，请检查并修正。`);
  } catch (error) {
    if (generation !== requestGeneration) return;
    if (controller.signal.aborted) status('请求超时。请稍后重试；服务器仍会完成清理。', true);
    else status(error instanceof TypeError ? '无法连接识别服务，请检查网络或服务器是否启动。' : error.message, true);
  } finally {
    clearTimeout(timeout);
    if (generation === requestGeneration) { busy = false; requestController = null; render(); }
  }
});

function filename(suffix) { return `${current.file.name.replace(/\.[^.]+$/, '')}-count-${current.points.length}${suffix}`; }
function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
$('exportData').addEventListener('click', () => {
  if (!current || busy) return;
  download(new Blob([JSON.stringify(exportRecord(current, options()), null, 2)], {type:'application/json'}), filename('.json'));
  status('计数数据已导出，包含每个红点的坐标。');
});
$('exportImage').addEventListener('click', () => {
  if (!current || busy) return;
  const doc = current, name = filename('.jpg');
  const output = document.createElement('canvas');
  // Export is a display operation, not recognition; cap the annotated file to
  // 3000 px to avoid allocating an extra full-resolution canvas on a phone.
  const scale = Math.min(1, 3000 / Math.max(doc.width, doc.height));
  const footer = 54;
  output.width = Math.round(doc.width * scale); output.height = Math.round(doc.height * scale) + footer;
  const ctx = output.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, output.width, output.height);
  ctx.save(); ctx.scale(scale, scale); ctx.drawImage(doc.image, 0, 0);
  drawPoints(ctx, doc.points, Math.max(3, Math.max(doc.width, doc.height) / 450), false); ctx.restore();
  ctx.fillStyle = '#173f32'; ctx.fillRect(0, output.height - footer, output.width, footer);
  ctx.fillStyle = '#fff'; ctx.font = `${Math.min(22, Math.max(10, output.width / 22))}px sans-serif`;
  ctx.fillText(`稻粒  ${doc.points.length} 粒 · ${doc.confirmed ? '已人工确认' : '请复核'}`, 14, output.height - 20);
  output.toBlob(blob => { if (blob) download(blob, name); else status('导出失败，请重试。', true); output.width = 1; output.height = 1; }, 'image/jpeg', .94);
});
$('confirmButton').addEventListener('click', () => {
  if (!current || busy) return;
  current.confirmed = true;
  status(`已确认本张照片共有 ${current.points.length} 粒。可以导出结果。`);
  render();
});

window.addEventListener('pagehide', () => {
  ++loadGeneration; cancelRequest(false); documents.forEach(dispose); documents = []; current = null;
  $('accessToken').value = ''; $('fileInput').value = ''; $('cameraInput').value = ''; canvas.width = 1; canvas.height = 1;
  render(); // remove thumbnail DOM references even when the browser uses BFCache
});
window.addEventListener('pageshow', event => { if (event.persisted) { status('页面已恢复，请重新选择照片。'); render(); } });

fetch('/api/health', {cache:'no-store'}).then(response => response.json()).then(result => {
  requiresToken = result.requires_token;
  if (requiresToken) { document.querySelector('.advanced').open = true; if (!current) status('请选择照片，并输入服务器访问口令。'); }
}).catch(() => status('识别服务暂时无法连接。你仍可以选图手动标点。', true));
render();
