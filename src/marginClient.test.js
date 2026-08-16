'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { parseMarginRow, buildMargin, fetchMargin, REPORT_NAME, MAX_DAYS } = require('./marginClient');

/**
 * 贵州茅台 2026-08-07 / 08-06 的真实报表行，原样抄录（只删掉与本模块无关的段）。
 * 下面「余额恒为正」「净买入=买入-偿还」两条自洽性断言依赖数据真实。
 */
const REAL_ROWS = [
  {
    DATE: '2026-08-07 00:00:00',
    MARKET: '融资融券_沪证',
    SCODE: '600519',
    SECNAME: '贵州茅台',
    RZYE: 17544302364,
    RQYL: 99678,
    RZRQYE: 17674802795.16,
    RQYE: 130500431.16,
    RQMCL: 1100,
    RZMRE: 333336970,
    SZ: 1636631833661.22,
    RZYEZB: 1.07197612,
    RZCHE: 315673035,
    RZJME: 17663935,
    RZJME5D: 131725962,
    SPJ: 1309.22,
    ZDF: 0.0512,
    SECUCODE: '600519.SH',
  },
  {
    DATE: '2026-08-06 00:00:00',
    MARKET: '融资融券_沪证',
    SCODE: '600519',
    SECNAME: '贵州茅台',
    RZYE: 17526638429,
    RQYL: 102778,
    RZRQYE: 17661128580.9,
    RQYE: 134490151.9,
    RZMRE: 292531572,
    SZ: 1635794278988.55,
    RZYEZB: 1.0714,
    RZCHE: 280000000,
    RZJME: 12531572,
    SPJ: 1308.55,
    ZDF: 0.16,
    SECUCODE: '600519.SH',
  },
];

// —— 单行解析 ——

test('parseMarginRow：字段名对得上', () => {
  const d = parseMarginRow(REAL_ROWS[0]);
  assert.equal(d.date, '2026-08-07', '截掉 00:00:00');
  assert.equal(d.name, '贵州茅台');
  assert.equal(d.finBalance, 17544302364, 'RZYE 融资余额');
  assert.equal(d.shortBalance, 130500431.16, 'RQYE 融券余额');
  assert.equal(d.totalBalance, 17674802795.16, 'RZRQYE 两融合计');
  assert.equal(d.finBuy, 333336970, 'RZMRE 融资买入额');
  assert.equal(d.finRepay, 315673035, 'RZCHE 融资偿还额');
  assert.equal(d.finNet, 17663935, 'RZJME 融资净买入');
  assert.equal(d.shortVolume, 99678, 'RQYL 融券余量');
  assert.equal(d.finBalanceRatio, 1.07197612, 'RZYEZB 占流通市值%');
  assert.equal(d.close, 1309.22);
});

test('自洽性：融资净买入 = 买入 - 偿还', () => {
  // 接口直接给 RZJME，这里核对它与买入/偿还的关系确实成立 ——
  // 若哪天口径变了，这条会先炸出来
  const d = parseMarginRow(REAL_ROWS[0]);
  assert.ok(
    Math.abs(d.finNet - (d.finBuy - d.finRepay)) < 1,
    `净买入 ${d.finNet} 应等于买入 ${d.finBuy} - 偿还 ${d.finRepay}`
  );
});

test('自洽性：两融合计 = 融资余额 + 融券余额', () => {
  const d = parseMarginRow(REAL_ROWS[0]);
  assert.ok(
    Math.abs(d.totalBalance - (d.finBalance + d.shortBalance)) < 1,
    '两融合计应等于融资余额加融券余额'
  );
});

test('自洽性：余额类字段恒为正（存量不会是负数）', () => {
  // 渲染层据此不给余额上涨跌色；若接口真出现负值，说明口径变了
  for (const row of REAL_ROWS) {
    const d = parseMarginRow(row);
    assert.ok(d.finBalance > 0, '融资余额应为正');
    assert.ok(d.shortBalance > 0, '融券余额应为正');
    assert.ok(d.totalBalance > 0, '两融合计应为正');
  }
});

test('parseMarginRow：日期缺失返回 null', () => {
  assert.equal(parseMarginRow({ SCODE: '600519' }), null);
  assert.equal(parseMarginRow(null), null);
  assert.equal(parseMarginRow('x'), null);
});

test('parseMarginRow：ETF 的 SZ 与 RZYEZB 为 null，不产出 NaN', () => {
  // 实测 510300 是两融标的，但流通市值与余额占比为 null
  const d = parseMarginRow({ DATE: '2026-08-07 00:00:00', SCODE: '510300', SECNAME: '300ETF', RZYE: 2808681697, SZ: null, RZYEZB: null });
  assert.equal(d.finBalance, 2808681697);
  assert.equal(d.finBalanceRatio, null, 'null 要保持 null，不能变成 0 或 NaN');
});

