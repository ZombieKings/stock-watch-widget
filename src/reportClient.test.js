'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const {
  parseReportItem,
  buildReports,
  summarizeRatings,
  fetchReports,
  MAX_LIMIT,
} = require('./reportClient');

/** 贵州茅台的真实研报条目，抄录本模块用到的字段 */
const REAL_ITEM = {
  title: '需求根基稳固，市场化定价持续兑现',
  stockName: '贵州茅台',
  stockCode: '600519',
  orgCode: '80036717',
  orgName: '中邮证券有限责任公司',
  orgSName: '中邮证券',
  publishDate: '2026-07-23 00:00:00.000',
  infoCode: 'AP202607231827290069',
  predictNextTwoYearEps: '73.96',
  predictNextTwoYearPe: '17.65',
  predictNextYearEps: '69.76',
  predictNextYearPe: '18.71',
  predictThisYearEps: '67.19',
  predictThisYearPe: '19.42',
  predictLastYearEps: '',
  indvInduName: '白酒Ⅱ',
  emRatingName: '买入',
  sRatingName: '买入',
  ratingChange: 3,
  author: ['11000214820.蔡雪昱', '11000439031.张子健'],
  researcher: '蔡雪昱,张子健',
  attachPages: 5,
  market: 'SHANGHAI',
};

// —— 单条解析 ——

test('parseReportItem：字段名对得上', () => {
  const r = parseReportItem(REAL_ITEM);
  assert.equal(r.title, '需求根基稳固，市场化定价持续兑现');
  assert.equal(r.org, '中邮证券', '用简称，全称在 UI 里放不下');
  assert.equal(r.researcher, '蔡雪昱,张子健', 'researcher 已是纯姓名，不必解析 author 数组');
  assert.equal(r.date, '2026-07-23', '截掉时间部分');
  assert.equal(r.rating, '买入', 'emRatingName 东财统一口径');
  assert.equal(r.ratingRaw, '买入', 'sRatingName 券商原文');
  assert.equal(r.industry, '白酒Ⅱ');
  assert.equal(r.pages, 5);
});

test('parseReportItem：预测值是字符串，要转成数字', () => {
  const r = parseReportItem(REAL_ITEM);
  assert.equal(r.epsThisYear, 67.19);
  assert.equal(r.peThisYear, 19.42);
  assert.equal(r.epsNextYear, 69.76);
  assert.equal(r.peNextYear, 18.71);
  // 类型也要对：字符串 '19.42' 直接进 toFixed 会炸
  assert.equal(typeof r.peThisYear, 'number');
});

test('parseReportItem：空串预测值为 null 而不是 0', () => {
  // 0 会让 UI 显示「预测PE 0.0」，看着像真的极度低估
  const r = parseReportItem({ ...REAL_ITEM, predictThisYearPe: '', predictThisYearEps: '' });
  assert.equal(r.peThisYear, null);
  assert.equal(r.epsThisYear, null);
});

test('parseReportItem：详情页 URL 由 infoCode 拼出', () => {
  const r = parseReportItem(REAL_ITEM);
  assert.match(r.url, /zw_stock\.jshtml\?infocode=AP202607231827290069/);
});

test('parseReportItem：无 infoCode 时 url 为空串（UI 据此不给点击态）', () => {
  const r = parseReportItem({ ...REAL_ITEM, infoCode: '' });
  assert.equal(r.url, '');
});

test('parseReportItem：无标题返回 null', () => {
  assert.equal(parseReportItem({ ...REAL_ITEM, title: '' }), null);
  assert.equal(parseReportItem({ ...REAL_ITEM, title: '   ' }), null);
  assert.equal(parseReportItem(null), null);
});

// —— 评级汇总 ——

test('summarizeRatings：计数并按次数降序', () => {
  const items = [
    { rating: '买入' },
    { rating: '增持' },
    { rating: '买入' },
    { rating: '买入' },
    { rating: '中性' },
  ];
  const s = summarizeRatings(items);
  assert.deepEqual(s.counts, [['买入', 3], ['增持', 1], ['中性', 1]]);
  assert.equal(s.top, '买入');
  assert.equal(s.total, 5);
});

