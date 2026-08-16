'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  SIDES,
  MAX_TRADES,
  round4,
  isValidDateKey,
  monthKey,
  localToday,
  normalizeTrade,
  normalizeTrades,
  normalizeTradeBook,
  replayTrades,
  realizedInRange,
  derivePosition,
} = require('./trades');

const { computePosition } = require('./position');

/** 造一笔流水，省掉重复字面量 */
function buy(date, price, shares) {
  return { date, side: 'buy', price, shares };
}
function sell(date, price, shares) {
  return { date, side: 'sell', price, shares };
}

// —— isValidDateKey ——

test('isValidDateKey 认 YYYY-MM-DD', () => {
  assert.equal(isValidDateKey('2026-03-14'), true);
  assert.equal(isValidDateKey('2026-01-01'), true);
  assert.equal(isValidDateKey('2026-12-31'), true);
});

test('isValidDateKey 拒绝格式不对的', () => {
  for (const bad of ['2026-3-14', '20260314', '2026/03/14', '26-03-14', '', null, undefined, 42, {}]) {
    assert.equal(isValidDateKey(bad), false, `isValidDateKey(${JSON.stringify(bad)})`);
  }
});

test('isValidDateKey 拒绝格式对但不存在的日期', () => {
  // 只验格式不够：Date 会把 2026-02-30 静默滚到 3 月 2 日，
  // 于是排序与月度归集都错位
  assert.equal(isValidDateKey('2026-02-30'), false);
  assert.equal(isValidDateKey('2026-13-01'), false);
  assert.equal(isValidDateKey('2026-00-10'), false);
  assert.equal(isValidDateKey('2026-04-31'), false, '4 月只有 30 天');
});

test('isValidDateKey 正确处理闰年', () => {
  assert.equal(isValidDateKey('2024-02-29'), true, '2024 是闰年');
  assert.equal(isValidDateKey('2026-02-29'), false, '2026 不是闰年');
  assert.equal(isValidDateKey('2000-02-29'), true, '整百闰年规则');
  assert.equal(isValidDateKey('1900-02-29'), false, '1900 不是闰年');
});

test('isValidDateKey 不受本地时区影响', () => {
  // 用本地 Date 构造会让 UTC+8 下的 '2026-01-01' 变成前一天，
  // 判定就会误报。实现里用的是 Date.UTC
  assert.equal(isValidDateKey('2026-01-01'), true);
  assert.equal(isValidDateKey('2026-12-31'), true);
});

// —— monthKey ——

test('monthKey 取年月，跨年不冲突', () => {
  assert.equal(monthKey('2026-07-02'), '2026-07');
  assert.equal(monthKey('2025-07-02'), '2025-07');
  assert.notEqual(monthKey('2025-07-01'), monthKey('2026-07-01'), '含年份，跨年键必须不同');
});

test('monthKey 输入为空时不抛错', () => {
  assert.equal(monthKey(null), '');
  assert.equal(monthKey(undefined), '');
});

// —— normalizeTrade ——

test('normalizeTrade 接受一笔完整流水', () => {
  const t = normalizeTrade({ id: 't1', date: '2026-03-14', side: 'buy', price: 1620.5, shares: 100 });
  assert.deepEqual(t, { id: 't1', date: '2026-03-14', side: 'buy', price: 1620.5, shares: 100 });
});

test('normalizeTrade 日期非法时整条丢弃', () => {
  assert.equal(normalizeTrade({ date: '2026-02-30', side: 'buy', price: 10, shares: 1 }), null);
  assert.equal(normalizeTrade({ date: 'x', side: 'buy', price: 10, shares: 1 }), null);
  assert.equal(normalizeTrade({ side: 'buy', price: 10, shares: 1 }), null, '缺 date');
});

test('normalizeTrade side 只认 buy/sell', () => {
  for (const s of SIDES) {
    assert.ok(normalizeTrade({ date: '2026-03-14', side: s, price: 10, shares: 1 }));
  }
  for (const bad of ['BUY', '买入', 'b', '', null, undefined, 1]) {
    assert.equal(
      normalizeTrade({ date: '2026-03-14', side: bad, price: 10, shares: 1 }),
      null,
      `side=${JSON.stringify(bad)}`
    );
  }
});

