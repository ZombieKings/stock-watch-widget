'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { ema, macd, rsi, kdj, boll, computeAll, MACD_WARMUP } = require('./indicators');

/** 由 close 数组造 bars；high/low 用 close 上下浮动，便于测 KDJ */
function barsOf(closeList, highs, lows) {
  return closeList.map((c, i) => ({
    close: c,
    high: highs ? highs[i] : c,
    low: lows ? lows[i] : c,
  }));
}

const near = (a, b, tol = 1e-6) => Math.abs(a - b) < tol;

// —— EMA ——

test('EMA 首值等于首个收盘价，之后按 α 递推', () => {
  const out = ema([10, 12, 14], 3);
  // α = 2/(3+1) = 0.5
  assert.equal(out[0], 10);
  assert.ok(near(out[1], 11)); // 10 + 0.5*(12-10)
  assert.ok(near(out[2], 12.5)); // 11 + 0.5*(14-11)
});

test('EMA 对常量序列恒等于该常量', () => {
  const out = ema([7, 7, 7, 7, 7], 12);
  for (const v of out) assert.ok(near(v, 7));
});

test('EMA 遇非数字：坏点及其后为 null，前段保留且无 NaN', () => {
  const out = ema([10, 11, NaN, 13], 3);
  assert.equal(out[0], 10);
  assert.ok(near(out[1], 10.5)); // 10 + 0.5*(11-10)
  assert.equal(out[2], null, '坏点应为 null');
  assert.equal(out[3], null, '坏点之后无法续推，应为 null');
  assert.ok(out.every((v) => v === null || Number.isFinite(v)), '不得出现 NaN');
});

test('EMA period 非法时返回全 null', () => {
  assert.ok(ema([1, 2, 3], 0).every((v) => v === null));
  assert.ok(ema([1, 2, 3], -5).every((v) => v === null));
});

// —— MACD ——

test('MACD 三条线等长且与 bars 等长', () => {
  const bars = barsOf(Array.from({ length: 80 }, (_, i) => 100 + i));
  const r = macd(bars);
  assert.equal(r.dif.length, 80);
  assert.equal(r.dea.length, 80);
  assert.equal(r.macd.length, 80);
});

test('MACD 柱 = 2×(dif - dea)', () => {
  const bars = barsOf(Array.from({ length: 80 }, (_, i) => 100 + Math.sin(i / 5) * 10));
  const r = macd(bars);
  for (let i = 0; i < bars.length; i += 1) {
    if (r.dif[i] == null || r.dea[i] == null) continue;
    assert.ok(near(r.macd[i], 2 * (r.dif[i] - r.dea[i])), `第 ${i} 根柱子不符`);
  }
});

test('MACD 对常量序列：dif 与柱都收敛到 0', () => {
  const bars = barsOf(new Array(80).fill(50));
  const r = macd(bars);
  const last = bars.length - 1;
  assert.ok(near(r.dif[last], 0, 1e-9));
  assert.ok(near(r.macd[last], 0, 1e-9));
});

test('MACD 单调上涨时 dif 为正（快线在慢线上方）', () => {
  const bars = barsOf(Array.from({ length: 80 }, (_, i) => 100 + i * 2));
  const r = macd(bars);
  assert.ok(r.dif[79] > 0, `dif 应为正，实得 ${r.dif[79]}`);
});

test('MACD 单调下跌时 dif 为负', () => {
  const bars = barsOf(Array.from({ length: 80 }, (_, i) => 300 - i * 2));
  const r = macd(bars);
  assert.ok(r.dif[79] < 0, `dif 应为负，实得 ${r.dif[79]}`);
});

test('MACD 预热常量足够覆盖慢线与信号线', () => {
  // 26 + 9 = 35 是理论下限，留余量让 EMA 收敛
  assert.ok(MACD_WARMUP >= 35);
});

test('dea 从 dif 第一个有值处开始平滑，不被前置 null 拽向 0', () => {
  const bars = barsOf(Array.from({ length: 60 }, () => 100));
  const r = macd(bars);
  // 常量序列下 dif 恒为 0，dea 也应为 0 而非别的数
  const i = r.dea.findIndex((v) => v != null);
  assert.ok(i >= 0);
  assert.ok(near(r.dea[i], 0, 1e-9));
});

// —— RSI ——

test('RSI 单调上涨为 100', () => {
  const bars = barsOf(Array.from({ length: 30 }, (_, i) => 10 + i));
  const out = rsi(bars, 6);
  assert.equal(out[29], 100);
});

