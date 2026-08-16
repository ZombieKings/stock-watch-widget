'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  tickSlots,
  tickValue,
  glyphSpan,
  gutterWidth,
  tickTextX,
  GLYPH_RISE,
  GLYPH_DROP,
  GLYPH_H,
  COST_MAX_EXPAND,
  fitCost,
  fitCostDev,
  formatCost,
} = require('./axis');

/**
 * 字形常量的来源：在 Electron 33 的真实画布上用 9px "Segoe UI" 画 '+26.78%'，
 * baseline='middle'、刻度 y=1，逐行数墨迹，得到字形相对刻度 y 覆盖 -5..+1
 * （7 行）。RISE/DROP 就是这两个数，本文件全部断言以它为基准。
 */

test('字形常量与实测一致：middle 基线覆盖 -5..+1 共 7 行', () => {
  assert.equal(GLYPH_RISE, 5);
  assert.equal(GLYPH_DROP, 1);
  assert.equal(GLYPH_H, 7);
});

test('tickSlots 顶档 top 基线、底档 bottom 基线，不用 middle 去凑 y', () => {
  const slots = tickSlots(78);
  assert.equal(slots.length, 3);
  assert.deepEqual(
    slots.map((s) => s.baseline),
    ['top', 'middle', 'bottom']
  );
  assert.equal(slots[0].y, 0);
  assert.equal(slots[2].y, 78);
});

test('tickSlots 顶→底降序，中间档在正中', () => {
  const slots = tickSlots(80);
  assert.deepEqual(
    slots.map((s) => s.y),
    [0, 40, 80]
  );
});

test('每档字形都完整落在 [0, priceH] 内——这是本模块存在的理由', () => {
  // 回归：原实现顶档 y=1 + middle 基线，字形上沿到 -4，被画布裁掉 4 行
  for (const h of [14, 24, 40, 60, 78, 86, 120, 240]) {
    for (const slot of tickSlots(h)) {
      const [top, bot] = glyphSpan(slot);
      assert.ok(top >= 0, `priceH=${h} baseline=${slot.baseline} 上沿 ${top} < 0`);
      assert.ok(bot <= h, `priceH=${h} baseline=${slot.baseline} 下沿 ${bot} > ${h}`);
    }
  }
});

test('回归：旧写法（y=1 + middle）会溢出上沿 4 行', () => {
  // 用 glyphSpan 复现旧几何，证明这个断言真的能抓住那个 bug
  const [top] = glyphSpan({ y: 1, baseline: 'middle' });
  assert.equal(top, -4, '旧写法上沿应在 -4');
  assert.ok(top < 0, '旧写法必须被判为越界');
});

test('各档字形互不重叠', () => {
  for (const h of [24, 40, 78, 86, 120]) {
    const spans = tickSlots(h).map(glyphSpan);
    for (let i = 1; i < spans.length; i += 1) {
      assert.ok(
        spans[i][0] > spans[i - 1][1],
        `priceH=${h} 第 ${i} 档上沿 ${spans[i][0]} 压住上一档下沿 ${spans[i - 1][1]}`
      );
    }
  }
});

test('价格区放不下三档时减到两档，而不是让字形叠在一起', () => {
  const slots = tickSlots(20);
  assert.equal(slots.length, 2);
  assert.deepEqual(
    slots.map((s) => s.baseline),
    ['top', 'bottom']
  );
});

test('价格区连两档都放不下时只留顶档', () => {
  const slots = tickSlots(10);
  assert.equal(slots.length, 1);
  assert.equal(slots[0].baseline, 'top');
});

test('tickSlots 非法高度返回空数组，不抛错', () => {
  for (const bad of [0, -10, NaN, null, undefined, 'abc']) {
    assert.deepEqual(tickSlots(bad), [], `输入 ${String(bad)} 应返回空数组`);
  }
});

test('gutterWidth 容得下最宽文本加两侧余量', () => {
  // 实测 9px 字体下 '+26.78%' 宽 34.88，'-100.00%' 宽 37.17
  assert.ok(gutterWidth(34.88) >= 34.88 + 3, '至少装下文本与左侧呼吸位');
  assert.ok(gutterWidth(37.17) >= 37.17 + 3);
});