test('normalizeTrade 价格为 0 或负数时丢弃', () => {
  // 0 价流水（送股/转增）本轻量版不支持：硬塞成 0 价买入会把加权平均成本算成 0
  for (const bad of [0, -10, '0', null, '', 'abc', NaN]) {
    assert.equal(
      normalizeTrade({ date: '2026-03-14', side: 'buy', price: bad, shares: 1 }),
      null,
      `price=${JSON.stringify(bad)}`
    );
  }
});

test('normalizeTrade 数量为 0 时丢弃——0 股的流水没有意义', () => {
  for (const bad of [0, -1, null, '', 'abc']) {
    assert.equal(
      normalizeTrade({ date: '2026-03-14', side: 'buy', price: 10, shares: bad }),
      null,
      `shares=${JSON.stringify(bad)}`
    );
  }
});

test('normalizeTrade 接受字符串价格与数量（输入框存的是原文）', () => {
  const t = normalizeTrade({ date: '2026-03-14', side: 'buy', price: '1620.5', shares: '100' });
  assert.equal(t.price, 1620.5);
  assert.equal(t.shares, 100);
});

test('normalizeTrade 缺 id 时给空串，不产出 undefined', () => {
  const t = normalizeTrade({ date: '2026-03-14', side: 'buy', price: 10, shares: 1 });
  assert.equal(t.id, '');
});

test('normalizeTrade 非对象输入返回 null', () => {
  for (const bad of [null, undefined, 'x', 42, []]) {
    assert.equal(normalizeTrade(bad), null, `normalizeTrade(${JSON.stringify(bad)})`);
  }
});

// —— normalizeTrades ——

test('normalizeTrades 按日期升序排——顺序错了加权平均成本就错了', () => {
  const list = normalizeTrades([buy('2026-05-20', 1700, 100), buy('2026-03-14', 1620.5, 100)]);
  assert.deepEqual(list.map((t) => t.date), ['2026-03-14', '2026-05-20']);
});

test('normalizeTrades 同日多笔保持输入顺序（稳定排序）', () => {
  // 同一天的输入顺序就是发生顺序。打乱会让「当天先买后卖」变成「先卖后买」，
  // 回放出 oversold
  const list = normalizeTrades([
    buy('2026-03-14', 100, 50),
    sell('2026-03-14', 110, 30),
    buy('2026-03-14', 105, 20),
  ]);
  assert.deepEqual(list.map((t) => `${t.side}${t.shares}`), ['buy50', 'sell30', 'buy20']);
});

test('normalizeTrades 剔除非法项，保留合法的', () => {
  const list = normalizeTrades([
    buy('2026-03-14', 100, 50),
    { date: 'bad', side: 'buy', price: 1, shares: 1 },
    null,
    sell('2026-03-15', 110, 30),
  ]);
  assert.equal(list.length, 2);
});

test('normalizeTrades 非数组输入返回空数组', () => {
  for (const bad of [null, undefined, 'x', 42, {}]) {
    assert.deepEqual(normalizeTrades(bad), [], `normalizeTrades(${JSON.stringify(bad)})`);
  }
});

test('normalizeTrades 超上限时保留最早的——加权平均成本依赖完整历史', () => {
  // 砍掉早期买入会让成本凭空变化，所以从末尾截
  const many = [];
  for (let i = 0; i < MAX_TRADES + 10; i += 1) {
    many.push(buy('2026-03-14', 100 + i, 1));
  }
  const list = normalizeTrades(many);
  assert.equal(list.length, MAX_TRADES);
  assert.equal(list[0].price, 100, '最早那笔必须留着');
});

// —— replayTrades：单笔 ——

test('单笔买入：avgCost = 买入价，已实现为 0', () => {
  const s = replayTrades([buy('2026-03-14', 1620.5, 100)]);
  assert.equal(s.shares, 100);
  assert.equal(s.avgCost, 1620.5);
  assert.equal(s.realized, 0);
  assert.equal(s.oversold, false);
});

