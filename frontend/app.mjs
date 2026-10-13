import {createDocument, addPoint, deletePoint, undo, applyDetection, nearestPoint, metrics, exportRecord, keepRecent} from './model.mjs';

import {viewSize, viewToImage, imageTransform} from './view.mjs';
import {setupCamera} from './camera.mjs';

const $ = id => document.getElementById(id);
const canvas = $('photoCanvas');
const context = canvas.getContext('2d');
const viewport = $('viewport');
const baseCanvas = $('baseCanvas'), baseContext = baseCanvas.getContext('2d');
let baseDocument = null, baseRotation = null, rangeAnchor = null;
let documents = [], current = null, mode = 'edit', zoom = 1, fitScale = 1;
let busy = false, requestController = null, requestGeneration = 0, loadGeneration = 0;
let loading = false;
let pointer = null, message = '选好照片，就可以开始了。', messageError = false;
let requiresToken = false;
const hints = {edit:'点击空白补点，点击红点删点。上下滑动页面；放大后用“移动”查看照片。', add:'点击种子中心补上一个红点。', erase:'点击需要删除的红点。', pan:'拖动照片查看其他区域；也可以用滚动条移动。', roi:'依次点击白纸范围的两个对角，框住全部种子；选好后点击开始识别。'};

function options() {
  const selected = {background: $('background').value, sensitivity: Number($('sensitivity').value),
    min_area_percent: Number($('minArea').value), split: $('split').value};
  if (current?.roi) selected.roi = current.roi.map(value => Number(value.toFixed(6))).join(',');
  return selected;
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
  if (file.size > 20 * 1024 * 1024) return status('照片不能超过 20 MB，请选择较小的照片。', true);
  if (!/\.(jpe?g|png|webp)$/i.test(file.name) && !['image/jpeg','image/png','image/webp'].includes(file.type)) {
    return status('请使用 JPG、PNG 或 WebP。iPhone 可在相机设置中选择“兼容性最佳”。', true);
  }
  const load = ++loadGeneration;
  const url = URL.createObjectURL(file);
  const image = new Image();
  image.src = url;
  loading = true;
  status('正在打开照片，请稍候。');
  render();
  try {
    await image.decode();
    if (load !== loadGeneration) { URL.revokeObjectURL(url); image.src = ''; return; }
    if (image.naturalWidth * image.naturalHeight > 24_000_000 || Math.min(image.naturalWidth, image.naturalHeight) < 32) {
      throw new Error('请使用不超过 2400 万像素、宽高至少 32 像素的照片。');
    }
    loading = false;
    cancelRequest(false);
    const doc = createDocument(file, image, url);
    doc.rotation = 0;
    documents = keepRecent(documents, doc, dispose);
    current = doc; rangeAnchor = null;
    zoom = 1;
    $('showDots').checked = true;
    status('照片已就绪。点击“开始识别”，或直接手动补点。');
    render();
    fit();
  } catch (error) {
    URL.revokeObjectURL(url);
    image.src = '';
    if (load === loadGeneration) status(error.message === 'The source image cannot be decoded.' ? '无法显示照片，请重新选择 JPG、PNG 或 WebP。' : error.message, true);
  } finally {
    if (load === loadGeneration) { loading = false; render(); }
  }
}

function choose(input) { $(input).value = ''; $(input).click(); }
for (const id of ['chooseEmpty','chooseButton']) $(id).addEventListener('click', () => choose('fileInput'));
const camera = setupCamera({onPhoto: selectFile, onFallback: () => choose('cameraInput')});
for (const id of ['cameraEmpty','cameraButton']) $(id).addEventListener('click', camera.open);
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
  $('detectButton').disabled = !loaded || busy || loading;
  $('detectButton').classList.toggle('busy', busy);
  $('detectButton').querySelector('.button-label').textContent = loading ? '正在打开照片…' : busy ? '正在上传并识别…' : (current?.result ? '重新识别' : '开始识别');
  $('cancelButton').hidden = !busy;
  $('undoButton').disabled = !loaded || busy || loading || !current.history.length;
  for (const id of ['exportImage','exportData','coordinateAdd','deleteById','confirmButton','resetRange','rotateButton']) $(id).disabled = !loaded || busy || loading;
  document.querySelectorAll('[data-mode]').forEach(button => { button.disabled = busy || loading; });
  $('showDots').disabled = busy;
  const data = loaded ? metrics(current) : null;
  $('count').textContent = loaded ? data.count : '—';
  $('autoCount').textContent = data?.auto ?? '—';
  $('manualCount').textContent = loaded ? `${data.adjustment > 0 ? '+' : ''}${data.adjustment}` : '—';
  $('reviewCount').textContent = data ? (current.confirmed ? '已复核' : data.review) : '—';
  $('resultState').textContent = busy ? '识别中' : !loaded ? '等待照片' : current.rangeDirty ? '请重新识别' : current.confirmed ? '已人工确认' : current.result ? '请复核' : current.points.length ? '人工标记' : '照片就绪';
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
    button.addEventListener('click', () => { if (doc === current) return; ++loadGeneration; loading = false; cancelRequest(false); current = doc; rangeAnchor = null; zoom = 1; status('已切换照片，标记保留。'); render(); fit(); });
    $('recentPhotos').append(button);
  });
  $('coordinateX').max = loaded ? current.width - 0.01 : 0;
  $('coordinateY').max = loaded ? current.height - 0.01 : 0;
  $('rangeHint').textContent = current?.rangeDirty ? '识别范围已改变，点击重新识别；当前红点仍是上次结果。' : current?.roi ? '已选择识别范围；框外不参与自动计数。' : '识别整张照片；拍到桌面或衣服时，可先选择范围。';
  $('resetRange').disabled = !current?.roi || busy || loading;
  $('confirmButton').disabled = !loaded || busy || loading || Boolean(current?.rangeDirty);
  renderStatus();
  if (loaded) draw();
}

