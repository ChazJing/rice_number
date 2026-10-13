import test from 'node:test';
import assert from 'node:assert/strict';
import {viewSize, imageToView, viewToImage, imageTransform} from '../frontend/view.mjs';

const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`);

test('clockwise rotation maps a known seed center and swaps the view dimensions', () => {
  assert.deepEqual(viewSize(800, 600, 1), {width:600, height:800});
  assert.deepEqual(imageToView(100, 200, 800, 600, 1), {x:400, y:100});
  assert.deepEqual(viewToImage(400, 100, 800, 600, 1), {x:100, y:200});
  assert.deepEqual(imageToView(100, 200, 800, 600, 2), {x:700, y:400});
  assert.deepEqual(imageToView(100, 200, 800, 600, 3), {x:200, y:700});
});

test('all rotations preserve source coordinates under scaled drawing and pointer mapping', () => {
  for (let turn = 0; turn < 4; turn++) {
    const size = viewSize(2304, 4096, turn);
    const [a,b,c,d,e,f] = imageTransform(2304, 4096, turn, .123, .125);
    for (const [x,y] of [[0,0], [2304,4096], [831.25,1920.6], [2303.9,.1]]) {
      const v = imageToView(x,y,2304,4096,turn);
      assert.ok(v.x >= 0 && v.x <= size.width && v.y >= 0 && v.y <= size.height);
      close(a*x+c*y+e, v.x*.123); close(b*x+d*y+f, v.y*.125);
      const source = viewToImage(v.x,v.y,2304,4096,turn);
      close(source.x,x); close(source.y,y);
    }
  }
});

test('four rotations return to the source and a square still rotates coordinates', () => {
  assert.deepEqual(imageToView(10,20,100,100,1), {x:80,y:10});
  assert.deepEqual(imageToView(10,20,100,100,4), {x:10,y:20});
  assert.deepEqual(viewSize(800,600,4), {width:800,height:600});
});