test('空流水返回零值而非 null，调用方不必判空', () => {
  const s = replayTrades([]);
  assert.equal(s.shares, 0);
  assert.equal(s.avgCost, null, '无持仓时成本为 null');
  assert.equal(s.realized, 0);
  assert.deepEqual(s.realizedByMonth, {});
  assert.deepEqual(s.lots, []);
});

test('replayTrades 接受未规范化的输入（内部会再过一遍）', () => {
  const s = replayTrades([
    { date: '2026-03-14', side: 'buy', price: '100', shares: '10' },
    { date: 'bad', side: 'buy', price: 1, shares: 1 },
  ]);
  assert.equal(s.shares, 10);
  assert.equal(s.avgCost, 100);
});

// —— replayTrades：加权平均成本 ——

test('两笔买入按数量加权平均', () => {
  // (1620.5×100 + 1700×100) / 200 = 1660.25
  const s = replayTrades([buy('2026-03-14', 1620.5, 100), buy('2026-05-20', 1700, 100)]);
  assert.equal(s.shares, 200);
  assert.equal(s.avgCost, 1660.25);
});

test('不同数量的两笔买入，权重按数量而非笔数', () => {
  // (100×900 + 200×100) / 1000 = 110
  const s = replayTrades([buy('2026-03-14', 100, 900), buy('2026-03-15', 200, 100)]);
  assert.equal(s.shares, 1000);
  assert.equal(s.avgCost, 110, '简单平均会得 150，加权应得 110');
});

test('卖出不改变加权平均成本 —— 加权平均法的核心', () => {
  // 写成「卖出后重算平均」就变成了移动加权，同一串流水会算出不同的已实现盈亏
  const s = replayTrades([
    buy('2026-03-14', 1620.5, 100),
    buy('2026-05-20', 1700, 100),
    sell('2026-07-02', 1750, 40),
  ]);
  assert.equal(s.avgCost, 1660.25, '卖出后 avgCost 必须与卖出前一致');
  assert.equal(s.shares, 160);
});

test('高价卖出后 avgCost 不被抬高，低价卖出也不被压低', () => {
  const base = [buy('2026-03-14', 100, 100)];
  const high = replayTrades([...base, sell('2026-04-01', 500, 10)]);
  const low = replayTrades([...base, sell('2026-04-01', 20, 10)]);
  assert.equal(high.avgCost, 100);
  assert.equal(low.avgCost, 100);
  assert.equal(high.avgCost, low.avgCost, '卖价高低都不该影响剩余持仓的成本');
});

// —— replayTrades：已实现盈亏 ——

test('部分卖出：已实现 = (卖价 - avgCost) × 卖出数量', () => {
  // (1750 - 1660.25) × 40 = 3590
  const s = replayTrades([
    buy('2026-03-14', 1620.5, 100),
    buy('2026-05-20', 1700, 100),
    sell('2026-07-02', 1750, 40),
  ]);
  assert.equal(s.realized, 3590);
});

test('亏损卖出时已实现为负', () => {
  const s = replayTrades([buy('2026-03-14', 100, 100), sell('2026-04-01', 90, 50)]);
  assert.equal(s.realized, -500);
});

test('多次卖出累加已实现', () => {
  const s = replayTrades([
    buy('2026-03-14', 100, 100),
    sell('2026-04-01', 110, 30), // +300
    sell('2026-05-01', 120, 30), // +600
  ]);
  assert.equal(s.realized, 900);
});

test('全部卖出后 shares=0、avgCost=null，已实现保留', () => {
  const s = replayTrades([buy('2026-03-14', 100, 100), sell('2026-04-01', 120, 100)]);
  assert.equal(s.shares, 0);
  assert.equal(s.avgCost, null, '已清仓，没有浮动成本');
  assert.equal(s.realized, 2000, '已实现盈亏必须留着');
});

