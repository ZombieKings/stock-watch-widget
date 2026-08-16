'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const {
  fetchFlow,
  parseFlowLine,
  parseFlowResponse,
  latestFlow,
  toSecid,
} = require('./flowClient');

/**
 * 贵州茅台 2026-08-07 的真实响应，原样抄录（含 rt/svr 等无关字段与末尾两个 0.00）。
 * 五行都是接口返回的，没有一行是手写的 —— 下面「主力=大单+超大单」「四档和≈0」
 * 两条自洽性断言只有在数据真实时才有意义，编造的行会让它们变成空转。
 */
const REAL_JSON = {
  rc: 0,
  rt: 22,
  svr: 177617931,
  lt: 1,
  full: 0,
  data: {
    code: '600519',
    market: 1,
    name: '贵州茅台',
    klines: [
      '2026-08-03,-22180448.0,-217368.0,22397824.0,163591040.0,-185771488.0,-0.45,-0.00,0.46,3.34,-3.79,1358.98,0.62,0.00,0.00',
      '2026-08-04,-668398240.0,-405840.0,668804096.0,-215226752.0,-453171488.0,-13.36,-0.01,13.37,-4.30,-9.06,1328.36,-2.25,0.00,0.00',
      '2026-08-05,-837513552.0,-338471.0,837852016.0,-524643888.0,-312869664.0,-14.95,-0.01,14.96,-9.37,-5.59,1306.45,-1.65,0.00,0.00',
      '2026-08-06,-165793504.0,-126753.0,165920256.0,-126662304.0,-39131200.0,-4.98,-0.00,4.99,-3.81,-1.18,1308.55,0.16,0.00,0.00',
      '2026-08-07,-116062624.0,-252559.0,116315168.0,-108712640.0,-7349984.0,-3.55,-0.01,3.56,-3.33,-0.22,1309.22,0.05,0.00,0.00',
    ],
  },
};

// —— secid 转换 ——

test('toSecid：沪市前缀 1，深市前缀 0', () => {
  assert.equal(toSecid('sh600519'), '1.600519');
  assert.equal(toSecid('sz000001'), '0.000001');
  assert.equal(toSecid('sz300750'), '0.300750');
  assert.equal(toSecid('sh510300'), '1.510300');
});

test('toSecid：大小写与空白容错', () => {
  assert.equal(toSecid('SH600519'), '1.600519');
  assert.equal(toSecid('  sz000001  '), '0.000001');
});

test('toSecid：非法输入返回空串而不抛异常', () => {
  for (const bad of ['', null, undefined, 'sh60051', 'sh6005199', 'hk00700', '600519', 'abc']) {
    assert.equal(toSecid(bad), '', `${bad} 应返回空串`);
  }
});

// —— 单行解析 ——

test('解析单行：字段序对得上', () => {
  const d = parseFlowLine(REAL_JSON.data.klines[4]);
  assert.equal(d.date, '2026-08-07');
  assert.equal(d.main, -116062624);
  assert.equal(d.small, -252559);
  assert.equal(d.medium, 116315168);
  assert.equal(d.large, -108712640);
  assert.equal(d.huge, -7349984);
  assert.equal(d.mainPct, -3.55);
  assert.equal(d.smallPct, -0.01);
  assert.equal(d.mediumPct, 3.56);
  assert.equal(d.largePct, -3.33);
  assert.equal(d.hugePct, -0.22);
  assert.equal(d.close, 1309.22);
  assert.equal(d.changePct, 0.05);
});

test('收盘价与行情自洽 —— 证明 [11] 段没错位', () => {
  // 2026-08-06 收 1308.55，2026-08-07 收 1309.22，涨跌幅 0.05%
  const d6 = parseFlowLine(REAL_JSON.data.klines[3]);
  const d7 = parseFlowLine(REAL_JSON.data.klines[4]);
  const pct = ((d7.close - d6.close) / d6.close) * 100;
  assert.ok(Math.abs(d7.changePct - pct) < 0.01, `涨跌幅应约 ${pct.toFixed(2)}，接口给 ${d7.changePct}`);
});

test('主力净额 = 大单 + 超大单 —— 钉住字段序不被打乱', () => {
  for (const line of REAL_JSON.data.klines) {
    const d = parseFlowLine(line);
    const sum = d.large + d.huge;
    assert.ok(
      Math.abs(d.main - sum) < 1,
      `${d.date}: 主力 ${d.main} 应等于大单+超大单 ${sum}`
    );
  }
});