test('gutterWidth 回归：分时原 padR=34 装不下 +26.78%', () => {
  // 文本画在 padL+plotW+3，宽 34.88 → 需要 37.88，34 不够
  assert.ok(gutterWidth(34.88) > 34, '新算法必须给出比 34 更大的值');
  assert.equal(gutterWidth(34.88), 40);
});

test('gutterWidth 非法输入回落到纯余量，不产出 NaN', () => {
  for (const bad of [0, -5, NaN, null, undefined]) {
    const v = gutterWidth(bad);
    assert.ok(Number.isFinite(v) && v > 0, `输入 ${String(bad)} 得到 ${v}`);
  }
});

// —— tickValue：接替原 candle.js 的 axisTicks ——

test('tickValue 三档取值等于 [max, 中值, min]', () => {
  const slots = tickSlots(78);
  const vals = slots.map((s) => tickValue(s, 10, 20));
  assert.deepEqual(vals, [20, 15, 10]);
});

test('tickValue 减档时底档拿到 min，而不是把中值画到底部', () => {
  // 这正是抽出 tickValue 的原因：原写法按下标取预制数组 [max, mid, min]，
  // 减成两档后 values[1] 是 mid，却被画在底档位置上
  const slots = tickSlots(20); // 两档
  assert.equal(slots.length, 2);
  const vals = slots.map((s) => tickValue(s, 10, 20));
  assert.deepEqual(vals, [20, 10], '两档时应是顶=max、底=min');
});

test('tickValue 支持负数区间（分时的 -pctMax..+pctMax）', () => {
  const slots = tickSlots(86);
  const vals = slots.map((s) => tickValue(s, -8.47, 8.47));
  assert.equal(vals[0], 8.47);
  assert.equal(vals[1], 0, '对称区间中间档必须恰好是 0');
  assert.equal(vals[2], -8.47);
});

test('tickValue min 等于 max（停牌全平盘）时三档同值，不产出 NaN', () => {
  for (const s of tickSlots(78)) {
    assert.equal(tickValue(s, 10, 10), 10);
  }
});

test('tickValue 非法区间返回 NaN，由调用方决定怎么显示', () => {
  const slot = tickSlots(78)[0];
  assert.ok(Number.isNaN(tickValue(slot, NaN, 20)));
  assert.ok(Number.isNaN(tickValue(slot, null, undefined)));
});

test('tickTextX 与 gutterWidth 自洽：文本右沿不越出画布', () => {
  const padL = 2;
  const cssW = 504;
  const maxTextW = 34.88;
  const padR = gutterWidth(maxTextW);
  const plotW = cssW - padL - padR;
  const x = tickTextX(padL, plotW);
  assert.ok(x + maxTextW <= cssW, `右沿 ${x + maxTextW} 越出画布 ${cssW}`);
});

// —— fitCost：成本价并入真实高低区间（5日 / 日周K） ——

test('fitCost 成本在区间内时原样返回，不动纵轴', () => {
  const r = fitCost({ min: 10, max: 20 }, 15);
  assert.equal(r.min, 10);
  assert.equal(r.max, 20);
  assert.equal(r.cost, 15);
  assert.equal(r.edge, null);
});

test('fitCost 成本略在区间外时放大纵轴并留余量，线不贴边框', () => {
  const r = fitCost({ min: 10, max: 20 }, 9);
  assert.ok(r.min < 9, `min ${r.min} 应小于成本 9，否则线压在边框上`);
  assert.equal(r.max, 20); // 另一侧不动
  assert.equal(r.edge, null);
});

test('fitCost 成本远离区间时不放大，改报 edge 方向', () => {
  // 区间跨度 10，成本 5 需要跨度 15（1.5 倍）——刚好在上限内
  assert.equal(fitCost({ min: 10, max: 20 }, 5).edge, null);
  // 成本 1 需要跨度 19（1.9 倍），超上限
  const far = fitCost({ min: 10, max: 20 }, 1);
  assert.equal(far.edge, 'bottom');
  assert.equal(far.min, 10, '超上限时纵轴必须保持原样，不能压扁主图');
  assert.equal(far.max, 20);
  assert.equal(far.cost, 1, '仍要给出成本值，供边缘标记显示');

  const high = fitCost({ min: 10, max: 20 }, 100);
  assert.equal(high.edge, 'top');
  assert.equal(high.max, 20);
});

