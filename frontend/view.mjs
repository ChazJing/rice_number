// View rotation never mutates source pixels or the original point coordinates.
const quarter = turns => ((turns % 4) + 4) % 4;

export function viewSize(width, height, turns = 0) {
  return quarter(turns) % 2 ? {width:height, height:width} : {width, height};
}

export function imageToView(x, y, width, height, turns = 0) {
  switch (quarter(turns)) {
    case 1: return {x:height - y, y:x};
    case 2: return {x:width - x, y:height - y};
    case 3: return {x:y, y:width - x};
    default: return {x, y};
  }
}

export function viewToImage(x, y, width, height, turns = 0) {
  switch (quarter(turns)) {
    case 1: return {x:y, y:height - x};
    case 2: return {x:width - x, y:height - y};
    case 3: return {x:width - y, y:x};
    default: return {x, y};
  }
}

export function imageTransform(width, height, turns = 0, sx = 1, sy = sx) {
  switch (quarter(turns)) {
    case 1: return [0, sy, -sx, 0, height * sx, 0];
    case 2: return [-sx, 0, 0, -sy, width * sx, height * sy];
    case 3: return [0, -sy, sx, 0, 0, width * sy];
    default: return [sx, 0, 0, sy, 0, 0];
  }
}