test('summarizeRatings：跳过无评级的条目', () => {
  const s = summarizeRatings([{ rating: '买入' }, { rating: '' }, { rating: null }]);
  assert.equal(s.total, 1, '只统计有评级的');
  assert.deepEqual(s.counts, [['买入', 1]]);
});

test('summarizeRatings：空输入给空结果，top 为空串', () => {
  const s = summarizeRatings([]);
  assert.deepEqual(s.counts, []);
  assert.equal(s.top, '');
  assert.equal(s.total, 0);
});

test('summarizeRatings：只做计数，不产出加权平均分', () => {
  // 各家评级口径不完全可比，算平均分会显得比实际更精确
  const s = summarizeRatings([{ rating: '买入' }, { rating: '中性' }]);
  assert.equal(s.score, undefined, '不该有 score 字段');
  assert.ok(Array.isArray(s.counts), '只给原始分布');
});

// —— 整份响应 ——

test('buildReports：解析真实响应形状（顶层就是 data，无 result 包装）', () => {
  const r = buildReports({ hits: 114, size: 1, data: [REAL_ITEM] }, '600519');
  assert.equal(r.digits, '600519');
  assert.equal(r.items.length, 1);
  assert.equal(r.total, 114, 'hits 是命中总数，可能远大于 items.length');
  assert.equal(r.summary.top, '买入');
});

test('buildReports：hits=0（ETF、不存在的代码）给空列表而不抛错', () => {
  // 实测 510300 与 999999 都返回 { hits: 0, data: [] }
  const r = buildReports({ hits: 0, size: 0, data: [] }, '510300');
  assert.deepEqual(r.items, []);
  assert.equal(r.total, 0);
  assert.equal(r.summary.top, '');
});

test('buildReports：data 不是数组时给空列表', () => {
  for (const bad of [{}, { data: null }, null, undefined]) {
    assert.deepEqual(buildReports(bad, '600519').items, []);
  }
});

// —— 请求参数 ——

function spyFetch(box, payload = { hits: 1, data: [REAL_ITEM] }) {
  return async (url) => {
    box.url = url;
    return {
      ok: true,
      status: 200,
      arrayBuffer: async () => Buffer.from(JSON.stringify(payload), 'utf8'),
    };
  };
}

test('fetchReports：qType=0 取个股研报，code 是 6 位数字', async () => {
  const box = {};
  await fetchReports('600519', {}, { fetchImpl: spyFetch(box) });
  assert.match(box.url, /reportapi\.eastmoney\.com/);
  assert.match(box.url, /qType=0/);
  assert.match(box.url, /code=600519/);
});

test('fetchReports：拒绝带前缀的代码——接口只吃 6 位数字', async () => {
  let called = false;
  const spy = async () => {
    called = true;
  };
  await assert.rejects(() => fetchReports('sh600519', {}, { fetchImpl: spy }), /需要 6 位代码/);
  assert.equal(called, false, '参数不对就不该发请求');
});

test('fetchReports：时间窗口按注入的 now 往前推两年', async () => {
  const box = {};
  const now = new Date(2026, 7, 10); // 2026-08-10
  await fetchReports('600519', { now }, { fetchImpl: spyFetch(box) });
  assert.match(box.url, /beginTime=2024-08-10/);
  assert.match(box.url, /endTime=2026-08-10/);
});

test('fetchReports：limit 封顶，非法值回落到默认 10', async () => {
  const box = {};
  await fetchReports('600519', { limit: 9999 }, { fetchImpl: spyFetch(box) });
  assert.match(box.url, new RegExp(`pageSize=${MAX_LIMIT}(&|$)`));

  for (const bad of [undefined, 0, -2, 'x']) {
    const b = {};
    await fetchReports('600519', { limit: bad }, { fetchImpl: spyFetch(b) });
    assert.match(b.url, /pageSize=10(&|$)/, `limit=${bad} 应回落到 10`);
  }
});
