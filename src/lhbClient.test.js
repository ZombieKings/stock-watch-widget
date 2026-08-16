'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const {
  parseLhbRow,
  buildLhb,
  daysBetween,
  fetchLhb,
  REPORT_NAME,
  RECENT_DAYS,
  MAX_LIMIT,
} = require('./lhbClient');

/** 奥士康 2026-08-07 上榜的真实报表行，抄录本模块用到的字段 */
const REAL_ROW = {
  TRADE_DATE: '2026-08-07 00:00:00',
  DEAL_AMOUNT_RATIO: 46.57468855041,
  BILLBOARD_DEAL_AMT: 658022892.25,
  FREE_MARKET_CAP: 16927425168.08,
  EXPLAIN: '4家机构买入，成功率15.98%',
  SECUCODE: '002913.SZ',
  SECURITY_CODE: '002913',
  CLOSE_PRICE: 55.42,
  CHANGE_RATE: 10.004,
  TURNOVERRATE: 2.2209,
  D1_CLOSE_ADJCHRATE: null,
  D5_CLOSE_ADJCHRATE: null,
  SECURITY_NAME_ABBR: '奥士康',
  EXPLANATION: '连续三个交易日内，涨幅偏离值累计达到20%的证券',
  BILLBOARD_SELL_AMT: 348836908.59,
  BILLBOARD_BUY_AMT: 309185983.66,
  BILLBOARD_NET_AMT: -39650924.93,
  ACCUM_AMOUNT: 1412833693,
  MARKET: 'SZ',
};

/** 同一只股 2023 年的历史记录，上榜后表现已有值 */
const OLD_ROW = {
  TRADE_DATE: '2023-05-29 00:00:00',
  EXPLAIN: '上海资金买入，成功率29.12%',
  SECUCODE: '002913.SZ',
  CLOSE_PRICE: 39.61,
  CHANGE_RATE: 9.9972,
  TURNOVERRATE: 5.0497,
  D1_CLOSE_ADJCHRATE: 0.1514769,
  D5_CLOSE_ADJCHRATE: -2.19641505,
  SECURITY_NAME_ABBR: '奥士康',
  EXPLANATION: '日涨幅偏离值达到7%的前5只证券',
  BILLBOARD_SELL_AMT: 153220590.16,
  BILLBOARD_BUY_AMT: 95138377.96,
  BILLBOARD_NET_AMT: -58082212.2,
};

// —— 单条解析 ——

test('parseLhbRow：字段名对得上', () => {
  const d = parseLhbRow(REAL_ROW);
  assert.equal(d.date, '2026-08-07');
  assert.equal(d.name, '奥士康');
  assert.equal(d.reason, '连续三个交易日内，涨幅偏离值累计达到20%的证券', 'EXPLANATION 上榜原因');
  assert.equal(d.seatNote, '4家机构买入，成功率15.98%', 'EXPLAIN 营业部摘要');
  assert.equal(d.buyAmount, 309185983.66);
  assert.equal(d.sellAmount, 348836908.59);
  assert.equal(d.netAmount, -39650924.93);
  assert.equal(d.dealRatio, 46.57468855041);
  assert.equal(d.totalAmount, 1412833693);
  assert.equal(d.close, 55.42);
  assert.equal(d.changePct, 10.004);
  assert.equal(d.turnover, 2.2209);
});

test('自洽性：净买入 = 买入额 - 卖出额', () => {
  for (const row of [REAL_ROW, OLD_ROW]) {
    const d = parseLhbRow(row);
    assert.ok(
      Math.abs(d.netAmount - (d.buyAmount - d.sellAmount)) < 1,
      `净额 ${d.netAmount} 应等于买入 ${d.buyAmount} - 卖出 ${d.sellAmount}`
    );
  }
});

test('自洽性：榜单成交额不超过当日全市场成交额', () => {
  const d = parseLhbRow(REAL_ROW);
  assert.ok(d.totalAmount > d.buyAmount, '当日成交额应大于榜单买入额');
});

test('parseLhbRow：最新一条的上榜后表现为 null（还没走完）', () => {
  const d = parseLhbRow(REAL_ROW);
  assert.equal(d.after1d, null);
  assert.equal(d.after5d, null);
});

test('parseLhbRow：历史记录的上榜后表现有值', () => {
  const d = parseLhbRow(OLD_ROW);
  assert.equal(d.after1d, 0.1514769);
  assert.equal(d.after5d, -2.19641505);
});

test('parseLhbRow：日期缺失返回 null', () => {
  assert.equal(parseLhbRow({ SECURITY_CODE: '002913' }), null);
  assert.equal(parseLhbRow(null), null);
});

// —— daysBetween ——

test('daysBetween：同日为 0，按本地时间算不串日', () => {
  const now = new Date(2026, 7, 10, 23, 30); // 2026-08-10 深夜
  assert.equal(daysBetween('2026-08-10', now), 0, '深夜也不该跨到次日');
  assert.equal(daysBetween('2026-08-09', now), 1);
  assert.equal(daysBetween('2026-07-11', now), 30);
});

test('daysBetween：非法日期返回 null', () => {
  const now = new Date(2026, 7, 10);
  for (const bad of ['', null, '2026-08', 'abc', '20260810']) {
    assert.equal(daysBetween(bad, now), null);
  }
});

// —— 汇总与新鲜度 ——
//
// 这是本模块最要紧的一块：茅台最近一次上榜是 2013 年，不区分新旧地展示
// 会让人以为刚上榜。isRecent 是 UI 决定摘要说不说话的依据。