test('清仓后再买入：avgCost 从新买入价重算，不受历史影响', () => {
  // 「割肉后抄底」不该把旧成本带进新仓位
  const s = replayTrades([
    buy('2026-03-14', 200, 100),
    sell('2026-04-01', 150, 100), // 清仓，亏 5000
    buy('2026-05-01', 100, 100), // 重新买入
  ]);
  assert.equal(s.avgCost, 100, '新仓位成本就是新买入价');
  assert.equal(s.shares, 100);
  assert.equal(s.realized, -5000, '之前的亏损仍计入已实现');
});

test('清仓后浮点残值被清零，不让下一笔的 avgCost 偏高', () => {
  // 浮点减法可能在成本额上留下 0.01 的残值，带着它再买入会污染新成本
  const s = replayTrades([
    buy('2026-03-14', 0.1, 3),
    sell('2026-04-01', 0.2, 3),
    buy('2026-05-01', 1, 10),
  ]);
  assert.equal(s.avgCost, 1, `清仓后再买入的成本应恰好是 1，得到 ${s.avgCost}`);
});

// —— replayTrades：oversold ——

test('卖出超过持仓时置 oversold，不产出负持仓', () => {
  // 负持仓会让 avgCost 变成负数，后面每一笔都跟着错
  const s = replayTrades([buy('2026-03-14', 100, 50), sell('2026-04-01', 110, 80)]);
  assert.equal(s.oversold, true);
  assert.equal(s.shares, 0, '最多卖掉手上全部');
  assert.ok(s.shares >= 0, '绝不产出负持仓');
  assert.equal(s.realized, 500, '按实际能卖的 50 股算：(110-100)×50');
});

test('没有持仓就卖出：置 oversold 且不产生已实现盈亏', () => {
  const s = replayTrades([sell('2026-04-01', 110, 50)]);
  assert.equal(s.oversold, true);
  assert.equal(s.shares, 0);
  assert.equal(s.realized, 0, '没有成本基准，算不出盈亏');
});

test('正好卖光不算 oversold', () => {
  const s = replayTrades([buy('2026-03-14', 100, 50), sell('2026-04-01', 110, 50)]);
  assert.equal(s.oversold, false);
  assert.equal(s.shares, 0);
});

// —— replayTrades：realizedByMonth ——

test('realizedByMonth 按卖出日期归月，不按买入日期', () => {
  // 买入不产生盈亏。按买入日归月会把「去年买、今年卖」的收益记到去年
  const s = replayTrades([buy('2025-11-01', 100, 100), sell('2026-03-14', 120, 100)]);
  assert.deepEqual(s.realizedByMonth, { '2026-03': 2000 });
  assert.ok(!('2025-11' in s.realizedByMonth), '买入月不该出现');
});

test('realizedByMonth 同月多笔累加', () => {
  const s = replayTrades([
    buy('2026-03-01', 100, 100),
    sell('2026-04-05', 110, 30),
    sell('2026-04-20', 120, 30),
  ]);
  assert.deepEqual(s.realizedByMonth, { '2026-04': 900 });
});

test('realizedByMonth 跨年同月不冲突', () => {
  const s = replayTrades([
    buy('2025-01-01', 100, 200),
    sell('2025-07-01', 110, 50), // +500
    sell('2026-07-01', 120, 50), // +1000
  ]);
  assert.equal(s.realizedByMonth['2025-07'], 500);
  assert.equal(s.realizedByMonth['2026-07'], 1000);
});

test('realizedByMonth 各月之和等于总已实现', () => {
  const s = replayTrades([
    buy('2026-01-01', 100, 300),
    sell('2026-02-01', 110, 100),
    sell('2026-03-01', 90, 100),
    sell('2026-04-01', 130, 100),
  ]);
  const sum = Object.values(s.realizedByMonth).reduce((a, b) => a + b, 0);
  assert.equal(Math.round(sum * 100) / 100, s.realized);
});

// —— replayTrades：lots ——

test('lots 与流水一一对应，买入笔的 realized 为 0', () => {
  const s = replayTrades([buy('2026-03-14', 100, 100), sell('2026-04-01', 110, 50)]);
  assert.equal(s.lots.length, 2);
  assert.equal(s.lots[0].realized, 0, '买入不产生已实现盈亏');
  assert.equal(s.lots[1].realized, 500);
});

