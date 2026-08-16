'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  computeRange,
  computeGeometry,
  barIndexAtX,
  tickLabel,
  isHoverActive,
  plotWidth,
  dragBarShift,
  panWindow,
  rezoomWindow,
  LAYOUT,
} = require('./candle');

// —— computeRange ——

test('computeRange 覆盖所有高低点并留余量', () => {
  const bars = [
    { high: 12, low: 8 },
    { high: 15, low: 10 },
    { high: 11, low: 6 },
  ];
  const r = computeRange(bars);
  assert.ok(r.max > 15, '上界应高于最高点');
  assert.ok(r.min < 6, '下界应低于最低点');
  // 余量 6%，范围是 6~15 共 9
  assert.ok(Math.abs(r.max - (15 + 0.54)) < 1e-9);
  assert.ok(Math.abs(r.min - (6 - 0.54)) < 1e-9);
});

test('computeRange 把跑出高低点的均线并进范围', () => {
  // 均线在图形左端常高于所有 K 线高点：不并进来会画到框外
  const bars = [
    { high: 12, low: 8, ma20: 30 },
    { high: 13, low: 9, ma20: 28 },
  ];
  const r = computeRange(bars, ['ma20']);
  assert.ok(r.max > 30, `上界应容纳 ma20=30，实际 ${r.max}`);
});

test('computeRange 均线低于所有低点时也要并进来', () => {
  const bars = [
    { high: 12, low: 8, ma5: 2 },
    { high: 13, low: 9, ma5: 3 },
  ];
  const r = computeRange(bars, ['ma5']);
  assert.ok(r.min < 2, `下界应容纳 ma5=2，实际 ${r.min}`);
});

test('computeRange 忽略 null 均线值', () => {
  const bars = [
    { high: 12, low: 8, ma20: null },
    { high: 13, low: 9, ma20: undefined },
  ];
  const r = computeRange(bars, ['ma20']);
  assert.ok(Number.isFinite(r.min) && Number.isFinite(r.max), 'null 均线不应污染范围');
  assert.ok(r.max > 13 && r.min < 8);
});

test('computeRange 一字板（全段同价）给出非零高度，避免除零', () => {
  const bars = [
    { high: 10, low: 10 },
    { high: 10, low: 10 },
  ];
  const r = computeRange(bars);
  assert.ok(r.max - r.min > 0, '范围高度必须为正，否则 yOf 会除零得 NaN');
});

test('computeRange 空数据或全非法返回 null', () => {
  assert.equal(computeRange([]), null);
  assert.equal(computeRange(null), null);
  assert.equal(computeRange([{ high: NaN, low: NaN }]), null);
});

test('computeRange 单根也能给出有效范围', () => {
  const r = computeRange([{ high: 11, low: 9 }]);
  assert.ok(r.max > 11 && r.min < 9);
});

// —— computeGeometry ——

test('computeGeometry 槽宽随根数缩小，实体留出间隙', () => {
  const g = computeGeometry(300, 60);
  assert.equal(g.slot, 5);
  assert.equal(g.body, 4, '实体应比槽宽窄 1px');
});

test('computeGeometry 根数极多时实体宽兜到 1px 而非 0', () => {
  const g = computeGeometry(300, 600);
  assert.ok(g.body >= 1, `实体宽必须 >=1，否则整根不可见，实际 ${g.body}`);
});

test('computeGeometry 根数很少时实体宽有上限，不胖成方块', () => {
  const g = computeGeometry(300, 3);
  assert.ok(g.body <= 14, `实体宽应有上限，实际 ${g.body}`);
});

test('computeGeometry 根数为 0 或非法时不产生除零', () => {
  for (const n of [0, -5, NaN, undefined]) {
    const g = computeGeometry(300, n);
    assert.ok(Number.isFinite(g.slot) && g.slot > 0, `n=${n} 槽宽应有限且为正`);
    assert.ok(g.body >= 1);
  }
});

// —— barIndexAtX ——

test('barIndexAtX 把 x 映射到对应根', () => {
  // padL=2, plotW=300, 60 根 → 每根 5px
  assert.equal(barIndexAtX(2, 2, 300, 60), 0);
  assert.equal(barIndexAtX(9, 2, 300, 60), 1); // (9-2)/5 = 1.4 → 1
  assert.equal(barIndexAtX(301, 2, 300, 60), 59);
});

test('barIndexAtX 落在最右边界时不越界', () => {
  const idx = barIndexAtX(302, 2, 300, 60);
  assert.equal(idx, 59, '右边界应收敛到末根，不能返回 60');
});

