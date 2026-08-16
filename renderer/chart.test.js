'use strict';

/**
 * chart.js 的纯函数单测。
 *
 * 绘制函数依赖 Canvas，Node 里跑不了；这里只测能抽出来的几何与标尺逻辑——
 * 坐标算错是分时图里最容易埋进去又最难肉眼发现的 bug。
 */

const { test } = require('node:test');
const assert = require('node:assert');

const {
  minuteIndex,
  computeScale,
  slotIndex,
  computeMultiDayScale,
  hitTestMinute5d,
  minute5dPlotWidth,
  sparklineScale,
  sparklinePoints,
  sparklineSpan,
  SPARK_MIN_SPAN,
  TOTAL_MINUTES,
  MINUTE5D_LAYOUT,
} = require('./chart');

// —— minuteIndex：午休折叠 ——

test('minuteIndex 把午休折叠掉，下午接着上午数', () => {
  assert.equal(minuteIndex('09:30'), 0);
  assert.equal(minuteIndex('10:30'), 60);
  assert.equal(minuteIndex('11:30'), 120);
  assert.equal(minuteIndex('13:00'), 120); // 与 11:30 同槽，画在同一 x 上
  assert.equal(minuteIndex('14:00'), 180);
  assert.equal(minuteIndex('15:00'), 240);
});

test('minuteIndex 越界与畸形输入不返回 NaN', () => {
  assert.equal(minuteIndex('09:00'), 0); // 开盘前贴到 0
  assert.equal(minuteIndex('12:00'), 120); // 午休贴到中点
  assert.equal(minuteIndex('16:00'), TOTAL_MINUTES); // 收盘后截到末槽
  assert.equal(minuteIndex('abc'), -1);
  assert.equal(minuteIndex(''), -1);
  assert.equal(minuteIndex(null), -1);
});

// —— 单日分时标尺：昨收对称 ——

test('computeScale 以昨收为中心对称，零轴恒在正中', () => {
  const s = computeScale([{ price: 11 }, { price: 9.5 }], 10);
  assert.equal(s.base, 10);
  // 最大偏离是 1（11-10），加 8% 余量
  assert.ok(Math.abs(s.dev - 1.08) < 1e-9);
});

test('computeScale 全程平盘时不除零', () => {
  const s = computeScale([{ price: 10 }, { price: 10 }], 10);
  assert.ok(s.dev > 0, '平盘也要有正的幅度，否则线会被画到中轴外');
});

test('computeScale 昨收缺失或非正时返回 null', () => {
  assert.equal(computeScale([{ price: 10 }], null), null);
  assert.equal(computeScale([{ price: 10 }], 0), null);
  assert.equal(computeScale([{ price: 10 }], -1), null);
});

// —— 5 日分时：全局槽位 ——

test('slotIndex 单调递增，跨日不重叠', () => {
  assert.equal(slotIndex(0, 0), 0);
  assert.equal(slotIndex(0, 240), 240);
  assert.equal(slotIndex(1, 0), 240); // 第 1 天末槽与第 2 天首槽相接
  assert.equal(slotIndex(2, 120), 600);
  assert.equal(slotIndex(4, 240), 1200); // 5 天共 1200 槽

  // 严格单调：任意相邻两天的槽区间不交叠
  for (let d = 0; d < 4; d += 1) {
    assert.ok(slotIndex(d, 239) < slotIndex(d + 1, 0) + TOTAL_MINUTES);
    assert.ok(slotIndex(d, 0) < slotIndex(d + 1, 0));
  }
});

// —— 5 日分时标尺：实际高低点 ——

/** 两天的最小夹具：价格 9-12，均价在其内 */
const DAYS = [
  {
    date: '2026-08-05',
    prevClose: 10,
    points: [
      { time: '09:30', price: 10.5, avgPrice: 10.4 },
      { time: '15:00', price: 12, avgPrice: 11 },
    ],
  },
  {
    date: '2026-08-06',
    prevClose: 12,
    points: [
      { time: '09:30', price: 11, avgPrice: 11 },
      { time: '14:03', price: 9, avgPrice: 10 },
    ],
  },
];

test('computeMultiDayScale 取全部价格与均价的高低点，留 6% 余量', () => {
  const s = computeMultiDayScale(DAYS, 10);
  const span = 12 - 9; // 实际高低点
  const pad = span * 0.06;
  assert.ok(Math.abs(s.min - (9 - pad)) < 1e-9);
  assert.ok(Math.abs(s.max - (12 + pad)) < 1e-9);
});

test('computeMultiDayScale 把首日昨收并进范围，参照虚线不会跑到框外', () => {
  // 昨收 20 高于所有价格，不并进来的话虚线会画在图外
  const s = computeMultiDayScale(DAYS, 20);
  assert.ok(s.max >= 20, '昨收高于全部价格时应撑开上界');

  const s2 = computeMultiDayScale(DAYS, 5);
  assert.ok(s2.min <= 5, '昨收低于全部价格时应撑开下界');
});

