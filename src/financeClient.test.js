'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { parseFinanceRow, buildFinance, fetchFinance, REPORT_NAME, MAX_PERIODS } = require('./financeClient');

/**
 * 贵州茅台 2026 一季报 / 2025 年报的真实报表行，抄录本模块用到的字段
 * （原始响应有 100+ 段，含大量银行/保险专有的 null 字段）。
 */
const REAL_ROWS = [
  {
    SECUCODE: '600519.SH',
    SECURITY_CODE: '600519',
    SECURITY_NAME_ABBR: '贵州茅台',
    REPORT_DATE: '2026-03-31 00:00:00',
    REPORT_TYPE: '一季报',
    REPORT_DATE_NAME: '2026一季报',
    NOTICE_DATE: '2026-04-25 00:00:00',
    CURRENCY: 'CNY',
    EPSJB: 21.76,
    EPSKCJB: null,
    BPS: 216.32234994607,
    MGJYXJJE: 21.488885503142,
    TOTALOPERATEREVE: 54702912385.23,
    PARENTNETPROFIT: 27242512886.45,
    KCFJCXSYJLR: 27239985194.41,
    TOTALOPERATEREVETZ: 6.336009277123,
    PARENTNETPROFITTZ: 1.471418294983,
    ROEJQ: 10.57,
    ROEKCJQ: null,
    XSJLL: 52.2244889889,
    XSMLL: 89.7592176242,
    ZCFZL: 12.1227489682,
  },
  {
    SECUCODE: '600519.SH',
    REPORT_DATE: '2025-12-31 00:00:00',
    REPORT_TYPE: '年报',
    REPORT_DATE_NAME: '2025年报',
    NOTICE_DATE: '2026-03-28 00:00:00',
    CURRENCY: 'CNY',
    EPSJB: 65.66,
    BPS: 195.355449727901,
    ROEJQ: 32.53,
    XSMLL: 91.2,
    XSJLL: 50.1,
    ZCFZL: 15.4,
    TOTALOPERATEREVE: 164000000000,
    PARENTNETPROFIT: 82000000000,
  },
];

// —— 单期解析 ——

test('parseFinanceRow：字段名对得上', () => {
  const d = parseFinanceRow(REAL_ROWS[0]);
  assert.equal(d.reportDate, '2026-03-31', '截掉 00:00:00');
  assert.equal(d.reportName, '2026一季报', '接口直接给中文，UI 原样展示');
  assert.equal(d.reportType, '一季报');
  assert.equal(d.noticeDate, '2026-04-25');
  assert.equal(d.eps, 21.76, 'EPSJB');
  assert.equal(d.bps, 216.32234994607, 'BPS');
  assert.equal(d.roe, 10.57, 'ROEJQ 加权净资产收益率');
  assert.equal(d.grossMargin, 89.7592176242, 'XSMLL 毛利率');
  assert.equal(d.netMargin, 52.2244889889, 'XSJLL 净利率');
  assert.equal(d.debtRatio, 12.1227489682, 'ZCFZL 资产负债率');
  assert.equal(d.revenue, 54702912385.23, 'TOTALOPERATEREVE');
  assert.equal(d.netProfit, 27242512886.45, 'PARENTNETPROFIT');
  assert.equal(d.netProfitExcl, 27239985194.41, 'KCFJCXSYJLR 扣非');
  assert.equal(d.revenueYoy, 6.336009277123);
  assert.equal(d.netProfitYoy, 1.471418294983);
});

test('自洽性：净利率 ≈ 归母净利润 / 营收（口径接近，允许偏差）', () => {
  // 净利率分子是「净利润」含少数股东权益，与归母净利润略有差，
  // 但差不了几个百分点 —— 差太多说明字段对错了
  const d = parseFinanceRow(REAL_ROWS[0]);
  const rough = (d.netProfit / d.revenue) * 100;
  assert.ok(Math.abs(rough - d.netMargin) < 5, `粗算 ${rough.toFixed(2)} 与 XSJLL ${d.netMargin} 应接近`);
});

test('自洽性：毛利率高于净利率（毛利必然大于净利）', () => {
  for (const row of REAL_ROWS) {
    const d = parseFinanceRow(row);
    assert.ok(d.grossMargin > d.netMargin, '毛利率应高于净利率');
  }
});