test('barIndexAtX 超出绘图区返回 -1', () => {
  assert.equal(barIndexAtX(1, 2, 300, 60), -1);
  assert.equal(barIndexAtX(400, 2, 300, 60), -1);
  assert.equal(barIndexAtX(NaN, 2, 300, 60), -1);
});

// —— tickLabel ——
//
// 原 axisTicks 的测试已随该函数移除：刻度取值统一走 axis.js 的
// tickSlots + tickValue，覆盖在 axis.test.js。

test('tickLabel 日K 显示 MM-DD，周月K 显示 YY-MM', () => {
  assert.equal(tickLabel('2026-08-06', 'day'), '08-06');
  assert.equal(tickLabel('2026-08-06', 'week'), '26-08');
  assert.equal(tickLabel('2026-08-06', 'month'), '26-08');
});

test('tickLabel 异常日期原样返回，不抛错', () => {
  assert.equal(tickLabel('', 'day'), '');
  assert.equal(tickLabel(null, 'day'), '');
  assert.equal(tickLabel('abc', 'day'), 'abc');
});

test('tickLabel 60分K 显示「日 时刻」——跨日边界要看得出来', () => {
  // 只给 '10:30' 的话，连续几天的标签会重复，看不出哪里换了天
  assert.equal(tickLabel('2026-08-06 10:30', '60min'), '06 10:30');
  assert.equal(tickLabel('2026-08-07 15:00', '60min'), '07 15:00');
});

test('tickLabel 带时间的日期即使 period 没传对也按分钟级处理', () => {
  // 防御：period 与数据不一致时，按 date 自身的形状判断更可靠
  assert.equal(tickLabel('2026-08-06 10:30', 'day'), '06 10:30');
});

test('tickLabel 日K 不受 60min 分支影响（回归）', () => {
  assert.equal(tickLabel('2026-08-06', 'day'), '08-06');
  assert.equal(tickLabel('2026-08-06', 'week'), '26-08');
});

// —— isHoverActive ——

test('isHoverActive 未悬停时为假：null / undefined 不能当成第 0 根', () => {
  // 回归：曾经先 Number(hoverIndex) 再判断，Number(null) === 0 通过了整数检查，
  // 导致鼠标不在图上时第 0 根仍留着一条十字线
  assert.equal(isHoverActive(null, 100), false);
  assert.equal(isHoverActive(undefined, 100), false);
  assert.equal(isHoverActive('', 100), false);
  assert.equal(isHoverActive(NaN, 100), false);
});

test('isHoverActive 只接受可见区内的整数下标', () => {
  assert.equal(isHoverActive(0, 100), true);
  assert.equal(isHoverActive(99, 100), true);
  assert.equal(isHoverActive(100, 100), false, '越界');
  assert.equal(isHoverActive(-1, 100), false);
  assert.equal(isHoverActive(1.5, 100), false, '非整数');
  assert.equal(isHoverActive(0, 0), false, '无数据时任何下标都无效');
});

// —— plotWidth ——

test('plotWidth 扣掉左右内边距，与命中判定共用同一套常量', () => {
  assert.equal(plotWidth(300), 300 - LAYOUT.padL - LAYOUT.padR);
  assert.equal(plotWidth(0), 300 - LAYOUT.padL - LAYOUT.padR, '宽度缺失时回落到 300');
  assert.equal(plotWidth(undefined), 300 - LAYOUT.padL - LAYOUT.padR);
});

test('plotWidth 与 barIndexAtX 组合：首尾根都能命中', () => {
  const w = plotWidth(572);
  const n = 105;
  assert.equal(barIndexAtX(LAYOUT.padL + 1, LAYOUT.padL, w, n), 0);
  assert.equal(barIndexAtX(LAYOUT.padL + w - 1, LAYOUT.padL, w, n), n - 1);
});

// —— dragBarShift ——

test('dragBarShift 按槽宽换算根数，符号跟随位移方向', () => {
  // 500px / 50 根 = 10px 每根
  assert.equal(dragBarShift(100, 500, 50), 10);
  assert.equal(dragBarShift(-100, 500, 50), -10);
});

test('dragBarShift 不足一个槽宽时返回 0，避免抖动触发重画', () => {
  assert.equal(dragBarShift(9, 500, 50), 0);
  assert.equal(dragBarShift(-9, 500, 50), 0);
  assert.equal(dragBarShift(10, 500, 50), 1);
});

