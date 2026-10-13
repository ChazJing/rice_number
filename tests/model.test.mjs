import test from 'node:test';
import assert from 'node:assert/strict';
import {addPoint, deletePoint, undo, nearestPoint, applyDetection, metrics, exportRecord, keepRecent} from '../frontend/model.mjs';

const doc = () => ({width:800,height:600,file:{name:'rice.jpg'},points:[],history:[],edited:false,confirmed:false,autoCount:null,warnings:[]});

test('add/delete/undo keep the red-dot count and exports consistent', () => {
  const d = doc();
  applyDetection(d, {width:800,height:600,points:[{id:'auto-1',x:100,y:200,source:'auto',review:true}],warnings:[]});
  addPoint(d, 200, 300); deletePoint(d, 0);
  assert.deepEqual(metrics(d), {count:1,auto:1,adjustment:0,review:0});
  const record = exportRecord(d, {});
  assert.equal(record.count, record.points.length);
  assert.equal(record.points[0].source, 'manual');
  assert.equal(record.points[0].number, 1);
  undo(d); assert.equal(d.points.length, 2);
  undo(d); assert.equal(d.points.length, 1); assert.equal(d.edited, false);
});

test('invalid coordinates and indexes cannot change count', () => {
  const d = doc();
  for (const [x,y] of [[-1,0],[800,0],[0,600],[NaN,1],[0,Infinity]]) assert.equal(addPoint(d,x,y), false);
  assert.equal(deletePoint(d,-1), false); assert.equal(deletePoint(d,.5), false);
  assert.equal(d.points.length, 0); assert.equal(d.history.length, 0);
});

test('closest-point deletion uses image coordinates after zoom', () => {
  const d = doc(); addPoint(d,100,100); addPoint(d,115,100);
  assert.equal(nearestPoint(d,113,100,5),1);
  assert.equal(nearestPoint(d,130,100,5),-1);
});

test('re-recognition resets corrections and rejects orientation mismatch', () => {
  const d = doc(); addPoint(d,10,20);
  assert.throws(() => applyDetection(d,{width:600,height:800,points:[]}));
  applyDetection(d,{width:800,height:600,points:[],warnings:[]});
  assert.equal(d.points.length,0); assert.equal(d.history.length,0); assert.equal(d.edited,false);
});

test('only the last two photos are retained and eviction disposes the oldest', () => {
  const first=doc(),second=doc(),third=doc(); const released=[];
  const retained=keepRecent([first,second],third,d => released.push(d));
  assert.deepEqual(retained,[second,third]); assert.deepEqual(released,[first]);
});

test('manual edits invalidate confirmation and history is bounded', () => {
  const d=doc(); d.confirmed=true;
  for(let i=0;i<45;i++) addPoint(d,i+1,20);
  assert.equal(d.confirmed,false); assert.equal(d.history.length,40);
});