test('computeMultiDayScale 把均线跑出价格区的情况也纳入', () => {
  const days = [
    { date: '2026-08-05', prevClose: 10, points: [{ time: '09:30', price: 10, avgPrice: 15 }] },
  ];
  const s = computeMultiDayScale(days, 10);
  assert.ok(s.max >= 15, '均价高于价格时应撑开上界');
});

test('computeMultiDayScale 停牌（全程一个价）不除零', () => {
  const s = computeMultiDayScale(
    [{ date: '2026-08-05', prevClose: 10, points: [{ time: '09:30', price: 10, avgPrice: 10 }] }],
    10
  );
  assert.ok(s.max > s.min, '零跨度必须撑开，否则 yOf 会除零');
});

test('computeMultiDayScale 无有效数据时返回 null', () => {
  assert.equal(computeMultiDayScale([], null), null);
  assert.equal(computeMultiDayScale(null, null), null);
  assert.equal(
    computeMultiDayScale([{ points: [{ time: '09:30', price: NaN }] }], null),
    null
  );
});

// —— 5 日分时命中判定 ——

test('hitTestMinute5d 首日首点与末日末点都能命中', () => {
  const padL = MINUTE5D_LAYOUT.padL;
  const plotW = minute5dPlotWidth(572);

  const left = hitTestMinute5d(padL + 1, padL, plotW, DAYS);
  assert.deepEqual(left, { dayIdx: 0, pointIdx: 0 });

  const right = hitTestMinute5d(padL + plotW - 1, padL, plotW, DAYS);
  assert.deepEqual(right, { dayIdx: 1, pointIdx: 1 });
});

test('hitTestMinute5d 日界两侧分属不同天', () => {
  const padL = MINUTE5D_LAYOUT.padL;
  const plotW = minute5dPlotWidth(572);
  const boundary = padL + plotW / 2; // 两天各占一半

  const before = hitTestMinute5d(boundary - 3, padL, plotW, DAYS);
  const after = hitTestMinute5d(boundary + 3, padL, plotW, DAYS);
  assert.equal(before.dayIdx, 0);
  assert.equal(after.dayIdx, 1);
});

test('hitTestMinute5d 框外返回 null', () => {
  const padL = MINUTE5D_LAYOUT.padL;
  const plotW = minute5dPlotWidth(572);
  assert.equal(hitTestMinute5d(padL - 10, padL, plotW, DAYS), null);
  assert.equal(hitTestMinute5d(padL + plotW + 10, padL, plotW, DAYS), null);
});

test('hitTestMinute5d 空数据或零宽度不抛错', () => {
  assert.equal(hitTestMinute5d(10, 2, 500, []), null);
  assert.equal(hitTestMinute5d(10, 2, 500, null), null);
  assert.equal(hitTestMinute5d(10, 2, 0, DAYS), null);
});

test('hitTestMinute5d 当天未走完时，右侧留白贴到最后一个点', () => {
  // 只到 10:00 的一天，占满 240 槽，右侧 3/4 是留白
  const partial = [
    {
      date: '2026-08-06',
      prevClose: 10,
      points: [
        { time: '09:30', price: 10 },
        { time: '10:00', price: 10.2 },
      ],
    },
  ];
  const padL = MINUTE5D_LAYOUT.padL;
  const plotW = minute5dPlotWidth(572);
  const hit = hitTestMinute5d(padL + plotW - 2, padL, plotW, partial);
  assert.deepEqual(hit, { dayIdx: 0, pointIdx: 1 }, '留白处应贴到最后一个有数据的点');
});

test('minute5dPlotWidth 扣掉左右内边距', () => {
  assert.equal(minute5dPlotWidth(572), 572 - MINUTE5D_LAYOUT.padL - MINUTE5D_LAYOUT.padR);
  assert.ok(minute5dPlotWidth(undefined) > 0, '宽度缺失时应有兜底值');
});

// —— 折叠态缩略图标尺 ——

test('sparklineScale 贴合当日高低点，而非以昨收对称展开', () => {
  // 昨收 10，全天在 10.5~10.6 之间窄幅震荡（涨约 5%）
  const pts = [
    { time: '09:30', price: 10.5 },
    { time: '10:00', price: 10.6 },
  ];
  const s = sparklineScale(pts, 10);
  // 对称展开会给出 ±0.6 即 9.4~10.6；贴合高低点后范围应远窄于此，
  // 否则那条线在 24px 高的画布里会糊成一横道
  assert.ok(s.max - s.min < 0.3, `范围应贴合高低点，实际 ${s.max - s.min}`);
  assert.ok(s.min < 10.5 && s.max > 10.6, '高低点应落在范围内且不贴边');
});