test('dragBarShift 向零取整，正负位移的手感对称', () => {
  // 25px / 10px 每根 = 2.5，两个方向都该只走 2 根
  assert.equal(dragBarShift(25, 500, 50), 2);
  assert.equal(dragBarShift(-25, 500, 50), -2);
});

test('dragBarShift 缩放后每根对应的像素数随之变化', () => {
  // 同样拖 100px：放大到 10 根时槽宽 50px 只走 2 根，缩小到 200 根时走 40 根
  assert.equal(dragBarShift(100, 500, 10), 2);
  assert.equal(dragBarShift(100, 500, 200), 40);
});

test('dragBarShift 非法输入返回 0，不产生 NaN 位移', () => {
  assert.equal(dragBarShift(NaN, 500, 50), 0);
  assert.equal(dragBarShift(100, 0, 50), 0);
  assert.equal(dragBarShift(100, -10, 50), 0);
  assert.equal(dragBarShift(100, 500, 0), 0);
  assert.equal(dragBarShift(100, 500, NaN), 0);
});

// —— panWindow ——

test('panWindow 向历史平移，可见根数不变', () => {
  const r = panWindow({ total: 100, from: 60, count: 40, shift: -20 });
  assert.equal(r.visibleFrom, 40);
  assert.equal(r.visibleCount, 40);
  assert.equal(r.atLeft, false);
  assert.equal(r.atRight, false);
});

test('panWindow 顶到左端时夹住并标记 atLeft', () => {
  const r = panWindow({ total: 100, from: 10, count: 40, shift: -50 });
  assert.equal(r.visibleFrom, 0, '不能越过数组头部');
  assert.equal(r.visibleCount, 40);
  assert.equal(r.atLeft, true);
});

test('panWindow 顶到右端时夹住并标记 atRight', () => {
  const r = panWindow({ total: 100, from: 40, count: 40, shift: 50 });
  assert.equal(r.visibleFrom, 60, '可见区右沿不能越过最新一根');
  assert.equal(r.atRight, true);
});

test('panWindow 可见根数超过总根数时收窄到总根数', () => {
  const r = panWindow({ total: 30, from: 0, count: 40, shift: -10 });
  assert.equal(r.visibleFrom, 0);
  assert.equal(r.visibleCount, 30);
  assert.equal(r.atLeft, true);
  assert.equal(r.atRight, true, '填满全部数据时两端同时为真');
});

test('panWindow minFrom 挡住均线预热段', () => {
  // 总 120 根含 20 根预热，可显示的只有下标 20 起
  const r = panWindow({ total: 120, from: 40, count: 40, shift: -50, minFrom: 20 });
  assert.equal(r.visibleFrom, 20, '不能拖进预热段');
  assert.equal(r.atLeft, true);
});

test('panWindow minFrom 大于 maxFrom 时以 maxFrom 为准，不越过末尾', () => {
  // 数据少到装不满一屏：maxFrom=5 < minFrom=20
  const r = panWindow({ total: 45, from: 5, count: 40, shift: -10, minFrom: 20 });
  assert.equal(r.visibleFrom, 5);
  assert.equal(r.visibleFrom + r.visibleCount <= 45, true, '可见区不能越过数组末尾');
});

test('panWindow 空数据不抛错', () => {
  const r = panWindow({ total: 0, from: 0, count: 40, shift: -10 });
  assert.equal(r.visibleFrom, 0);
  assert.equal(r.visibleCount, 0);
});

test('panWindow 非法 shift 视作不动', () => {
  const r = panWindow({ total: 100, from: 60, count: 40, shift: NaN });
  assert.equal(r.visibleFrom, 60);
});

test('panWindow 与 dragBarShift 组合：往右拖露出更早的数据', () => {
  const total = 200;
  const count = 50;
  const plotW = 500; // 槽宽 10px
  const from = 150; // 贴最右
  // 往右拖 100px = 10 根，起点应减 10
  const shift = dragBarShift(100, plotW, count);
  const r = panWindow({ total, from, count, shift: -shift });
  assert.equal(r.visibleFrom, 140);
});

// —— rezoomWindow ——
//
// 这组的核心是 anchorRatio 为 null / undefined 时必须锚定**右端**。
// 曾因 Number(null) === 0 被当成 ratio=0（锚定最左），导致一进日/周K
// 右端停在一屏之前的历史上，看不到当日/本周那根。