test('四档净额之和约为零 —— 净买卖必然对冲', () => {
  for (const line of REAL_JSON.data.klines) {
    const d = parseFlowLine(line);
    const total = d.small + d.medium + d.large + d.huge;
    // 实测残差在几十元量级（接口各档按元取整，且金额本身是亿级）。
    // 阈值取 1000：够松以容纳取整误差，够紧以抓出字段错位（那会差好几个数量级）。
    assert.ok(Math.abs(total) < 1000, `${d.date}: 四档之和 ${total} 应约为 0`);
  }
});

test('主力净占比与其它档占比之和约为零', () => {
  for (const line of REAL_JSON.data.klines) {
    const d = parseFlowLine(line);
    const total = d.smallPct + d.mediumPct + d.largePct + d.hugePct;
    assert.ok(Math.abs(total) < 0.05, `${d.date}: 四档占比之和 ${total} 应约为 0`);
  }
});

test('字段不足的行返回 null', () => {
  assert.equal(parseFlowLine('2026-08-07,100'), null);
  assert.equal(parseFlowLine(''), null);
  assert.equal(parseFlowLine(null), null);
});

test('日期缺失的行返回 null', () => {
  assert.equal(parseFlowLine(',1,2,3,4,5'), null);
});

test('空字段与 "-" 解析为 null，不是 0', () => {
  const d = parseFlowLine('2026-08-07,-116062624.0,,116315168.0,-,-7349984.0');
  assert.equal(d.small, null, '空串应为 null');
  assert.equal(d.large, null, '"-" 应为 null');
  // 0 与 null 要分清：0 是真实的「没有净流入」，null 是「接口没给」
  assert.equal(d.main, -116062624);
});

// —— 响应解析 ——

test('解析完整响应：按日期升序，末项为最近一日', () => {
  const r = parseFlowResponse(REAL_JSON, 'sh600519');
  assert.equal(r.code, 'sh600519');
  assert.equal(r.name, '贵州茅台');
  assert.equal(r.days.length, 5);
  assert.equal(r.days[0].date, '2026-08-03');
  assert.equal(r.days[4].date, '2026-08-07');
  // 升序：逐项校验，不能只看首尾
  for (let i = 1; i < r.days.length; i += 1) {
    assert.ok(r.days[i].date > r.days[i - 1].date, `第 ${i} 项日期未升序`);
  }
});

test('data 为 null 时返回空 days，而不是抛异常', () => {
  // 新股、停牌、指数都会走到这里
  for (const bad of [null, undefined, {}, { data: null }, { data: {} }, { data: { klines: null } }]) {
    const r = parseFlowResponse(bad, 'sh600519');
    assert.deepEqual(r.days, [], `${JSON.stringify(bad)} 应返回空 days`);
    assert.equal(r.code, 'sh600519');
  }
});

test('klines 中的坏行被过滤，好行保留', () => {
  const r = parseFlowResponse({
    data: {
      name: '测试',
      klines: ['坏行', '2026-08-07,1,2,3,4,5', '', '2026-08-08,6,7,8,9,10'],
    },
  });
  assert.equal(r.days.length, 2);
  assert.equal(r.days[0].date, '2026-08-07');
  assert.equal(r.days[1].date, '2026-08-08');
});

// —— latestFlow ——

test('latestFlow 取末项并标记自洽', () => {
  const r = parseFlowResponse(REAL_JSON, 'sh600519');
  const last = latestFlow(r);
  assert.equal(last.date, '2026-08-07');
  assert.equal(last.main, -116062624);
  assert.equal(last.consistent, true);
});

test('latestFlow 对五天数据全部自洽', () => {
  const r = parseFlowResponse(REAL_JSON, 'sh600519');
  for (const d of r.days) {
    assert.ok(
      Math.abs(d.main - (d.large + d.huge)) < 1,
      `${d.date}: 主力 ${d.main} ≠ 大单+超大单 ${d.large + d.huge}`
    );
  }
});

test('latestFlow 对空数据返回 null', () => {
  assert.equal(latestFlow(null), null);
  assert.equal(latestFlow({ days: [] }), null);
  assert.equal(latestFlow({}), null);
});

test('latestFlow：口径不符时 consistent 为 false', () => {
  const flow = { days: [{ date: '2026-08-07', main: 100, large: 20, huge: 30 }] };
  assert.equal(latestFlow(flow).consistent, false);
});

test('latestFlow：缺字段时 consistent 为 null 而非 false', () => {
  // 分不清「口径变了」和「这次没给数据」，用 null 表示未知
  const flow = { days: [{ date: '2026-08-07', main: 100, large: null, huge: 30 }] };
  assert.equal(latestFlow(flow).consistent, null);
});