test('RSI 单调下跌为 0', () => {
  const bars = barsOf(Array.from({ length: 30 }, (_, i) => 100 - i));
  const out = rsi(bars, 6);
  assert.ok(near(out[29], 0, 1e-9), `实得 ${out[29]}`);
});

test('RSI 全程恒定：无涨无跌时按无跌幅处理为 100', () => {
  const bars = barsOf(new Array(30).fill(20));
  const out = rsi(bars, 6);
  // avgGain 与 avgLoss 都为 0 → 走 avgLoss===0 分支返回 100，而不是 NaN
  assert.equal(out[29], 100);
});

test('RSI 始终落在 0~100', () => {
  const closeList = Array.from({ length: 200 }, (_, i) => 100 + Math.sin(i / 3) * 15 + (i % 7));
  const out = rsi(barsOf(closeList), 12);
  for (const v of out) {
    if (v == null) continue;
    assert.ok(v >= 0 && v <= 100, `越界: ${v}`);
  }
});

test('RSI 数据不足 period+1 根时全 null', () => {
  const out = rsi(barsOf([1, 2, 3]), 6);
  assert.ok(out.every((v) => v === null));
});

test('RSI 第一个有值的下标恰为 period', () => {
  const bars = barsOf(Array.from({ length: 30 }, (_, i) => 10 + (i % 3)));
  const out = rsi(bars, 6);
  assert.equal(out.findIndex((v) => v != null), 6);
});

// —— KDJ ——

test('KDJ 满足 J = 3K - 2D', () => {
  const n = 40;
  const closeList = Array.from({ length: n }, (_, i) => 50 + Math.sin(i / 4) * 8);
  const highs = closeList.map((c) => c + 1.5);
  const lows = closeList.map((c) => c - 1.5);
  const r = kdj(barsOf(closeList, highs, lows));
  for (let i = 0; i < n; i += 1) {
    if (r.k[i] == null) continue;
    assert.ok(near(r.j[i], 3 * r.k[i] - 2 * r.d[i]), `第 ${i} 根 J 不符`);
  }
});

test('KDJ 收盘持续在区间顶部时 K 趋近 100', () => {
  const n = 60;
  const closeList = new Array(n).fill(0).map((_, i) => 10 + i);
  const highs = closeList.map((c) => c); // 收盘即最高
  const lows = closeList.map((c) => c - 5);
  const r = kdj(barsOf(closeList, highs, lows));
  assert.ok(r.k[n - 1] > 90, `K 应接近 100，实得 ${r.k[n - 1]}`);
});

test('KDJ 高低相等时 RSV 记 50，不除零', () => {
  const bars = barsOf(new Array(30).fill(20), new Array(30).fill(20), new Array(30).fill(20));
  const r = kdj(bars);
  const last = 29;
  assert.ok(Number.isFinite(r.k[last]));
  assert.ok(near(r.k[last], 50, 1e-6), `K 应为 50，实得 ${r.k[last]}`);
  assert.ok(near(r.d[last], 50, 1e-6));
});

test('KDJ 前 n-1 根为 null', () => {
  const closeList = Array.from({ length: 20 }, (_, i) => 10 + i);
  const r = kdj(barsOf(closeList, closeList, closeList), { n: 9 });
  for (let i = 0; i < 8; i += 1) assert.equal(r.k[i], null);
  assert.ok(r.k[8] != null);
});

test('KDJ 的 K 与 D 落在 0~100', () => {
  const n = 150;
  const closeList = Array.from({ length: n }, (_, i) => 30 + Math.cos(i / 5) * 12);
  const highs = closeList.map((c) => c + 2);
  const lows = closeList.map((c) => c - 2);
  const r = kdj(barsOf(closeList, highs, lows));
  for (let i = 0; i < n; i += 1) {
    if (r.k[i] == null) continue;
    assert.ok(r.k[i] >= 0 && r.k[i] <= 100, `K 越界 ${r.k[i]}`);
    assert.ok(r.d[i] >= 0 && r.d[i] <= 100, `D 越界 ${r.d[i]}`);
  }
});

// —— BOLL ——

test('BOLL 常量序列：三轨重合（标准差为 0）', () => {
  const bars = barsOf(new Array(30).fill(15));
  const r = boll(bars);
  const last = 29;
  assert.ok(near(r.mid[last], 15));
  assert.ok(near(r.up[last], 15));
  assert.ok(near(r.low[last], 15));
});

