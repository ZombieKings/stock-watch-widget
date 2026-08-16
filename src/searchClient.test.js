'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { parseSuggest, searchStocks, SEARCH_TYPES } = require('./searchClient');

/** 真实抓取的新浪 suggest 响应（关键词「银行」，已转为 UTF-8） */
const REAL = `var suggestvalue="工商银行,11,601398,sh601398,工商银行,,工商银行,99,1,ESG,,;平安银行,11,000001,sz000001,平安银行,,平安银行,99,1,ESG,,;中证银行,11,399986,sz399986,中证银行,,中证银行,99,1,,,";`;

test('解析 suggest，取出代码与中文名', () => {
  const items = parseSuggest(REAL);
  assert.equal(items.length, 2); // 中证银行(399986)是指数，被剔除
  assert.deepEqual(items[0], {
    code: 'sh601398',
    digits: '601398',
    name: '工商银行',
    exchange: 'sh',
    exchangeLabel: '沪',
    kind: 'stock',
    kindLabel: '', // 股票不打标
    isFund: false,
  });
  assert.equal(items[1].code, 'sz000001');
  assert.equal(items[1].exchangeLabel, '深');
  // sz000001 是平安银行，不能因为 000xxx 就被当成指数剔掉
  assert.equal(items[1].kind, 'stock');
});

test('剔除指数：深 399xxx 与沪 000xxx', () => {
  const raw = `var suggestvalue="上证指数,11,000001,sh000001,上证指数,,上证指数,99,1,,,;深证成指,11,399001,sz399001,深证成指,,深证成指,99,1,,,";`;
  assert.deepEqual(parseSuggest(raw), []);
});

test('搜代码时名称位是代码本身 → 该条被跳过', () => {
  // 实测：搜 000858 时新浪返回 "sz000858,11,000858,sz000858,五粮液,..."
  // 第一段是代码，第五段才是名称；名称为代码形态的条目无意义
  const raw = `var suggestvalue="sz000858,11,000858,sz000858,五粮液,,五粮液,99,1,ESG,,;sh000858,11,000858,sh000858,sh000858,,x,99,1,,,";`;
  const items = parseSuggest(raw);
  assert.equal(items.length, 1);
  assert.equal(items[0].name, '五粮液');
  assert.equal(items[0].code, 'sz000858');
});

test('未收录的类型码被过滤（只接受 11 与 203）', () => {
  // type=12 是场外基金份额口径，不能交易，剔除
  const raw = `var suggestvalue="某基金,12,160123,sz160123,某基金,,某基金,99,1,,,";`;
  assert.deepEqual(parseSuggest(raw), []);
});

// —— 场内基金（type=203）——
//
// 实测：type=11 搜 510300 返回 0 条，ETF 完全不在 A 股类型里，必须显式请求 203。
// 同一支基金新浪会返回两条，type=22/201 的 full 是 `of510300`（场外口径），
// 只有 type=203 的 full 是 `sh510300`（场内代码）。

test('解析 type=203 场内基金', () => {
  const raw = `var suggestvalue="沪深300ETF华泰柏瑞,203,510300,sh510300,沪深300ETF华泰柏瑞,,x,99,1,,,";`;
  const items = parseSuggest(raw);
  assert.equal(items.length, 1);
  assert.deepEqual(items[0], {
    code: 'sh510300',
    digits: '510300',
    name: '沪深300ETF华泰柏瑞',
    exchange: 'sh',
    exchangeLabel: '沪',
    kind: 'fund',
    kindLabel: '基金',
    isFund: true,
  });
});

test('场外份额口径（of 前缀）被剔除，只留场内代码', () => {
  // 实测搜 510300 的原始返回：22/201 给 of510300，203 给 sh510300
  const raw =
    `var suggestvalue="沪深300ETF华泰柏瑞,22,510300,of510300,沪深300ETF华泰柏瑞,,x,99,1,,,;` +
    `沪深300ETF华泰柏瑞,203,510300,sh510300,沪深300ETF华泰柏瑞,,x,99,1,,,";`;
  const items = parseSuggest(raw);
  assert.equal(items.length, 1);
  assert.equal(items[0].code, 'sh510300');
});

test('股票与基金能同时出现在一次结果里', () => {
  const raw =
    `var suggestvalue="中证白酒,11,399997,sz399997,中证白酒,,x,99,1,,,;` +
    `白酒基金LOF,203,161725,sz161725,白酒基金LOF,,x,99,1,,,;` +
    `贵州茅台,11,600519,sh600519,贵州茅台,,x,99,1,,,";`;
  const items = parseSuggest(raw);
  // 中证白酒(sz399997)是指数被剔除，剩 LOF 与茅台
  assert.equal(items.length, 2);
  assert.equal(items[0].code, 'sz161725');
  assert.equal(items[0].isFund, true);
  assert.equal(items[1].code, 'sh600519');
  assert.equal(items[1].isFund, false);
});