test('rezoomWindow anchorRatio=null 锚定右端，露出最新一根', () => {
  // 服务端给了 201 根、窗口 180 根（贴最右），收窄到 90 根
  const r = rezoomWindow({ total: 201, oldFrom: 21, oldCount: 180, newCount: 90, anchorRatio: null });
  assert.equal(r.visibleCount, 90);
  assert.equal(r.visibleFrom, 111);
  // 右端下标必须是最后一根
  assert.equal(r.visibleFrom + r.visibleCount - 1, 200);
});

test('rezoomWindow anchorRatio=undefined 同样锚定右端', () => {
  const r = rezoomWindow({ total: 201, oldFrom: 21, oldCount: 180, newCount: 90 });
  assert.equal(r.visibleFrom, 111);
  assert.equal(r.visibleFrom + r.visibleCount - 1, 200);
});

test('rezoomWindow 周K 默认跨度同样贴住本周那根', () => {
  // 周K：请求 52 根 + 20 根预热 → 72 根，收窄到默认 26 根
  const r = rezoomWindow({ total: 72, oldFrom: 20, oldCount: 52, newCount: 26, anchorRatio: null });
  assert.equal(r.visibleFrom, 46);
  assert.equal(r.visibleFrom + r.visibleCount - 1, 71);
});

test('rezoomWindow 非数字锚点一律视作锚定右端，不被隐式转换骗过', () => {
  // '0' / false / [] 经 Number() 都会变成 0（锚定最左），必须挡住
  for (const bad of [null, undefined, '0', '', false, [], {}, NaN]) {
    const r = rezoomWindow({ total: 100, oldFrom: 0, oldCount: 50, newCount: 20, anchorRatio: bad });
    assert.equal(r.visibleFrom, 80, `anchorRatio=${JSON.stringify(bad)} 应锚定右端`);
  }
});

test('rezoomWindow 有光标时锚定光标下那根，缩放前后停在原处', () => {
  // 光标在可见区正中：缩放前指向 50，缩放后仍应指向 50
  const r = rezoomWindow({ total: 200, oldFrom: 25, oldCount: 50, newCount: 20, anchorRatio: 0.5 });
  assert.equal(r.visibleCount, 20);
  assert.equal(r.visibleFrom + 0.5 * r.visibleCount, 50);
});

test('rezoomWindow anchorRatio=0 是真·锚定最左（与 null 语义不同）', () => {
  const r = rezoomWindow({ total: 200, oldFrom: 30, oldCount: 50, newCount: 20, anchorRatio: 0 });
  assert.equal(r.visibleFrom, 30);
});

test('rezoomWindow anchorRatio=1 锚定最右那根', () => {
  const r = rezoomWindow({ total: 200, oldFrom: 30, oldCount: 50, newCount: 20, anchorRatio: 1 });
  // 右端原为 80，缩放后仍应是 80
  assert.equal(r.visibleFrom + r.visibleCount, 80);
});

test('rezoomWindow 锚点比例越界时夹进 0..1', () => {
  const lo = rezoomWindow({ total: 200, oldFrom: 30, oldCount: 50, newCount: 20, anchorRatio: -3 });
  assert.equal(lo.visibleFrom, 30);
  const hi = rezoomWindow({ total: 200, oldFrom: 30, oldCount: 50, newCount: 20, anchorRatio: 9 });
  assert.equal(hi.visibleFrom + hi.visibleCount, 80);
});

test('rezoomWindow 可见根数不超过总根数', () => {
  const r = rezoomWindow({ total: 12, oldFrom: 0, oldCount: 12, newCount: 90, anchorRatio: null });
  assert.equal(r.visibleCount, 12);
  assert.equal(r.visibleFrom, 0);
});

test('rezoomWindow 空数据不抛错', () => {
  const r = rezoomWindow({ total: 0, oldFrom: 0, oldCount: 0, newCount: 90, anchorRatio: null });
  assert.deepEqual(r, { visibleFrom: 0, visibleCount: 0 });
});

test('rezoomWindow 起点始终夹在 [0, total-count]，可见区填满不越尾', () => {
  for (const ratio of [null, 0, 0.25, 0.5, 0.75, 1]) {
    for (const newCount of [10, 26, 90, 400]) {
      const r = rezoomWindow({ total: 201, oldFrom: 21, oldCount: 180, newCount, anchorRatio: ratio });
      assert.ok(r.visibleFrom >= 0, `from 不能为负 (ratio=${ratio}, count=${newCount})`);
      assert.ok(
        r.visibleFrom + r.visibleCount <= 201,
        `窗口不能越过末尾 (ratio=${ratio}, count=${newCount})`
      );
    }
  }
});
