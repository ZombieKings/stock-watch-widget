'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { indRange, indSegments, indTick, indHasData } = require('./indchart');

// —— indRange ——

test('indRange 覆盖所有点并留余量', () => {
  const r = indRange([10, 20, 30]);
  assert.ok(r.min < 10, '下界应低于最小值');
  assert.ok(r.max > 30, '上界应高于最大值');
  // 默认 8% 余量
  assert.ok(Math.abs(r.min - (10 - 20 * 0.08)) < 1e-9);
  assert.ok(Math.abs(r.max - (30 + 20 * 0.08)) < 1e-9);
});

test('indRange 忽略 null 与 NaN', () => {
  const r = indRange([null, 5, NaN, 15, undefined]);
  assert.ok(r.min < 5 && r.max > 15);
});

test('indRange 全 null 返回 null', () => {
  assert.equal(indRange([null, null]), null);
  assert.equal(indRange([]), null);
  assert.equal(indRange(undefined), null);
});

test('indRange includeZero 把零轴并进范围', () => {
  // MACD 全为正时，不含零轴的话柱子会从图底长出来，看不出正负
  const r = indRange([2, 5, 8], { includeZero: true });
  assert.ok(r.min <= 0, `下界应含 0，实得 ${r.min}`);

  const neg = indRange([-8, -5, -2], { includeZero: true });
  assert.ok(neg.max >= 0, `上界应含 0，实得 ${neg.max}`);
});

test('indRange 全平时撑开高度，避免除零', () => {
  const r = indRange([50, 50, 50]);
  assert.ok(r.max > r.min, '范围必须有正高度');

  // 单点也一样
  const one = indRange([7]);
  assert.ok(one.max > one.min);
});

test('indRange 全平且值接近 0 时也有非零高度', () => {
  const r = indRange([0, 0, 0]);
  assert.ok(r.max > r.min, `0 附近横盘也要撑开，实得 ${r.min}..${r.max}`);
});

test('indRange padPct 为 0 时不留余量', () => {
  const r = indRange([10, 30], { padPct: 0 });
  assert.equal(r.min, 10);
  assert.equal(r.max, 30);
});

// —— indSegments ——

test('indSegments 无 null 时返回单段', () => {
  const segs = indSegments([1, 2, 3]);
  assert.equal(segs.length, 1);
  assert.deepEqual(
    segs[0].map((p) => p.v),
    [1, 2, 3]
  );
});

test('indSegments 在 null 处断开，下标保持原位', () => {
  // 关键：断开后各段仍用原始下标定位，否则空洞右侧的线会整体左移
  const segs = indSegments([null, null, 5, 6, null, 8]);
  assert.equal(segs.length, 2);
  assert.deepEqual(segs[0], [{ i: 2, v: 5 }, { i: 3, v: 6 }]);
  assert.deepEqual(segs[1], [{ i: 5, v: 8 }]);
});

test('indSegments 前导 null 不产生空段', () => {
  const segs = indSegments([null, null, 1, 2]);
  assert.equal(segs.length, 1);
  assert.equal(segs[0][0].i, 2);
});

test('indSegments 尾部 null 不产生空段', () => {
  const segs = indSegments([1, 2, null, null]);
  assert.equal(segs.length, 1);
  assert.equal(segs[0].length, 2);
});

test('indSegments 全 null 返回空数组', () => {
  assert.deepEqual(indSegments([null, null]), []);
  assert.deepEqual(indSegments([]), []);
  assert.deepEqual(indSegments(undefined), []);
});

test('indSegments 把 0 当有效值而非缺数据', () => {
  // MACD 的 dif 在快慢线同种子时确实为 0，当成 null 会把线断开
  const segs = indSegments([0, 0, 1]);
  assert.equal(segs.length, 1, '0 不应断线');
  assert.equal(segs[0].length, 3);
});

test('indSegments 把 NaN/undefined 当缺数据', () => {
  const segs = indSegments([1, NaN, 3, undefined, 5]);
  assert.equal(segs.length, 3);
});

test('indSegments 交替 null 产生多个单点段', () => {
  const segs = indSegments([1, null, 2, null, 3]);
  assert.equal(segs.length, 3);
  assert.ok(segs.every((s) => s.length === 1));
});

// —— indTick ——

test('indTick 按量级调整小数位', () => {
  assert.equal(indTick(0.71), '0.71');
  assert.equal(indTick(12.34), '12.3');
  assert.equal(indTick(105.6), '106');
});

test('indTick 整数不带小数点', () => {
  // 参考线是 70/30/80/20，'70.0' 在 26px 刻度位里白占一格还更难认
  assert.equal(indTick(70), '70');
  assert.equal(indTick(30), '30');
  assert.equal(indTick(20), '20');
  assert.equal(indTick(1300), '1300');
  assert.equal(indTick(-20), '-20');
});

test('indTick 负数保留符号', () => {
  assert.equal(indTick(-0.79), '-0.79');
  assert.equal(indTick(-15.28), '-15.3');
});

test('indTick 非数字返回空串', () => {
  assert.equal(indTick(null), '');
  assert.equal(indTick(NaN), '');
  assert.equal(indTick(undefined), '');
});

test('indTick 零显示为 0', () => {
  assert.equal(indTick(0), '0');
});

// —— indHasData ——

test('indHasData 区分「长度非 0」与「有数据」', () => {
  // 预热期整段是 null：长度 60 但一个值都画不出来
  assert.equal(indHasData([null, null, null]), false);
  assert.equal(indHasData([null, 1]), true);
  assert.equal(indHasData([]), false);
  assert.equal(indHasData(undefined), false);
});

test('indHasData 把 0 当有数据', () => {
  assert.equal(indHasData([0, 0]), true);
});

test('indHasData 忽略 NaN', () => {
  assert.equal(indHasData([NaN, NaN]), false);
});