test('lots 每笔带 sharesAfter 与 avgCostAfter——界面靠它显示持仓演变', () => {
  const s = replayTrades([
    buy('2026-03-14', 100, 100),
    buy('2026-04-01', 200, 100),
    sell('2026-05-01', 250, 50),
  ]);
  assert.equal(s.lots[0].sharesAfter, 100);
  assert.equal(s.lots[0].avgCostAfter, 100);
  assert.equal(s.lots[1].sharesAfter, 200);
  assert.equal(s.lots[1].avgCostAfter, 150, '两笔加权后 150');
  assert.equal(s.lots[2].sharesAfter, 150);
  assert.equal(s.lots[2].avgCostAfter, 150, '卖出不改变成本');
});

test('lots 清仓那笔的 avgCostAfter 为 null', () => {
  const s = replayTrades([buy('2026-03-14', 100, 100), sell('2026-04-01', 110, 100)]);
  assert.equal(s.lots[1].sharesAfter, 0);
  assert.equal(s.lots[1].avgCostAfter, null);
});

test('lots 保留原始的日期、方向、价格、数量', () => {
  const s = replayTrades([buy('2026-03-14', 1620.5, 100)]);
  const lot = s.lots[0];
  assert.equal(lot.date, '2026-03-14');
  assert.equal(lot.side, 'buy');
  assert.equal(lot.price, 1620.5);
  assert.equal(lot.shares, 100);
});

// —— 浮点 ——

test('浮点误差被收口：1620.5 × 100 的累计不出现小数尾巴', () => {
  const s = replayTrades([buy('2026-03-14', 1620.5, 100), buy('2026-03-15', 1620.5, 100)]);
  assert.equal(s.avgCost, 1620.5);
  assert.equal(String(s.shares), '200');
});

test('浮点：0.1 三份不产出 0.30000000000000004', () => {
  const s = replayTrades([buy('2026-03-14', 0.1, 3), sell('2026-04-01', 0.3, 3)]);
  assert.equal(String(s.realized), '0.6');
});

test('多笔小数流水累加后金额不漂', () => {
  const trades = [];
  for (let i = 0; i < 30; i += 1) trades.push(buy('2026-03-14', 3.1415, 999.99));
  const s = replayTrades(trades);
  assert.ok(Number.isFinite(s.avgCost));
  // 成本应恒等于单价（同价多笔），不该因累加漂移
  assert.equal(s.avgCost, 3.1415, `30 笔同价买入后成本应仍是 3.1415，得到 ${s.avgCost}`);
});

test('基金份额可含小数', () => {
  const s = replayTrades([buy('2026-03-14', 1.2345, 1234.56)]);
  assert.equal(s.shares, 1234.56);
  assert.equal(s.avgCost, 1.2345);
});

test('round4 保留 4 位——加权平均成本不能按分舍入', () => {
  // 基金净值本来就是 4 位小数。用 round2 收口会把 1.2345 变成 1.23，
  // 误差 0.4%：在盈亏计算里这不是舍入噪声而是错。
  // 这条测试钉住那个精度，防止有人「统一用 round2」把它改回去
  assert.equal(round4(1.2345), 1.2345);
  assert.equal(round4(1.23456), 1.2346, '第 5 位四舍五入');
  assert.equal(round4(0.1 + 0.2), 0.3, '浮点误差被收掉');
});

test('回归：4 位净价的基金，成本精度不因舍入而丢失', () => {
  // 若 avgCost 按 2 位舍入，这里会得到 1.23 而非 1.2345
  const s = replayTrades([buy('2026-03-14', 1.2345, 1000), buy('2026-04-01', 1.2345, 1000)]);
  assert.equal(s.avgCost, 1.2345, `同价两笔的成本必须仍是 1.2345，得到 ${s.avgCost}`);
});

test('回归：两个不同 4 位净价的加权平均保留 4 位', () => {
  // (1.2000×1000 + 1.4000×1000) / 2000 = 1.3
  const s = replayTrades([buy('2026-03-14', 1.2, 1000), buy('2026-04-01', 1.4, 1000)]);
  assert.equal(s.avgCost, 1.3);
  // (1.1111×1000 + 1.3333×1000) / 2000 = 1.2222
  const s2 = replayTrades([buy('2026-03-14', 1.1111, 1000), buy('2026-04-01', 1.3333, 1000)]);
  assert.equal(s2.avgCost, 1.2222);
});

