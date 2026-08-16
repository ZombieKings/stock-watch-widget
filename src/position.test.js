'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { parseCost, parseShares, computePosition, summarizePositions } = require('./position');

// —— parseCost ——

test('parseCost 接受正数，保留 4 位小数', () => {
  assert.equal(parseCost(1250), 1250);
  assert.equal(parseCost('1250.5'), 1250.5);
  assert.equal(parseCost(1.2345), 1.2345);
  assert.equal(parseCost(1.23456), 1.2346, '第 5 位四舍五入');
});

test('parseCost 拒绝 0 与负数——否则盈亏率会除零', () => {
  assert.equal(parseCost(0), null);
  assert.equal(parseCost('0'), null);
  assert.equal(parseCost(-10), null);
});

test('parseCost 拒绝空值与非数字', () => {
  for (const bad of ['', null, undefined, 'abc', {}, [], NaN, Infinity]) {
    assert.equal(parseCost(bad), null, `parseCost(${JSON.stringify(bad)})`);
  }
});

test('parseCost 拒绝离谱大值（挡住把数量填进成本价那格）', () => {
  assert.equal(parseCost(1e7 + 1), null);
  assert.equal(parseCost(1e7), 1e7, '上限本身可用');
});

// —— parseShares ——

test('parseShares 接受正整数与小数（基金份额可含小数）', () => {
  assert.equal(parseShares(100), 100);
  assert.equal(parseShares('1000'), 1000);
  assert.equal(parseShares(123.45), 123.45);
});

test('parseShares 把 0 视作未设置——与留空同义', () => {
  assert.equal(parseShares(0), null);
  assert.equal(parseShares('0'), null);
});

test('parseShares 拒绝负数与非法值', () => {
  for (const bad of [-1, '', null, undefined, 'abc', NaN, Infinity, {}]) {
    assert.equal(parseShares(bad), null, `parseShares(${JSON.stringify(bad)})`);
  }
});

// —— computePosition：只有成本价 ——

test('只有成本价时给出比例与每股盈亏，金额一律为 null', () => {
  const p = computePosition({ cost: 1250, shares: null, price: 1304.48 });
  assert.equal(p.hasAmount, false);
  assert.equal(p.profitPerShare, 54.48);
  assert.equal(p.profitPct, 4.36);
  assert.equal(p.profit, null);
  assert.equal(p.marketValue, null);
  assert.equal(p.costValue, null);
  assert.equal(p.todayProfit, null);
});

test('亏损时比例为负', () => {
  const p = computePosition({ cost: 100, shares: null, price: 90 });
  assert.equal(p.profitPerShare, -10);
  assert.equal(p.profitPct, -10);
});

test('现价等于成本价时盈亏为 0（不是 null）', () => {
  const p = computePosition({ cost: 100, shares: 100, price: 100 });
  assert.equal(p.profitPct, 0);
  assert.equal(p.profit, 0);
});

// —— computePosition：成本价 + 数量 ——

test('成本价 + 数量算出金额，与用户选定的示例一致', () => {
  const p = computePosition({ cost: 1250, shares: 100, price: 1304.48, change: 12.3 });
  assert.equal(p.hasAmount, true);
  assert.equal(p.costValue, 125000);
  assert.equal(p.marketValue, 130448);
  assert.equal(p.profit, 5448);
  assert.equal(p.profitPct, 4.36);
  assert.equal(p.todayProfit, 1230, '当日盈亏 = 涨跌额 × 数量');
});

test('市值 - 成本 恒等于盈亏（界面上三个数要自洽）', () => {
  // 取一组容易产生浮点误差的值
  const cases = [
    { cost: 12.34, shares: 333, price: 15.67 },
    { cost: 0.1, shares: 3, price: 0.3 },
    { cost: 1250.55, shares: 137, price: 1304.48 },
    { cost: 3.1415, shares: 999.99, price: 2.7182 },
  ];
  for (const c of cases) {
    const p = computePosition(c);
    const diff = Math.round((p.marketValue - p.costValue) * 100) / 100;
    assert.equal(p.profit, diff, `市值-成本≠盈亏 于 ${JSON.stringify(c)}`);
  }
});

test('浮点误差被收口：0.1 × 3 不出现 0.30000000000000004', () => {
  const p = computePosition({ cost: 0.1, shares: 3, price: 0.2 });
  assert.equal(p.costValue, 0.3);
  assert.equal(p.marketValue, 0.6);
  assert.equal(String(p.profit), '0.3');
});

