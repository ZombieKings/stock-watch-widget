'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { parseBar, parseKlineResponse, fetchKline60, MAX_BARS, BARS_PER_DAY } = require('./emKlineClient');

/**
 * 贵州茅台 60 分钟 K 的真实响应片段，原样抄录。
 *
 * 这几行是接口返回的，没有一行是手写的 —— 下面「收在高低之前」「一天 4 根」
 * 两条断言只有在数据真实时才有意义，编造的行会让它们变成空转。
 */
const REAL_JSON = {
  rc: 0,
  rt: 17,
  svr: 177617926,
  lt: 1,
  full: 0,
  data: {
    code: '600519',
    market: 1,
    name: '贵州茅台',
    decimal: 2,
    dktotal: 5979,
    preKPrice: 1306.45,
    klines: [
      '2026-08-06 10:30,1310.00,1300.20,1314.40,1300.01,10112,1318696208.00,1.10,-0.48,-6.25,0.08',
      '2026-08-06 11:30,1300.30,1308.78,1309.58,1300.10,6015,784953966.00,0.73,0.66,8.58,0.05',
      '2026-08-06 14:00,1308.78,1307.34,1311.76,1305.26,3906,511168482.00,0.50,-0.11,-1.44,0.03',
      '2026-08-06 15:00,1307.42,1308.55,1314.00,1307.07,5440,712720695.00,0.53,0.09,1.21,0.04',
      '2026-08-07 10:30,1308.66,1303.49,1315.28,1301.00,10139,1325574844.00,1.09,-0.39,-5.06,0.08',
    ],
  },
};

// —— 单根解析 ——

test('parseBar：字段序是 [时间,开,收,高,低,量]——收在高低之前', () => {
  const b = parseBar(REAL_JSON.data.klines[0]);
  assert.equal(b.date, '2026-08-06 10:30');
  assert.equal(b.open, 1310.0);
  assert.equal(b.close, 1300.2, '第 3 段是收盘价，不是最高价');
  assert.equal(b.high, 1314.4);
  assert.equal(b.low, 1300.01);
  // 自洽性校验：真实数据里 high 必须是四者最大、low 最小
  assert.ok(b.high >= Math.max(b.open, b.close), 'high 应不低于开收');
  assert.ok(b.low <= Math.min(b.open, b.close), 'low 应不高于开收');
});

test('parseBar：量、额与涨跌幅一并解析', () => {
  const b = parseBar(REAL_JSON.data.klines[0]);
  assert.equal(b.volume, 10112);
  assert.equal(b.amount, 1318696208);
  assert.equal(b.amplitude, 1.1);
  assert.equal(b.changePct, -0.48);
  assert.equal(b.change, -6.25);
  assert.equal(b.turnover, 0.08);
});

test('parseBar：时间必须是 YYYY-MM-DD HH:MM，纯日期不收', () => {
  // 日 K 的行（无时间部分）混进来说明请求的 klt 不对，宁可丢弃也不当成 60 分钟根
  assert.equal(parseBar('2026-08-06,1310.00,1300.20,1314.40,1300.01,10112'), null);
  assert.equal(parseBar('汇总,1,2,3,4,5'), null);
  assert.equal(parseBar(''), null);
  assert.equal(parseBar(null), null);
});

test('parseBar：字段不足 6 段返回 null', () => {
  assert.equal(parseBar('2026-08-06 10:30,1310.00,1300.20'), null);
});

test('parseBar：价格缺失返回 null，不产出 NaN 根', () => {
  assert.equal(parseBar('2026-08-06 10:30,,1300.20,1314.40,1300.01,10112'), null);
  assert.equal(parseBar('2026-08-06 10:30,1310.00,-,1314.40,1300.01,10112'), null);
});

test('parseBar：量缺失记 0 而不是 null——画量柱时 null 会算出 NaN 高度', () => {
  const b = parseBar('2026-08-06 10:30,1310.00,1300.20,1314.40,1300.01,');
  assert.equal(b.volume, 0);
});

// —— 整份响应 ——

test('parseKlineResponse：解析真实响应，period 标为 60min', () => {
  const r = parseKlineResponse(REAL_JSON, 'sh600519');
  assert.equal(r.code, 'sh600519');
  assert.equal(r.period, '60min');
  assert.equal(r.fq, 'qfq');
  assert.equal(r.name, '贵州茅台');
  assert.equal(r.prevClose, 1306.45, 'preKPrice 是首根之前的收盘价');
  assert.equal(r.bars.length, 5);
});