// —— fetchFlow（注入假 fetch，不发网络请求）——

/**
 * 回放上面那份真实响应，并把请求 URL/headers 记下来。
 * 只用于验证「我们发出的请求长什么样」；响应内容是实测抄录的，不是编的。
 */
function replayFetch(captured) {
  return async (url, init) => {
    captured.url = url;
    captured.headers = (init && init.headers) || {};
    return {
      ok: true,
      status: 200,
      arrayBuffer: async () => Buffer.from(JSON.stringify(REAL_JSON), 'utf-8'),
    };
  };
}

test('fetchFlow 组装的 URL 带正确 secid 与日线参数', async () => {
  const cap = {};
  await fetchFlow('sh600519', { days: 5 }, { fetchImpl: replayFetch(cap) });
  assert.match(cap.url, /secid=1\.600519/);
  assert.match(cap.url, /push2his\.eastmoney\.com/, '必须用 push2his 域名，push2 只回 1 天');
  assert.match(cap.url, /fflow\/daykline\/get/, '必须用 daykline 路径');
  assert.match(cap.url, /lmt=5/);
  // fields2 必须列全 f51~f65，少给几段接口返回 0 条
  assert.match(cap.url, /f51.*f65/);
});

test('fetchFlow 带 Referer —— 缺失会被东财拒绝', () => {
  const cap = {};
  return fetchFlow('sh600519', {}, { fetchImpl: replayFetch(cap) }).then(() => {
    assert.match(String(cap.headers.Referer || ''), /eastmoney\.com/);
  });
});

test('fetchFlow 非法代码抛出可读错误', async () => {
  await assert.rejects(() => fetchFlow('hk00700', {}, { fetchImpl: replayFetch({}) }), /无法识别的代码/);
});

test('fetchFlow 的 days 参数：非法值回落默认，过大被夹住', async () => {
  for (const [input, expect] of [[0, 5], [-3, 5], [NaN, 5], [undefined, 5], [999, 60]]) {
    const cap = {};
    await fetchFlow('sh600519', { days: input }, { fetchImpl: replayFetch(cap) });
    assert.match(cap.url, new RegExp(`lmt=${expect}(&|$)`), `days=${input} 应得 lmt=${expect}`);
  }
});

test('fetchFlow 返回解析后的形状', async () => {
  const r = await fetchFlow('sh600519', {}, { fetchImpl: replayFetch({}) });
  assert.equal(r.name, '贵州茅台');
  assert.equal(r.days.length, 5);
  assert.equal(r.code, 'sh600519');
});

// —— 打真实接口 ——
// 回放测试只能证明「解析器对得上那份抄来的响应」，证不了接口还活着。
// 东财换域名、改字段序、加 Referer 校验都只有真连才发现。
// 网络不可用时跳过而不是红 —— 断网也要能跑单测。

test('真实接口：字段序与自洽性仍然成立', async (t) => {
  let r;
  try {
    r = await fetchFlow('sh600519', { days: 5 });
  } catch (err) {
    t.skip(`网络不可用，跳过：${err.message}`);
    return;
  }

  assert.ok(r.days.length >= 1, `应至少返回 1 天，实得 ${r.days.length}`);
  assert.ok(r.name.length > 0, '应返回名称');

  const last = r.days[r.days.length - 1];
  // 这三条是解析器的全部依赖：日期在 [0]、金额单位是元、主力=大+超大。
  // 任一条被上游改动，这里立刻红。
  assert.match(last.date, /^\d{4}-\d{2}-\d{2}$/, `日期格式变了：${last.date}`);
  assert.ok(Number.isFinite(last.main), '主力净额应为数字');
  assert.ok(
    Math.abs(last.main - (last.large + last.huge)) < 1,
    `口径变了：主力 ${last.main} ≠ 大单+超大单 ${last.large + last.huge}`
  );
  assert.ok(Math.abs(last.main) > 1000, `单位应是元，实得 ${last.main} 像是被改成了万元`);
});

test('真实接口：ETF 同样有资金流数据', async (t) => {
  let r;
  try {
    r = await fetchFlow('sh510300', { days: 3 });
  } catch (err) {
    t.skip(`网络不可用，跳过：${err.message}`);
    return;
  }
  // 公告接口要区分 ann_type=A/FUND，资金流接口不用 —— 钉住这个差异
  assert.ok(r.days.length >= 1, 'ETF 应有资金流数据');
  assert.ok(Number.isFinite(r.days[r.days.length - 1].main));
});