test('已实现盈亏仍按分（round2）——那是「元」的精度', () => {
  // 单价 4 位、金额 2 位是刻意的分工：净值有 4 位小数，但钱只到分
  const s = replayTrades([buy('2026-03-14', 1.2345, 1000), sell('2026-04-01', 1.5, 1000)]);
  // (1.5 - 1.2345) × 1000 = 265.5
  assert.equal(s.realized, 265.5);
  const decimals = String(s.realized).split('.')[1] || '';
  assert.ok(decimals.length <= 2, `已实现盈亏应不超过 2 位小数，得到 ${s.realized}`);
});

// —— realizedInRange ——

test("realizedInRange('all') 返回全部已实现", () => {
  const s = replayTrades([
    buy('2026-01-01', 100, 200),
    sell('2026-02-01', 110, 100),
    sell('2026-08-01', 120, 100),
  ]);
  assert.equal(realizedInRange(s, 'all'), 3000);
});

test("realizedInRange('month') 只算当月", () => {
  const s = replayTrades([
    buy('2026-01-01', 100, 200),
    sell('2026-07-15', 110, 100), // 上月
    sell('2026-08-05', 120, 100), // 本月
  ]);
  assert.equal(realizedInRange(s, 'month', '2026-08-13'), 2000);
  assert.equal(realizedInRange(s, 'month', '2026-07-20'), 1000);
});

test('realizedInRange 月份边界：月初与月末都算在内', () => {
  const s = replayTrades([
    buy('2026-01-01', 100, 300),
    sell('2026-08-01', 110, 100),
    sell('2026-08-31', 110, 100),
  ]);
  assert.equal(realizedInRange(s, 'month', '2026-08-15'), 2000, '整月都该算进来');
});

test('realizedInRange 当月无卖出时为 0（不是 null）', () => {
  const s = replayTrades([buy('2026-01-01', 100, 100)]);
  assert.equal(realizedInRange(s, 'month', '2026-08-13'), 0);
});

test('realizedInRange 未知 range 按 all 处理', () => {
  const s = replayTrades([buy('2026-01-01', 100, 100), sell('2026-02-01', 110, 100)]);
  assert.equal(realizedInRange(s, 'garbage'), 1000);
  assert.equal(realizedInRange(s, undefined), 1000);
});

test('realizedInRange 输入为空时返回 0', () => {
  assert.equal(realizedInRange(null, 'all'), 0);
  assert.equal(realizedInRange(undefined, 'month', '2026-08-13'), 0);
});