test('BOLL 中轨等于 MA(n)，用手算值核对', () => {
  // 20 根 1..20，均值 = (1+20)/2 = 10.5
  const bars = barsOf(Array.from({ length: 20 }, (_, i) => i + 1));
  const r = boll(bars, { n: 20, k: 2 });
  assert.ok(near(r.mid[19], 10.5));
});

test('BOLL 用总体标准差（除以 n），不是样本标准差', () => {
  const bars = barsOf(Array.from({ length: 20 }, (_, i) => i + 1));
  const r = boll(bars, { n: 20, k: 1 });
  // 1..20 的总体标准差 = sqrt((20²-1)/12) = sqrt(33.25) ≈ 5.7663
  const popSd = Math.sqrt((20 * 20 - 1) / 12);
  assert.ok(near(r.up[19] - r.mid[19], popSd, 1e-6), `实得 ${r.up[19] - r.mid[19]}`);
  // 样本标准差会是 sqrt(35) ≈ 5.9161，明显不同，确保没写成 n-1
  assert.ok(!near(r.up[19] - r.mid[19], Math.sqrt(35), 1e-3));
});

test('BOLL 上轨恒不低于中轨，中轨恒不低于下轨', () => {
  const closeList = Array.from({ length: 100 }, (_, i) => 40 + Math.sin(i / 6) * 10);
  const r = boll(barsOf(closeList));
  for (let i = 0; i < 100; i += 1) {
    if (r.mid[i] == null) continue;
    assert.ok(r.up[i] >= r.mid[i]);
    assert.ok(r.mid[i] >= r.low[i]);
  }
});

test('BOLL 前 n-1 根为 null', () => {
  const r = boll(barsOf(Array.from({ length: 25 }, (_, i) => i)), { n: 20 });
  for (let i = 0; i < 19; i += 1) assert.equal(r.mid[i], null);
  assert.ok(r.mid[19] != null);
});

// —— computeAll 与边界 ——

test('computeAll 返回四组指标与实际用到的参数', () => {
  const closeList = Array.from({ length: 100 }, (_, i) => 100 + i * 0.5);
  const r = computeAll(barsOf(closeList, closeList.map((c) => c + 1), closeList.map((c) => c - 1)));
  assert.ok(r.macd && r.macd.dif && r.macd.dea);
  assert.ok(r.rsi.rsi6 && r.rsi.rsi12 && r.rsi.rsi24);
  assert.ok(r.kdj.k && r.kdj.d && r.kdj.j);
  assert.ok(r.boll.mid && r.boll.up && r.boll.low);
  assert.deepEqual(r.periods.rsi, [6, 12, 24]);
  assert.equal(r.periods.macd.slow, 26);
});

test('computeAll 支持自定义 RSI 周期', () => {
  const bars = barsOf(Array.from({ length: 60 }, (_, i) => 10 + i));
  const r = computeAll(bars, { rsiPeriods: [7, 14] });
  assert.ok(r.rsi.rsi7 && r.rsi.rsi14);
  assert.equal(r.rsi.rsi6, undefined);
});

test('空数组与非数组入参不抛异常', () => {
  for (const input of [[], null, undefined, 'nope', 42]) {
    assert.doesNotThrow(() => computeAll(input));
    const r = computeAll(input);
    assert.equal(r.macd.dif.length, 0);
    assert.equal(r.kdj.k.length, 0);
    assert.equal(r.boll.mid.length, 0);
  }
});

test('bars 缺 high/low 时 KDJ 不抛异常', () => {
  // 只有 close 的 bars（比如某些接口回落数据）
  const bars = [{ close: 10 }, { close: 11 }, { close: 12 }];
  assert.doesNotThrow(() => kdj(bars, { n: 2 }));
});

test('所有指标输出长度恒等于 bars 长度', () => {
  for (const len of [0, 1, 5, 19, 20, 21, 100]) {
    const closeList = Array.from({ length: len }, (_, i) => 10 + i);
    const bars = barsOf(closeList, closeList, closeList);
    const r = computeAll(bars);
    assert.equal(r.macd.dif.length, len, `MACD 长度不符 (len=${len})`);
    assert.equal(r.rsi.rsi6.length, len, `RSI 长度不符 (len=${len})`);
    assert.equal(r.kdj.k.length, len, `KDJ 长度不符 (len=${len})`);
    assert.equal(r.boll.mid.length, len, `BOLL 长度不符 (len=${len})`);
  }
});
