'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const {
  toSecid,
  toSecucode,
  num,
  dateOnly,
  eqFilter,
  fetchReport,
  fetchWithHostFallback,
  DATACENTER_WEB,
  PUSH2_HOSTS,
} = require('./eastmoney');

// —— secid ——

test('toSecid：沪市前缀 1，深市前缀 0', () => {
  assert.equal(toSecid('sh600519'), '1.600519');
  assert.equal(toSecid('sz000001'), '0.000001');
  assert.equal(toSecid('sh510300'), '1.510300');
});

test('toSecid：大小写与空白容错，非法输入返回空串', () => {
  assert.equal(toSecid('SH600519'), '1.600519');
  assert.equal(toSecid('  sz000001  '), '0.000001');
  for (const bad of ['', null, undefined, 'sh60051', '600519', 'hk00700', 'abc']) {
    assert.equal(toSecid(bad), '', `${bad} 应返回空串`);
  }
});

// —— SECUCODE ——
//
// 这个转换是数据中心报表**避免张冠李戴**的关键：用 6 位数字过滤时
// 000001 会命中深市平安银行，沪市指数拿到的就是平安银行的数据。

test('toSecucode：交易所后缀大写', () => {
  assert.equal(toSecucode('sh600519'), '600519.SH');
  assert.equal(toSecucode('sz000001'), '000001.SZ');
  assert.equal(toSecucode('SZ300750'), '300750.SZ');
});

test('toSecucode：同数字不同交易所要产出不同结果', () => {
  // 沪 000001 是上证指数，深 000001 是平安银行 —— 必须区分得开
  assert.notEqual(toSecucode('sh000001'), toSecucode('sz000001'));
  assert.equal(toSecucode('sh000001'), '000001.SH');
  assert.equal(toSecucode('sz000001'), '000001.SZ');
});

test('toSecucode：非法输入返回空串而不抛异常', () => {
  for (const bad of ['', null, undefined, '600519', 'sh6005', 'bj430047', 'abc']) {
    assert.equal(toSecucode(bad), '', `${bad} 应返回空串`);
  }
});

// —— num ——

test('num：解析数字，空与占位符为 null', () => {
  assert.equal(num('1309.22'), 1309.22);
  assert.equal(num(-42), -42);
  assert.equal(num('0'), 0, '0 是有效值，不能当成空');
  for (const empty of ['', '  ', '-', null, undefined, 'abc', NaN]) {
    assert.equal(num(empty), null, `${empty} 应为 null`);
  }
});

// —— dateOnly ——

test('dateOnly：截掉东财的 00:00:00 时间部分', () => {
  assert.equal(dateOnly('2026-08-07 00:00:00'), '2026-08-07');
  assert.equal(dateOnly('2026-08-07'), '2026-08-07');
  assert.equal(dateOnly('2026-08-07T10:30:00'), '2026-08-07');
});

test('dateOnly：格式不符时原样返回，不产出 undefined', () => {
  assert.equal(dateOnly(''), '');
  assert.equal(dateOnly(null), '');
  assert.equal(dateOnly('待定'), '待定');
});

// —— eqFilter ——

test('eqFilter：拼出东财的 filter 表达式', () => {
  assert.equal(eqFilter('SECUCODE', '600519.SH'), '(SECUCODE="600519.SH")');
});

test('eqFilter：剥掉引号与括号，防止拼出畸形表达式', () => {
  // 值里带引号会让表达式提前闭合，可能被当成额外条件
  assert.equal(eqFilter('SECUCODE', '600519"'), '(SECUCODE="600519")');
  assert.equal(eqFilter('SCODE', 'a(b)c'), '(SCODE="abc")');
  assert.equal(eqFilter('SCODE', null), '(SCODE="")');
});

// —— fetchReport ——
//
// 报表响应有三种形态，且「无数据」是常态（未上榜、非两融标的、ETF 没财务）。
// 把它当错误抛出去会让 UI 频繁弹错；反之，把真正的报表改名当成无数据，
// 排查时又毫无线索。这组测试盯住这个分界。

/** 造一个返回固定 JSON 的 fetch 替身 */
function fakeFetch(payload) {
  return async () => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    arrayBuffer: async () => Buffer.from(JSON.stringify(payload), 'utf8'),
  });
}

test('fetchReport：正常响应拆出 rows / pages / count', async () => {
  const payload = {
    result: { pages: 3, count: 7, data: [{ SECUCODE: '600519.SH' }, { SECUCODE: '600519.SH' }] },
    success: true,
  };
  const r = await fetchReport(DATACENTER_WEB, { reportName: 'X' }, { fetchImpl: fakeFetch(payload) });
  assert.equal(r.rows.length, 2);
  assert.equal(r.pages, 3);
  assert.equal(r.count, 7);
});