test('一个交易日恰好 4 根：10:30 / 11:30 / 14:00 / 15:00', () => {
  const r = parseKlineResponse(REAL_JSON, 'sh600519');
  const day = r.bars.filter((b) => b.date.startsWith('2026-08-06'));
  assert.equal(day.length, BARS_PER_DAY);
  assert.deepEqual(
    day.map((b) => b.date.slice(11)),
    ['10:30', '11:30', '14:00', '15:00'],
    '午休不产生额外根，也没有盘后固定价交易的点要滤'
  );
});

test('parseKlineResponse：data 为 null（代码不存在）时给空 bars 而不抛错', () => {
  // 实测不存在的代码返回 rc=100 且 data=null
  const r = parseKlineResponse({ rc: 100, data: null }, 'sh999999');
  assert.deepEqual(r.bars, []);
  assert.equal(r.prevClose, null);
  assert.equal(r.period, '60min', '空结果也要带上周期，渲染层据此判断数据是否过期');
});

test('parseKlineResponse：klines 不是数组时给空 bars', () => {
  for (const bad of [{}, { data: {} }, { data: { klines: null } }, null, undefined]) {
    assert.deepEqual(parseKlineResponse(bad, 'sh600519').bars, []);
  }
});

test('parseKlineResponse：丢掉解析不了的行，保留其余', () => {
  const json = {
    data: {
      klines: [
        '2026-08-06 10:30,1310.00,1300.20,1314.40,1300.01,10112',
        '这是一行垃圾',
        '2026-08-06 11:30,1300.30,1308.78,1309.58,1300.10,6015',
      ],
    },
  };
  assert.equal(parseKlineResponse(json, 'sh600519').bars.length, 2);
});

// —— 请求参数 ——

/** 拦下 URL 并回一份真实响应 */
function spyFetch(box, payload = REAL_JSON) {
  return async (url) => {
    box.url = url;
    return {
      ok: true,
      status: 200,
      arrayBuffer: async () => Buffer.from(JSON.stringify(payload), 'utf8'),
    };
  };
}

test('fetchKline60：走 push2his，klt=60、fqt=1', async () => {
  const box = {};
  await fetchKline60('sh600519', {}, { fetchImpl: spyFetch(box) });
  assert.match(box.url, /push2his\.eastmoney\.com/);
  assert.match(box.url, /klt=60/);
  assert.match(box.url, /fqt=1/, '必须前复权：除权日会算出假的金叉死叉');
  assert.match(box.url, /secid=1\.600519/);
});

test('fetchKline60：count 封顶到 MAX_BARS', async () => {
  // 实测请求 200/640/1000/5000 都只回 126 根，多要毫无意义
  const box = {};
  await fetchKline60('sh600519', { count: 99999 }, { fetchImpl: spyFetch(box) });
  assert.match(box.url, new RegExp(`lmt=${MAX_BARS}(&|$)`));
  assert.equal(MAX_BARS, 126, '服务端实际上限，改这个值前先重新实测');
});

test('fetchKline60：count 非法或缺省时用 MAX_BARS', async () => {
  for (const bad of [undefined, null, 0, -5, 'abc', NaN]) {
    const box = {};
    await fetchKline60('sh600519', { count: bad }, { fetchImpl: spyFetch(box) });
    assert.match(box.url, new RegExp(`lmt=${MAX_BARS}(&|$)`), `count=${bad} 应回落到上限`);
  }
});

test('fetchKline60：非法代码抛错，不发请求', async () => {
  let called = false;
  const spy = async () => {
    called = true;
  };
  await assert.rejects(() => fetchKline60('abc', {}, { fetchImpl: spy }), /无法识别的代码/);
  assert.equal(called, false);
});

test('fetchKline60：ETF 与指数同样能解析（无需按类型分流）', async () => {
  // 实测 510300 与上证指数都返回数据，字段序一致
  const etf = {
    data: {
      code: '510300',
      name: '沪深300ETF华泰柏瑞',
      klines: ['2026-08-10 11:30,4.741,4.735,4.744,4.730,773647,366468469.000,0.30,-0.11,-0.005,0.31'],
    },
  };
  const box = {};
  const r = await fetchKline60('sh510300', {}, { fetchImpl: spyFetch(box, etf) });
  assert.equal(r.bars.length, 1);
  assert.equal(r.bars[0].close, 4.735);
  assert.equal(r.name, '沪深300ETF华泰柏瑞');
});