// —— 汇总 ——

test('buildMargin：接口倒序给，输出转成升序（末项最新）', () => {
  const r = buildMargin(REAL_ROWS, 'sh600519');
  assert.equal(r.days.length, 2);
  assert.equal(r.days[0].date, '2026-08-06', '首项应是较早的一天');
  assert.equal(r.days[1].date, '2026-08-07');
  assert.equal(r.latest.date, '2026-08-07', 'latest 取末项');
});

test('buildMargin：升序与 flowClient 一致，渲染层才能共用画柱逻辑', () => {
  const r = buildMargin(REAL_ROWS, 'sh600519');
  for (let i = 1; i < r.days.length; i += 1) {
    assert.ok(r.days[i - 1].date < r.days[i].date, '必须严格升序');
  }
});

test('buildMargin：finNetSum 累计净买入，跳过 null 而不当 0', () => {
  const r = buildMargin(REAL_ROWS, 'sh600519');
  assert.equal(r.finNetSum, 17663935 + 12531572);

  // 缺数据的那天要跳过，不能被算成「没变化」
  const withNull = buildMargin(
    [{ DATE: '2026-08-05 00:00:00', RZJME: null }, ...REAL_ROWS],
    'sh600519'
  );
  assert.equal(withNull.finNetSum, 17663935 + 12531572, 'null 不参与累加');
});

test('buildMargin：空行（非两融标的）给空 days 且 latest 为 null', () => {
  for (const empty of [[], null, undefined]) {
    const r = buildMargin(empty, 'sz002913');
    assert.deepEqual(r.days, []);
    assert.equal(r.latest, null);
    assert.equal(r.finNetSum, 0);
  }
});

// —— 请求参数 ——

function spyFetch(box, rows = REAL_ROWS) {
  return async (url) => {
    box.url = url;
    return {
      ok: true,
      status: 200,
      arrayBuffer: async () =>
        Buffer.from(JSON.stringify({ result: { data: rows, pages: 1, count: rows.length }, success: true }), 'utf8'),
    };
  };
}

test('fetchMargin：用 SECUCODE 过滤，不用 6 位 SCODE', async () => {
  // SCODE='000001' 会命中深市平安银行，沪市指数就被张冠李戴了
  const box = {};
  await fetchMargin('sh600519', {}, { fetchImpl: spyFetch(box) });
  const url = decodeURIComponent(box.url);
  assert.match(url, /SECUCODE="600519\.SH"/);
  assert.ok(!/\(SCODE=/.test(url), '不该用 SCODE 过滤');
});

test('fetchMargin：报表名是 RPTA_WEB_RZRQ_GGMX', async () => {
  // 网上常见的 RPT_MARGIN_DAILYDETAIL 已失效（返回 9501 报表配置不存在）
  assert.equal(REPORT_NAME, 'RPTA_WEB_RZRQ_GGMX');
  const box = {};
  await fetchMargin('sh600519', {}, { fetchImpl: spyFetch(box) });
  assert.match(box.url, /reportName=RPTA_WEB_RZRQ_GGMX/);
});

test('fetchMargin：沪深 SECUCODE 后缀跟着交易所变', async () => {
  const box = {};
  await fetchMargin('sz000858', {}, { fetchImpl: spyFetch(box) });
  assert.match(decodeURIComponent(box.url), /SECUCODE="000858\.SZ"/);
});

test('fetchMargin：days 封顶到 MAX_DAYS，非法值回落到默认', async () => {
  const box = {};
  await fetchMargin('sh600519', { days: 9999 }, { fetchImpl: spyFetch(box) });
  assert.match(box.url, new RegExp(`pageSize=${MAX_DAYS}(&|$)`));

  for (const bad of [undefined, 0, -3, 'abc']) {
    const b = {};
    await fetchMargin('sh600519', { days: bad }, { fetchImpl: spyFetch(b) });
    assert.match(b.url, /pageSize=5(&|$)/, `days=${bad} 应回落到默认 5`);
  }
});

test('fetchMargin：非两融标的（返回 9201）给空 days 而不抛错', async () => {
  const spy = async () => ({
    ok: true,
    status: 200,
    arrayBuffer: async () =>
      Buffer.from(JSON.stringify({ result: null, success: false, message: '返回数据为空', code: 9201 }), 'utf8'),
  });
  const r = await fetchMargin('sz002913', {}, { fetchImpl: spy });
  assert.deepEqual(r.days, []);
  assert.equal(r.latest, null);
});

test('fetchMargin：非法代码抛错，不发请求', async () => {
  let called = false;
  const spy = async () => {
    called = true;
  };
  await assert.rejects(() => fetchMargin('abc', {}, { fetchImpl: spy }), /无法识别的代码/);
  assert.equal(called, false);
});