test('fitCost 放大上限就是 COST_MAX_EXPAND，不是散在代码里的魔数', () => {
  const span = 10;
  const min = 10;
  // 恰好等于上限：并入
  const edgeCase = fitCost({ min, max: min + span }, min - (span * COST_MAX_EXPAND - span));
  assert.equal(edgeCase.edge, null);
});

test('fitCost 无成本价 / 非法值时 cost 为 null，且不污染纵轴', () => {
  for (const bad of [null, undefined, '', 0, -5, NaN, 'abc']) {
    const r = fitCost({ min: 10, max: 20 }, bad);
    assert.equal(r.cost, null, `${bad} 应被拒绝`);
    assert.equal(r.min, 10);
    assert.equal(r.max, 20);
  }
});

test('fitCost 对 null 成本价不能走 Number(null)===0 的路，否则曲线被压到框底', () => {
  const r = fitCost({ min: 10, max: 20 }, null);
  assert.equal(r.cost, null);
  assert.equal(r.min, 10, '0 元被当成成本价并入会把 min 拉到 0 附近');
});

test('fitCost 非法区间不抛异常，cost 置 null', () => {
  const r = fitCost({ min: NaN, max: 20 }, 15);
  assert.equal(r.cost, null);
});

test('fitCost 零跨度区间不除零', () => {
  const r = fitCost({ min: 10, max: 10 }, 12);
  assert.equal(r.edge, 'top');
  assert.equal(r.cost, 12);
});

// —— fitCostDev：单日分时的对称纵轴 ——

test('fitCostDev 成本在对称范围内时 dev 不变', () => {
  const r = fitCostDev({ base: 100, dev: 5 }, 98);
  assert.equal(r.dev, 5);
  assert.equal(r.base, 100);
  assert.equal(r.cost, 98);
  assert.equal(r.edge, null);
});

test('fitCostDev 撑大 dev 时保持对称：base 不动', () => {
  const r = fitCostDev({ base: 100, dev: 1 }, 101.2);
  assert.equal(r.base, 100, '昨收必须仍在正中，否则右侧涨跌幅刻度的对称约定被破坏');
  assert.ok(r.dev >= 1.2, `dev ${r.dev} 必须覆盖偏离 1.2`);
  assert.equal(r.edge, null);
});

test('fitCostDev 超过放大上限时保留原 dev 并报 edge', () => {
  // 偏离 3，原 dev 1 → 需要 3.12 倍，超上限
  const r = fitCostDev({ base: 100, dev: 1 }, 103);
  assert.equal(r.dev, 1, '不能为一条参照线把当日振幅压扁');
  assert.equal(r.edge, 'top');
  assert.equal(r.cost, 103);

  const low = fitCostDev({ base: 100, dev: 1 }, 97);
  assert.equal(low.edge, 'bottom');
});

test('fitCostDev 非法输入不返回 NaN dev', () => {
  for (const bad of [null, '', 0, -1, NaN]) {
    const r = fitCostDev({ base: 100, dev: 2 }, bad);
    assert.equal(r.cost, null);
    assert.equal(r.dev, 2);
  }
  assert.equal(fitCostDev({ base: 100, dev: 0 }, 99).cost, null);
});

// —— formatCost ——

test('formatCost 去掉尾随零，但保留用户填的小数位', () => {
  assert.equal(formatCost(10), '10');
  assert.equal(formatCost(10.5), '10.5');
  assert.equal(formatCost(10.25), '10.25');
  assert.equal(formatCost(1.2345), '1.2345'); // 基金净值 4 位不能截成 1.23
  assert.equal(formatCost(1.203), '1.203');
});

test('formatCost 非法值给占位符而不是 NaN', () => {
  assert.equal(formatCost(NaN), '--');
  assert.equal(formatCost(null), '--');
  assert.equal(formatCost(undefined), '--');
});
