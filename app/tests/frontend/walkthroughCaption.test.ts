import assert from 'node:assert/strict';
import test from 'node:test';
import { CAPTION_HEIGHT, placeCaption } from '../../src/components/walkthrough/placeCaption.ts';

const SIDEBAR = 210;

test('the roomy overview card stays out of the sidebar gutter', () => {
  const hole = { x: 224, y: 8, w: 1040, h: 740 };
  const box = placeCaption(hole, 1280, 800, false, true);
  assert.ok(box.width >= 320, `width ${box.width}`);
  assert.ok(box.left >= SIDEBAR, `left ${box.left} is in the sidebar gutter`);
  assert.ok(box.left + box.width <= 1280 - 12);
  assert.ok(box.top + CAPTION_HEIGHT <= 800);
});

test('a roomy caption docks beside the spotlight when 320px fits there', () => {
  const hole = { x: 240, y: 80, w: 480, h: 280 };
  const box = placeCaption(hole, 1280, 800, false, true);
  assert.ok(box.width >= 320, `width ${box.width}`);
  assert.ok(box.left >= hole.x + hole.w, `left ${box.left} overlaps the spotlight`);
});

test('a roomy caption docks below a short wide spotlight', () => {
  const hole = { x: 224, y: 40, w: 1040, h: 180 };
  const box = placeCaption(hole, 1280, 800, false, true);
  assert.ok(box.width >= 320, `width ${box.width}`);
  assert.ok(box.left >= SIDEBAR, `left ${box.left}`);
  assert.ok(box.top >= hole.y + hole.h, `top ${box.top} is not below the spotlight`);
});

test('a non-roomy caption still sits under a short target', () => {
  const hole = { x: 400, y: 40, w: 200, h: 120 };
  const box = placeCaption(hole, 1280, 800, false, false);
  assert.equal(box.width, 420);
  assert.equal(box.top, 800 - CAPTION_HEIGHT - 24);
});