test('buildLhb：按日期倒序，latest 取最新一条', () => {
  const r = buildLhb([OLD_ROW, REAL_ROW], 'sz002913', { now: new Date(2026, 7, 10) });
  assert.equal(r.items.length, 2);
  assert.equal(r.items[0].date, '2026-08-07', '最新在前');
  assert.equal(r.latest.date, '2026-08-07');
});

test('buildLhb：近期上榜 isRecent 为真', () => {
  const now = new Date(2026, 7, 10); // 距 08-07 三天
  const r = buildLhb([REAL_ROW], 'sz002913', { now });
  assert.equal(r.daysSince, 3);
  assert.equal(r.isRecent, true);
});

test('buildLhb：陈年记录 isRecent 为假——避免把 2013 年的当成刚上榜', () => {
  const now = new Date(2026, 7, 10);
  const r = buildLhb([OLD_ROW], 'sz002913', { now });
  assert.ok(r.daysSince > RECENT_DAYS, `距今 ${r.daysSince} 天应超过阈值`);
  assert.equal(r.isRecent, false);
  assert.equal(r.items.length, 1, '记录本身仍要返回，只是不算近期');
});

test('buildLhb：正好卡在阈值上算近期，超一天不算', () => {
  const now = new Date(2026, 7, 10);
  const onEdge = { ...REAL_ROW, TRADE_DATE: '2026-07-11 00:00:00' }; // 30 天前
  assert.equal(buildLhb([onEdge], 'x', { now }).isRecent, true, `${RECENT_DAYS} 天内算近期`);

  const overEdge = { ...REAL_ROW, TRADE_DATE: '2026-07-10 00:00:00' }; // 31 天前
  assert.equal(buildLhb([overEdge], 'x', { now }).isRecent, false);
});

test('buildLhb：从未上榜时 items 空、isRecent 假、daysSince 为 null', () => {
  for (const empty of [[], null, undefined]) {
    const r = buildLhb(empty, 'sh510300', { now: new Date(2026, 7, 10) });
    assert.deepEqual(r.items, []);
    assert.equal(r.latest, null);
    assert.equal(r.isRecent, false);
    assert.equal(r.daysSince, null);
  }
});

test('buildLhb：total 用接口给的历史总次数', () => {
  const r = buildLhb([REAL_ROW], 'sz002913', { now: new Date(2026, 7, 10), total: 26 });
  assert.equal(r.total, 26, '可能远大于本次取回的条数');
  assert.equal(r.items.length, 1);
});

// —— 请求参数 ——

function spyFetch(box, rows = [REAL_ROW]) {
  return async (url) => {
    box.url = url;
    return {
      ok: true,
      status: 200,
      arrayBuffer: async () =>
        Buffer.from(JSON.stringify({ result: { data: rows, pages: 13, count: rows.length }, success: true }), 'utf8'),
    };
  };
}

test('fetchLhb：用 SECUCODE 过滤，不用 6 位 SECURITY_CODE', async () => {
  // SECURITY_CODE='000001' 会命中深市平安银行；沪市指数就被张冠李戴了
  const box = {};
  await fetchLhb('sz002913', {}, { fetchImpl: spyFetch(box) });
  const url = decodeURIComponent(box.url);
  assert.match(url, /SECUCODE="002913\.SZ"/);
  assert.ok(!/\(SECURITY_CODE=/.test(url), '不该用 SECURITY_CODE 过滤');
  assert.match(box.url, new RegExp(`reportName=${REPORT_NAME}`));
});

test('fetchLhb：同数字沪深两市产出不同的过滤条件', async () => {
  const a = {};
  await fetchLhb('sh000001', {}, { fetchImpl: spyFetch(a) });
  const b = {};
  await fetchLhb('sz000001', {}, { fetchImpl: spyFetch(b) });
  assert.match(decodeURIComponent(a.url), /SECUCODE="000001\.SH"/);
  assert.match(decodeURIComponent(b.url), /SECUCODE="000001\.SZ"/);
  assert.notEqual(a.url, b.url, '沪深必须分得开');
});

test('fetchLhb：limit 封顶，非法值回落到默认 5', async () => {
  const box = {};
  await fetchLhb('sz002913', { limit: 9999 }, { fetchImpl: spyFetch(box) });
  assert.match(box.url, new RegExp(`pageSize=${MAX_LIMIT}(&|$)`));

  for (const bad of [undefined, 0, -1, 'x']) {
    const b = {};
    await fetchLhb('sz002913', { limit: bad }, { fetchImpl: spyFetch(b) });
    assert.match(b.url, /pageSize=5(&|$)/, `limit=${bad} 应回落到 5`);
  }
});

test('fetchLhb：ETF 返回 9201 时给空结果而不抛错', async () => {
  // 实测 510300 返回「返回数据为空」——ETF 不上龙虎榜
  const spy = async () => ({
    ok: true,
    status: 200,
    arrayBuffer: async () =>
      Buffer.from(JSON.stringify({ result: null, success: false, message: '返回数据为空', code: 9201 }), 'utf8'),
  });
  const r = await fetchLhb('sh510300', {}, { fetchImpl: spy });
  assert.deepEqual(r.items, []);
  assert.equal(r.isRecent, false);
});

test('fetchLhb：非法代码抛错，不发请求', async () => {
  let called = false;
  const spy = async () => {
    called = true;
  };
  await assert.rejects(() => fetchLhb('abc', {}, { fetchImpl: spy }), /无法识别的代码/);
  assert.equal(called, false);
});