test('localToday 给出本地 YYYY-MM-DD，不受 UTC 偏移影响', () => {
  // 用 toISOString 会在 UTC+8 的凌晨把日期算成前一天
  assert.match(localToday(), /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(localToday(new Date(2026, 0, 1, 0, 30)), '2026-01-01', '本地凌晨仍是当天');
  assert.equal(localToday(new Date(2026, 11, 31, 23, 30)), '2026-12-31', '本地深夜仍是当天');
});

// —— derivePosition ——

test('derivePosition 有持仓时给出成本与数量', () => {
  const p = derivePosition([buy('2026-03-14', 1620.5, 100), buy('2026-05-20', 1700, 100)]);
  assert.deepEqual(p, { cost: 1660.25, shares: 200 });
});

test('derivePosition 已清仓时 cost 为 null——界面隐藏浮动盈亏', () => {
  // 已清仓的股票没有浮动盈亏，它的收益全在「已实现」那一栏
  const p = derivePosition([buy('2026-03-14', 100, 100), sell('2026-04-01', 120, 100)]);
  assert.equal(p.cost, null);
  assert.equal(p.shares, null, 'shares 为 0 时给 null，与 parseShares 的语义一致');
});

test('derivePosition 空流水时两项都是 null', () => {
  assert.deepEqual(derivePosition([]), { cost: null, shares: null });
  assert.deepEqual(derivePosition(null), { cost: null, shares: null });
});

test('derivePosition 的输出能直接喂给 computePosition（形状契约）', () => {
  // main.js 的 effectiveHolding 靠这个契约把「流水推导的持仓」
  // 无缝替换掉「用户手填的持仓」
  const p = derivePosition([buy('2026-03-14', 1250, 100)]);
  const pos = computePosition({ cost: p.cost, shares: p.shares, price: 1304.48, change: 12.3 });
  assert.ok(pos, '应算出持仓盈亏');
  assert.equal(pos.cost, 1250);
  assert.equal(pos.shares, 100);
  assert.equal(pos.profit, 5448);
  assert.equal(pos.hasAmount, true);
});

test('已清仓的推导结果喂给 computePosition 得到 null（界面整块隐藏）', () => {
  const p = derivePosition([buy('2026-03-14', 100, 100), sell('2026-04-01', 120, 100)]);
  assert.equal(computePosition({ cost: p.cost, shares: p.shares, price: 130 }), null);
});

// —— normalizeTradeBook ——

test('normalizeTradeBook 逐个代码规范化', () => {
  const book = normalizeTradeBook({
    sh600519: [buy('2026-03-14', 100, 10)],
    sz000858: [buy('2026-03-15', 200, 20)],
  });
  assert.deepEqual(Object.keys(book).sort(), ['sh600519', 'sz000858']);
  assert.equal(book.sh600519.length, 1);
});

test('normalizeTradeBook 删掉空数组的键——否则文件随「加了又删」单调膨胀', () => {
  const book = normalizeTradeBook({
    sh600519: [buy('2026-03-14', 100, 10)],
    sz000858: [],
    sz300750: [{ date: 'bad', side: 'buy', price: 1, shares: 1 }], // 全部非法 → 空
  });
  assert.deepEqual(Object.keys(book), ['sh600519']);
});

test('normalizeTradeBook 非对象输入返回空账本', () => {
  for (const bad of [null, undefined, 'x', 42, []]) {
    assert.deepEqual(normalizeTradeBook(bad), {}, `normalizeTradeBook(${JSON.stringify(bad)})`);
  }
});

test('normalizeTradeBook 内部各股票的流水各自排序', () => {
  const book = normalizeTradeBook({
    sh600519: [buy('2026-05-20', 1700, 100), buy('2026-03-14', 1620.5, 100)],
  });
  assert.deepEqual(book.sh600519.map((t) => t.date), ['2026-03-14', '2026-05-20']);
});

// —— 综合场景 ——

test('综合：一年的买卖序列，逐项核对', () => {
  const s = replayTrades([
    buy('2026-01-15', 50, 1000), // 持 1000，成本 50
    buy('2026-02-20', 60, 1000), // 持 2000，成本 55
    sell('2026-03-10', 70, 500), // 已实现 (70-55)×500 = 7500，持 1500，成本仍 55
    sell('2026-08-05', 45, 500), // 已实现 (45-55)×500 = -5000，持 1000，成本仍 55
  ]);
  assert.equal(s.shares, 1000);
  assert.equal(s.avgCost, 55, '两次卖出都不改变成本');
  assert.equal(s.realized, 2500, '7500 - 5000');
  assert.equal(s.realizedByMonth['2026-03'], 7500);
  assert.equal(s.realizedByMonth['2026-08'], -5000);
  assert.equal(realizedInRange(s, 'month', '2026-08-13'), -5000);
  assert.equal(realizedInRange(s, 'all'), 2500);
  assert.equal(s.oversold, false);
});

test('综合：流水顺序被打乱后结果不变（内部会重排）', () => {
  const ordered = [
    buy('2026-01-15', 50, 1000),
    buy('2026-02-20', 60, 1000),
    sell('2026-03-10', 70, 500),
  ];
  const shuffled = [ordered[2], ordered[0], ordered[1]];
  const a = replayTrades(ordered);
  const b = replayTrades(shuffled);
  assert.equal(a.avgCost, b.avgCost);
  assert.equal(a.realized, b.realized);
  assert.equal(a.shares, b.shares);
});