test('当日涨跌额缺失时 todayProfit 为 null，不是 0', () => {
  // 0 会被误读成「今天没涨没跌」，而实际是「不知道」
  const p = computePosition({ cost: 100, shares: 100, price: 110 });
  assert.equal(p.todayProfit, null);
});

test('当日下跌时 todayProfit 为负', () => {
  const p = computePosition({ cost: 100, shares: 200, price: 110, change: -1.5 });
  assert.equal(p.todayProfit, -300);
});

// —— computePosition：边界 ——

test('未设成本价返回 null，界面据此整块隐藏', () => {
  assert.equal(computePosition({ cost: null, shares: 100, price: 10 }), null);
  assert.equal(computePosition({ cost: 0, shares: 100, price: 10 }), null);
  assert.equal(computePosition({}), null);
  assert.equal(computePosition(null), null);
});

test('停牌/未开盘（现价 0 或缺失）返回 null，而不是亏损 100%', () => {
  for (const price of [0, null, undefined, NaN, -1, 'x']) {
    assert.equal(
      computePosition({ cost: 100, shares: 100, price }),
      null,
      `price=${JSON.stringify(price)} 应返回 null`
    );
  }
});

test('数量为 0 等同未填：有比例无金额', () => {
  const p = computePosition({ cost: 100, shares: 0, price: 110 });
  assert.equal(p.hasAmount, false);
  assert.equal(p.profitPct, 10);
});

test('极小成本价不产出 Infinity', () => {
  const p = computePosition({ cost: 0.0001, shares: 1, price: 100 });
  assert.ok(Number.isFinite(p.profitPct));
  assert.ok(Number.isFinite(p.profit));
});

// —— summarizePositions ——

test('汇总只计入有数量的条目', () => {
  const s = summarizePositions([
    { position: computePosition({ cost: 100, shares: 100, price: 110, change: 1 }) },
    { position: computePosition({ cost: 50, shares: 200, price: 45, change: -0.5 }) },
    { position: computePosition({ cost: 10, shares: null, price: 20 }) }, // 只有成本价，排除
    { position: null }, // 未设持仓
    {}, // 无 position 字段
  ]);
  assert.equal(s.counted, 2);
  assert.equal(s.costValue, 100 * 100 + 50 * 200); // 20000
  assert.equal(s.marketValue, 110 * 100 + 45 * 200); // 20000
  assert.equal(s.profit, 0, '一盈一亏刚好抵平');
  assert.equal(s.profitPct, 0);
  assert.equal(s.todayProfit, 1 * 100 + -0.5 * 200); // 0
});

test('汇总盈亏率按总成本加权，不是各股比例的平均', () => {
  // 大仓小涨 + 小仓大涨：简单平均会得 +30%，加权应接近 +10%
  const s = summarizePositions([
    { position: computePosition({ cost: 100, shares: 1000, price: 105 }) }, // +5%，成本 10 万
    { position: computePosition({ cost: 10, shares: 100, price: 15 }) }, // +50%，成本 1000
  ]);
  assert.equal(s.costValue, 101000);
  assert.equal(s.marketValue, 106500);
  assert.equal(s.profit, 5500);
  assert.equal(s.profitPct, 5.45, '加权后约 +5.45%，而非简单平均的 +27.5%');
});

test('无任何持仓时汇总为 null，界面不显示汇总行', () => {
  assert.equal(summarizePositions([]), null);
  assert.equal(summarizePositions(null), null);
  assert.equal(summarizePositions([{ position: null }]), null);
  assert.equal(
    summarizePositions([{ position: computePosition({ cost: 10, shares: null, price: 20 }) }]),
    null,
    '只填成本价的不计入金额汇总'
  );
});

test('汇总里 todayProfit 全缺失时为 null', () => {
  const s = summarizePositions([
    { position: computePosition({ cost: 100, shares: 10, price: 110 }) },
  ]);
  assert.equal(s.todayProfit, null);
  assert.equal(s.profit, 100, '盈亏金额仍要算出来');
});

test('汇总里部分条目有当日涨跌额时只累加已知部分', () => {
  const s = summarizePositions([
    { position: computePosition({ cost: 100, shares: 10, price: 110, change: 2 }) },
    { position: computePosition({ cost: 100, shares: 10, price: 110 }) }, // 无 change
  ]);
  assert.equal(s.todayProfit, 20);
});