function updateFitScale() {
  const size = viewSize(current.width, current.height, current.rotation);
  fitScale = Math.max(.001, Math.min((viewport.clientWidth - 32) / size.width, (viewport.clientHeight - 32) / size.height));
}

function fit() {
  if (!current) return;
  updateFitScale();
  draw();
  viewport.scrollLeft = 0;
  viewport.scrollTop = 0;
}

function draw() {
  if (!current) return;
  const scale = fitScale * zoom;
  const size = viewSize(current.width, current.height, current.rotation);
  const visibleWidth = size.width * scale;
  const visibleHeight = size.height * scale;
  $('canvasSurface').style.width = `${visibleWidth}px`;
  $('canvasSurface').style.height = `${visibleHeight}px`;
  canvas.style.width = baseCanvas.style.width = `${visibleWidth}px`;
  canvas.style.height = baseCanvas.style.height = `${visibleHeight}px`;
  // Bound display backing store; full-resolution input remains available for
  // recognition/export, while displaying the page uses no model inference.
  const resolution = Math.min(window.devicePixelRatio || 1, 2, 2600 / Math.max(visibleWidth, visibleHeight));
  const width = Math.max(1, Math.round(visibleWidth * resolution));
  const height = Math.max(1, Math.round(visibleHeight * resolution));
  // Keep the photo in a separate cached layer: editing dots must not redraw
  // the source photo or reallocate its canvas backing store on every tap.
  if (baseDocument !== current || baseRotation !== current.rotation || baseCanvas.width !== width || baseCanvas.height !== height) {
    baseCanvas.width = width; baseCanvas.height = height;
    baseContext.setTransform(...imageTransform(current.width, current.height, current.rotation, width / size.width, height / size.height));
    baseContext.drawImage(current.image, 0, 0, current.width, current.height);
    baseDocument = current; baseRotation = current.rotation;
  }
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.clearRect(0, 0, width, height);
  context.setTransform(...imageTransform(current.width, current.height, current.rotation, width / size.width, height / size.height));
  if (current.roi) {
    const [left, top, right, bottom] = current.roi;
    const x = left * current.width, y = top * current.height;
    const w = (right - left) * current.width, h = (bottom - top) * current.height;
    context.save(); context.beginPath();
    context.rect(0, 0, current.width, current.height); context.rect(x, y, w, h);
    context.fillStyle = '#173f3226'; context.fill('evenodd');
    context.strokeStyle = '#168da0'; context.lineWidth = 1.5 / scale;
    context.setLineDash([5 / scale, 3 / scale]); context.strokeRect(x, y, w, h); context.restore();
  }
  if (rangeAnchor) {
    context.beginPath(); context.arc(rangeAnchor.x, rangeAnchor.y, 4 / scale, 0, Math.PI * 2);
    context.strokeStyle = '#168da0'; context.lineWidth = 1.5 / scale; context.stroke();
  }
  if ($('showDots').checked) drawPoints(context, current.points, Number($('dotSize').value) / scale, false);
  $('rotationLabel').textContent = `${(current.rotation || 0) * 90}°`;
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
$('rotateButton').addEventListener('click', () => {
  if (!current || busy || loading) return;
  current.rotation = ((current.rotation || 0) + 1) % 4;
  rangeAnchor = null; pointer = null; zoom = 1; fit();
  status('已向右旋转90°，红点与识别范围同步转动，数量保留。');
});
$('showDots').addEventListener('change', draw);
$('dotSize').addEventListener('change', draw);
new ResizeObserver(() => { if (current) { updateFitScale(); draw(); } }).observe(viewport);

document.querySelectorAll('[data-mode]').forEach(button => button.addEventListener('click', () => {
  mode = button.dataset.mode; rangeAnchor = null;
  draw();
  document.querySelectorAll('[data-mode]').forEach(item => { const active = item.dataset.mode === mode; item.classList.toggle('selected', active); item.setAttribute('aria-pressed', String(active)); });
  canvas.style.cursor = mode === 'pan' ? 'grab' : 'crosshair';
  canvas.style.touchAction = mode === 'pan' ? 'none' : 'pan-y pinch-zoom';
  $('editHint').textContent = hints[mode];
}));
canvas.addEventListener('pointerdown', event => {
  if (!current || busy || loading) return;
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
  if (!start || start.id !== event.pointerId || start.moved || !current || busy || loading) return;
  const rect = canvas.getBoundingClientRect();
  const size = viewSize(current.width, current.height, current.rotation);
  const {x, y} = viewToImage((event.clientX - rect.left) / rect.width * size.width,
    (event.clientY - rect.top) / rect.height * size.height, current.width, current.height, current.rotation);
  if (mode === 'roi') {
    if (!rangeAnchor) { rangeAnchor = {x, y}; status('已选第一个角，请点击另一个对角。'); draw(); return; }
    const left = Math.min(x, rangeAnchor.x), top = Math.min(y, rangeAnchor.y);
    const right = Math.max(x, rangeAnchor.x), bottom = Math.max(y, rangeAnchor.y);
    rangeAnchor = null;
    if (right - left < current.width * .02 || bottom - top < current.height * .02) { status('范围太小，请重新选两个对角。', true); draw(); return; }
    current.roi = [left / current.width, top / current.height, right / current.width, bottom / current.height];
    current.confirmed = false; current.rangeDirty = Boolean(current.result);
    status('范围已选。点击开始识别，范围内应包含全部待计数种子。'); render();
    document.querySelector('[data-mode=edit]').click(); return;
  }
  if (!$('showDots').checked) return status('请先打开“显示红点”，再修改标记。', true);
  const index = nearestPoint(current, x, y, (event.pointerType === 'touch' ? 10 : 7) / (fitScale * zoom));
  let changed = false;
  if ((mode === 'edit' || mode === 'erase') && index >= 0) changed = deletePoint(current, index);
  else if (mode !== 'erase') changed = addPoint(current, x, y);
  if (changed) { status('标记已更新，数量已同步。'); render(); }
});

$('resetRange').addEventListener('click', () => {
  if (!current || busy || loading) return;
  current.roi = null; rangeAnchor = null; current.confirmed = false; current.rangeDirty = Boolean(current.result);
  status('已恢复全图识别范围，请点击开始识别更新结果。'); render();
});

function undoEdit() { if (current && !busy && !loading && undo(current)) { status('已撤销上一步。'); render(); } }
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
  ++loadGeneration; loading = false; cancelRequest(false);
  documents.forEach(dispose); documents = []; current = null; rangeAnchor = null;
  canvas.width = 1; canvas.height = 1; baseCanvas.width = 1; baseCanvas.height = 1; baseDocument = null; baseRotation = null;
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
  if (!current || busy || loading) return;
  const doc = current;
  if (!await approveReplace() || doc !== current || busy || loading) return;
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
    applyDetection(doc, result); doc.rangeDirty = false;
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
  download(new Blob([JSON.stringify({...exportRecord(current, options()), view_rotation_degrees:(current.rotation || 0) * 90}, null, 2)], {type:'application/json'}), filename('.json'));
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
  const size = viewSize(doc.width, doc.height, doc.rotation);
  output.width = Math.round(size.width * scale); output.height = Math.round(size.height * scale) + footer;
  const ctx = output.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, output.width, output.height);
  ctx.save(); ctx.setTransform(...imageTransform(doc.width, doc.height, doc.rotation, scale)); ctx.drawImage(doc.image, 0, 0);
  drawPoints(ctx, doc.points, Math.max(2, Math.max(doc.width, doc.height) / 900) * Number($('dotSize').value) / 2, false); ctx.restore();
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
  camera.close();
  ++loadGeneration; loading = false; cancelRequest(false); documents.forEach(dispose); documents = []; current = null; rangeAnchor = null;
  $('accessToken').value = ''; $('fileInput').value = ''; $('cameraInput').value = ''; canvas.width = 1; canvas.height = 1; baseCanvas.width = 1; baseCanvas.height = 1; baseDocument = null; baseRotation = null;
  render(); // remove thumbnail DOM references even when the browser uses BFCache
});
window.addEventListener('pageshow', event => { if (event.persisted) { status('页面已恢复，请重新选择照片。'); render(); } });

fetch('/api/health', {cache:'no-store'}).then(response => response.json()).then(result => {
  requiresToken = result.requires_token;
  if (requiresToken) { document.querySelector('.advanced').open = true; if (!current) status('请选择照片，并输入服务器访问口令。'); }
}).catch(() => status('识别服务暂时无法连接。你仍可以选图手动标点。', true));
render();