test('fetchReport：code 9201「返回数据为空」是常态，给空数组不抛错', async () => {
  const payload = { version: null, result: null, success: false, message: '返回数据为空', code: 9201 };
  const r = await fetchReport(DATACENTER_WEB, { reportName: 'X' }, { fetchImpl: fakeFetch(payload) });
  assert.deepEqual(r.rows, []);
  assert.equal(r.count, 0);
});

test('fetchReport：报表配置不存在要抛错，不能静默变成「暂无数据」', async () => {
  // 接口改名时必须炸出来，否则功能静默消失且无线索
  const payload = { result: null, success: false, message: '报表配置不存在,RPT_XXX', code: 9501 };
  await assert.rejects(
    () => fetchReport(DATACENTER_WEB, { reportName: 'RPT_XXX' }, { fetchImpl: fakeFetch(payload) }),
    /报表配置不存在/
  );
});

test('fetchReport：服务器繁忙也要抛错（与无数据区分开）', async () => {
  const payload = { result: null, success: false, message: '服务器繁忙', code: 9701 };
  await assert.rejects(
    () => fetchReport(DATACENTER_WEB, { reportName: 'X' }, { fetchImpl: fakeFetch(payload) }),
    /服务器繁忙/
  );
});

test('fetchReport：无 message 的畸形响应按空数据处理', async () => {
  const r = await fetchReport(DATACENTER_WEB, { reportName: 'X' }, { fetchImpl: fakeFetch({}) });
  assert.deepEqual(r.rows, []);
});

test('fetchReport：默认带 source/client，调用方可覆盖', async () => {
  let seenUrl = '';
  const spy = async (url) => {
    seenUrl = url;
    return {
      ok: true,
      status: 200,
      arrayBuffer: async () => Buffer.from(JSON.stringify({ result: { data: [] } }), 'utf8'),
    };
  };
  await fetchReport(DATACENTER_WEB, { reportName: 'X' }, { fetchImpl: spy });
  assert.match(seenUrl, /source=WEB/);
  assert.match(seenUrl, /client=WEB/);

  // F10 域要 HSF10/PC，给 WEB/WEB 拿不到数据
  await fetchReport(DATACENTER_WEB, { reportName: 'X', source: 'HSF10', client: 'PC' }, { fetchImpl: spy });
  assert.match(seenUrl, /source=HSF10/);
  assert.match(seenUrl, /client=PC/);
});

// —— 域名回退 ——
//
// push2 主域名在开发机所在网络会被 TCP 重置（12/12 失败），而 48.push2 与
// push2delay 稳定可用。回退必须真的换域名重试，否则整个实时类接口都用不了。

test('fetchWithHostFallback：首个域名成功时不再试其它', async () => {
  const tried = [];
  const spy = async (url) => {
    tried.push(url);
    return {
      ok: true,
      status: 200,
      arrayBuffer: async () => Buffer.from(JSON.stringify({ rc: 0 }), 'utf8'),
    };
  };
  const json = await fetchWithHostFallback(['a.example', 'b.example'], '/p?x=1', { fetchImpl: spy });
  assert.equal(json.rc, 0);
  assert.equal(tried.length, 1, '第一个就成了，不该继续试');
  assert.match(tried[0], /^https:\/\/a\.example\/p\?x=1$/);
});

test('fetchWithHostFallback：连接失败时换下一个域名', async () => {
  const tried = [];
  const spy = async (url) => {
    tried.push(url);
    // 模拟 push2 的 UND_ERR_SOCKET：第一个域名连不上
    if (url.includes('dead.example')) throw new Error('fetch failed');
    return {
      ok: true,
      status: 200,
      arrayBuffer: async () => Buffer.from(JSON.stringify({ rc: 0, ok: 1 }), 'utf8'),
    };
  };
  const json = await fetchWithHostFallback(['dead.example', 'alive.example'], '/p', { fetchImpl: spy });
  assert.equal(json.ok, 1);
  assert.equal(tried.length, 2);
  assert.match(tried[1], /alive\.example/);
});

test('fetchWithHostFallback：全部失败时抛最后一个错误', async () => {
  const spy = async () => {
    throw new Error('fetch failed');
  };
  await assert.rejects(
    () => fetchWithHostFallback(['a.example', 'b.example'], '/p', { fetchImpl: spy }),
    /fetch failed/
  );
});

test('PUSH2_HOSTS：把实测可用的镜像排在主域名之前', () => {
  // 主域名在本机 0/12，48.push2 与 push2delay 12/12 —— 顺序反了等于用不了
  const main = PUSH2_HOSTS.indexOf('push2.eastmoney.com');
  const mirror = PUSH2_HOSTS.indexOf('48.push2.eastmoney.com');
  assert.ok(mirror >= 0, '应包含实测可用的 48.push2 镜像');
  assert.ok(mirror < main, '可用镜像必须排在主域名之前');
});