test('parseFinanceRow：扣非 EPS 常为 null，保持 null 不产出 NaN', () => {
  // 实测即使茅台这种大盘股，EPSKCJB 与 ROEKCJQ 也是 null
  const d = parseFinanceRow(REAL_ROWS[0]);
  assert.equal(REAL_ROWS[0].EPSKCJB, null, '接口给的就是 null');
  // 本模块不解析它，改用扣非净利润
  assert.equal(d.netProfitExcl, 27239985194.41);
});

test('parseFinanceRow：报告期缺失返回 null', () => {
  assert.equal(parseFinanceRow({ SECUCODE: '600519.SH' }), null);
  assert.equal(parseFinanceRow(null), null);
  assert.equal(parseFinanceRow(42), null);
});

test('parseFinanceRow：缺失字段为 null，不影响其它字段', () => {
  const d = parseFinanceRow({ REPORT_DATE: '2026-03-31 00:00:00', EPSJB: 1.5 });
  assert.equal(d.eps, 1.5);
  assert.equal(d.roe, null);
  assert.equal(d.revenue, null);
  assert.equal(d.currency, 'CNY', '缺失时回落到 CNY');
});

// —— 汇总 ——

test('buildFinance：按报告期倒序（最新在前）', () => {
  // 与 marginClient 的升序相反：财务是「看最近一期，往前对照」
  const r = buildFinance(REAL_ROWS, 'sh600519');
  assert.equal(r.periods.length, 2);
  assert.equal(r.periods[0].reportDate, '2026-03-31', '最新在前');
  assert.equal(r.periods[1].reportDate, '2025-12-31');
  assert.equal(r.latest.reportName, '2026一季报');
});

test('buildFinance：不假定接口一定按 sortTypes 给，自己排一遍', () => {
  const reversed = [...REAL_ROWS].reverse();
  const r = buildFinance(reversed, 'sh600519');
  assert.equal(r.periods[0].reportDate, '2026-03-31');
});

test('buildFinance：空行给空 periods 且 latest 为 null', () => {
  for (const empty of [[], null, undefined]) {
    const r = buildFinance(empty, 'sh510300');
    assert.deepEqual(r.periods, []);
    assert.equal(r.latest, null);
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
        Buffer.from(JSON.stringify({ result: { data: rows, pages: 51 }, success: true }), 'utf8'),
    };
  };
}

test('fetchFinance：走 F10 域且 source=HSF10、client=PC', async () => {
  // 给 WEB/WEB 拿不到数据；域名也与 datacenter-web 不是同一套
  const box = {};
  await fetchFinance('sh600519', {}, { fetchImpl: spyFetch(box) });
  assert.match(box.url, /datacenter\.eastmoney\.com\/securities\/api/);
  assert.match(box.url, /source=HSF10/);
  assert.match(box.url, /client=PC/);
  assert.match(box.url, new RegExp(`reportName=${REPORT_NAME}`));
});

test('fetchFinance：用 SECUCODE 过滤', async () => {
  const box = {};
  await fetchFinance('sh600519', {}, { fetchImpl: spyFetch(box) });
  assert.match(decodeURIComponent(box.url), /SECUCODE="600519\.SH"/);
});

test('fetchFinance：periods 封顶，非法值回落到默认 4', async () => {
  const box = {};
  await fetchFinance('sh600519', { periods: 9999 }, { fetchImpl: spyFetch(box) });
  assert.match(box.url, new RegExp(`pageSize=${MAX_PERIODS}(&|$)`));

  for (const bad of [undefined, 0, -1, 'x']) {
    const b = {};
    await fetchFinance('sh600519', { periods: bad }, { fetchImpl: spyFetch(b) });
    assert.match(b.url, /pageSize=4(&|$)/, `periods=${bad} 应回落到 4`);
  }
});

test('fetchFinance：ETF 与指数返回 9201 时给空结果而不抛错', async () => {
  // 实测 510300.SH 与 000001.SH 都返回「返回数据为空」
  const spy = async () => ({
    ok: true,
    status: 200,
    arrayBuffer: async () =>
      Buffer.from(JSON.stringify({ result: null, success: false, message: '返回数据为空', code: 9201 }), 'utf8'),
  });
  const r = await fetchFinance('sh510300', {}, { fetchImpl: spy });
  assert.deepEqual(r.periods, []);
  assert.equal(r.latest, null);
});

test('fetchFinance：非法代码抛错，不发请求', async () => {
  let called = false;
  const spy = async () => {
    called = true;
  };
  await assert.rejects(() => fetchFinance('xyz', {}, { fetchImpl: spy }), /无法识别的代码/);
  assert.equal(called, false);
});
