// The points array is the single source of truth for all displayed/exported counts.
export const MAX_POINTS = 5000;
const clone = points => points.map(point => ({...point}));

export function createDocument(file, image, url) {
  return {id: crypto.randomUUID(), file, image, url, width: image.naturalWidth,
    height: image.naturalHeight, points: [], history: [], autoCount: null,
    warnings: [], result: null, edited: false, confirmed: false};
}

export function checkpoint(doc) {
  doc.history.push({points: clone(doc.points), edited: doc.edited});
  if (doc.history.length > 40) doc.history.shift();
}

export function addPoint(doc, x, y) {
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x >= doc.width || y >= doc.height || doc.points.length >= MAX_POINTS) return false;
  checkpoint(doc);
  doc.points.push({id: crypto.randomUUID(), x: Math.round(x * 100) / 100,
    y: Math.round(y * 100) / 100, source: 'manual', review: false});
  doc.edited = true;
  doc.confirmed = false;
  return true;
}

export function deletePoint(doc, index) {
  if (!Number.isInteger(index) || index < 0 || index >= doc.points.length) return false;
  checkpoint(doc);
  doc.points.splice(index, 1);
  doc.edited = true;
  doc.confirmed = false;
  return true;
}

export function undo(doc) {
  const snapshot = doc.history.pop();
  if (!snapshot) return false;
  doc.points = snapshot.points;
  doc.edited = snapshot.edited;
  doc.confirmed = false;
  return true;
}

export function applyDetection(doc, result) {
  if (result.width !== doc.width || result.height !== doc.height || !Array.isArray(result.points) || result.points.length > MAX_POINTS) {
    throw new Error('照片方向或尺寸与识别结果不一致，请将照片另存为 JPG 后重试。');
  }
  if (result.points.some(point => !Number.isFinite(point.x) || !Number.isFinite(point.y) || point.x < 0 || point.y < 0 || point.x >= doc.width || point.y >= doc.height)) {
    throw new Error('服务器返回了无效坐标，请重试。');
  }
  doc.points = clone(result.points);
  doc.autoCount = result.points.length;
  doc.warnings = result.warnings || [];
  doc.result = result;
  doc.edited = false;
  doc.confirmed = false;
  doc.history = [];
}

export function nearestPoint(doc, x, y, radius) {
  let nearest = -1, distance = radius * radius;
  doc.points.forEach((point, index) => {
    const value = (point.x - x) ** 2 + (point.y - y) ** 2;
    if (value <= distance) { nearest = index; distance = value; }
  });
  return nearest;
}

export function metrics(doc) {
  return {count: doc.points.length, auto: doc.autoCount,
    adjustment: doc.points.length - (doc.autoCount ?? 0),
    review: doc.points.filter(point => point.review).length};
}

export function exportRecord(doc, options) {
  return {version: 1, filename: doc.file.name, exported_at: new Date().toISOString(),
    width: doc.width, height: doc.height, coordinate_system: 'EXIF-oriented original image pixels; origin top-left',
    count: doc.points.length, auto_count: doc.autoCount,
    manual_adjustment: doc.points.length - (doc.autoCount ?? 0),
    manually_confirmed: doc.confirmed,
    method: doc.result?.method ?? 'manual', options: doc.result?.options ?? options,
    warnings: [...doc.warnings],
    points: doc.points.map((point, index) => ({number: index + 1, ...point}))};
}

export function keepRecent(documents, incoming, dispose) {
  const retained = [...documents, incoming];
  while (retained.length > 2) dispose(retained.shift());
  return retained;
}