test('深市 ETF / LOF / 封闭式都能识别', () => {
  const raw =
    `var suggestvalue="创业板ETF易方达,203,159915,sz159915,创业板ETF易方达,,x,99,1,,,;` +
    `白酒基金LOF,203,161725,sz161725,白酒基金LOF,,x,99,1,,,;` +
    `科创50ETF华夏,203,588000,sh588000,科创50ETF华夏,,x,99,1,,,;` +
    `货币ETF,203,511990,sh511990,华宝添益ETF,,x,99,1,,,";`;
  const items = parseSuggest(raw);
  assert.equal(items.length, 4);
  for (const it of items) {
    assert.equal(it.isFund, true, `${it.code} 应为基金`);
    assert.equal(it.kindLabel, '基金');
  }
});

test('指数即使标成 203 也剔除（不可交易）', () => {
  const raw = `var suggestvalue="沪深300,203,000300,sh000300,沪深300,,x,99,1,,,";`;
  assert.deepEqual(parseSuggest(raw), []);
});

test('响应异常或为空时返回空数组', () => {
  assert.deepEqual(parseSuggest(''), []);
  assert.deepEqual(parseSuggest(null), []);
  assert.deepEqual(parseSuggest('var suggestvalue="";'), []);
  assert.deepEqual(parseSuggest('unexpected format'), []);
});

test('重复代码去重', () => {
  const raw = `var suggestvalue="工商银行,11,601398,sh601398,工商银行,,x,99,1,,,;工商银行,11,601398,sh601398,工商银行,,x,99,1,,,";`;
  assert.equal(parseSuggest(raw).length, 1);
});

test('残缺字段的条目被跳过而不是产出 undefined', () => {
  const raw = `var suggestvalue="短,11,601;工商银行,11,601398,sh601398,工商银行,,x,99,1,,,";`;
  const items = parseSuggest(raw);
  assert.equal(items.length, 1);
  assert.equal(items[0].name, '工商银行');
});

function fakeFetch(body, calls = []) {
  return async (url) => {
    calls.push(url);
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      arrayBuffer: async () => (Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8')),
    };
  };
}

test('searchStocks 空关键词不发请求', async () => {
  const calls = [];
  assert.deepEqual(await searchStocks('', { fetchImpl: fakeFetch(REAL, calls) }), []);
  assert.deepEqual(await searchStocks('   ', { fetchImpl: fakeFetch(REAL, calls) }), []);
  assert.equal(calls.length, 0);
});

test('searchStocks 关键词做 URL 编码', async () => {
  const calls = [];
  await searchStocks('茅台', { fetchImpl: fakeFetch(REAL, calls) });
  assert.ok(calls[0].includes(encodeURIComponent('茅台')));
  assert.ok(calls[0].includes('type=11'));
});

test('searchStocks 请求里必须带上基金类型 203', async () => {
  // 漏掉 203 的话搜 ETF 代码会一条都搜不到（type=11 对 510300 返回 0 条）
  const calls = [];
  await searchStocks('510300', { fetchImpl: fakeFetch(REAL, calls) });
  assert.ok(calls[0].includes(`type=${SEARCH_TYPES}`), `实际 URL: ${calls[0]}`);
  assert.ok(SEARCH_TYPES.split(',').includes('203'));
  assert.ok(SEARCH_TYPES.split(',').includes('11'));
});

test('searchStocks 按 limit 截断', async () => {
  const items = await searchStocks('银行', { fetchImpl: fakeFetch(REAL), limit: 1 });
  assert.equal(items.length, 1);
});

test('searchStocks 解码 GBK 响应', async () => {
  // '工商银行' 的 GBK 字节
  const name = Buffer.from('b9a4c9ccd2f8d0d0', 'hex');
  const body = Buffer.concat([
    Buffer.from('var suggestvalue="', 'latin1'),
    name,
    Buffer.from(',11,601398,sh601398,', 'latin1'),
    name,
    Buffer.from(',,x,99,1,ESG,,";', 'latin1'),
  ]);
  const items = await searchStocks('银行', { fetchImpl: fakeFetch(body) });
  assert.equal(items.length, 1);
  assert.equal(items[0].name, '工商银行');
});