test('sparklineScale 昨收在可见范围外时不返回基准线', () => {
  // 跳空高开后全天没回到昨收：基准线画出来只会贴在下边框上
  const gapUp = sparklineScale(
    [
      { time: '09:30', price: 11 },
      { time: '10:00', price: 11.2 },
    ],
    10
  );
  assert.equal(gapUp.base, null, '昨收远低于当日最低价时应不画基准线');

  // 昨收落在当日区间内：应保留
  const inRange = sparklineScale(
    [
      { time: '09:30', price: 9.8 },
      { time: '10:00', price: 10.3 },
    ],
    10
  );
  assert.equal(inRange.base, 10);
});

test('sparklineScale 全天一个价时撑开窄带，不出现零区间', () => {
  const s = sparklineScale([{ time: '09:30', price: 10 }], 10);
  assert.ok(s.max > s.min, '区间必须非零，否则归一化会除零');
  assert.ok(s.min < 10 && s.max > 10, '唯一价格应落在区间正中附近');
});

test('sparklineScale 无有效价格时返回 null', () => {
  assert.equal(sparklineScale([], 10), null);
  assert.equal(sparklineScale([{ time: '09:30', price: null }], 10), null);
  assert.equal(sparklineScale(null, 10), null);
});

test('sparklineScale 昨收缺失或非法时仍能出范围', () => {
  const pts = [
    { time: '09:30', price: 10 },
    { time: '10:00', price: 10.5 },
  ];
  for (const bad of [null, undefined, 0, -1, NaN, 'abc']) {
    const s = sparklineScale(pts, bad);
    assert.ok(s && s.max > s.min, `昨收为 ${bad} 时仍应给出可用范围`);
    assert.equal(s.base, null, `昨收为 ${bad} 时不应画基准线`);
  }
});

// —— 折叠态缩略图坐标 ——

test('sparklinePoints 横轴铺满已走过的时段，而不是留 240 分钟的白', () => {
  // 只走到 11:30（半天）。大图会把它画在左半边，缩略图要铺满——
  // 62px 里留一半白，走势就只剩 31px，看不出形状
  const pts = sparklinePoints(
    [
      { time: '09:30', price: 10 },
      { time: '10:30', price: 10.5 },
      { time: '11:30', price: 10 },
    ],
    { min: 9, max: 11, base: 10 },
    62,
    24
  );
  assert.equal(pts.length, 3);
  assert.equal(pts[0].x, 0, '开盘点贴左沿');
  assert.ok(Math.abs(pts[1].x - 31) < 0.01, '10:30 是已走时段的中点');
  assert.equal(pts[2].x, 62, '最后一点贴右沿');
});

test('sparklineSpan 开盘头几分钟有下限，两三个点不拉满全宽', () => {
  const few = [
    { time: '09:30', price: 10 },
    { time: '09:32', price: 10.1 },
  ];
  assert.equal(sparklineSpan(few), SPARK_MIN_SPAN, '不足下限时按下限算');

  const pts = sparklinePoints(few, { min: 9, max: 11, base: 10 }, 62, 24);
  assert.ok(pts[1].x < 62 / 5, `头两分钟应只占左侧一小段，实际 x=${pts[1].x}`);

  // 超过下限后按实际跨度走
  assert.equal(
    sparklineSpan([
      { time: '09:30', price: 10 },
      { time: '11:00', price: 10 },
    ]),
    90
  );
});

test('sparklineSpan 忽略无效点，不被畸形时间撑大跨度', () => {
  const span = sparklineSpan([
    { time: '09:30', price: 10 },
    { time: '10:00', price: 10 },
    { time: '16:00', price: null }, // 价格无效，不该把跨度顶到收盘
    { time: 'abc', price: 10 },
  ]);
  assert.equal(span, 30);
});

test('sparklinePoints 纵轴翻转：高价对应小 y', () => {
  const pts = sparklinePoints(
    [
      { time: '09:30', price: 9 },
      { time: '10:00', price: 11 },
    ],
    { min: 9, max: 11, base: 10 },
    62,
    24
  );
  assert.equal(pts[0].y, 24, '最低价落在画布底部');
  assert.equal(pts[1].y, 0, '最高价落在画布顶部');
});

test('sparklinePoints 跳过畸形点，不产出 NaN 坐标', () => {
  const pts = sparklinePoints(
    [
      { time: '09:30', price: 10 },
      { time: 'abc', price: 10.5 }, // 时间畸形，minuteIndex 返回 -1
      { time: '10:00', price: null }, // 价格缺失
      { time: '10:30', price: 10.2 },
    ],
    { min: 9, max: 11, base: 10 },
    62,
    24
  );
  assert.equal(pts.length, 2, '两个畸形点应被跳过');
  for (const p of pts) {
    assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y), `坐标不应为 NaN：${JSON.stringify(p)}`);
  }
});

test('sparklinePoints 标尺非法时返回空数组而非抛错', () => {
  const pts = [{ time: '09:30', price: 10 }];
  assert.deepEqual(sparklinePoints(pts, null, 62, 24), []);
  assert.deepEqual(sparklinePoints(pts, { min: 10, max: 10 }, 62, 24), [], '零区间应挡在除零前');
});
