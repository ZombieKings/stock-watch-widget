'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { parseMonth, monthOf, createTradingCalendar, fetchMonth } = require('./calendarClient');

/** 深交所 2026-08 的真实响应片段（jybz: '1'=交易日, '0'=休市） */
const AUG_JSON = {
  data: [
    { zrxh: 7, jybz: '0', jyrq: '2026-08-01' },
    { zrxh: 1, jybz: '0', jyrq: '2026-08-02' },
    { zrxh: 2, jybz: '1', jyrq: '2026-08-03' },
    { zrxh: 3, jybz: '1', jyrq: '2026-08-04' },
    { zrxh: 4, jybz: '1', jyrq: '2026-08-05' },
    { zrxh: 5, jybz: '1', jyrq: '2026-08-06' },
    { zrxh: 6, jybz: '1', jyrq: '2026-08-07' },
    { zrxh: 7, jybz: '0', jyrq: '2026-08-08' },
    { zrxh: 1, jybz: '0', jyrq: '2026-08-09' },
    { zrxh: 2, jybz: '1', jyrq: '2026-08-10' },
  ],
  nowdate: '2026-08-10',
};

/** 2026-10 国庆假期的真实响应片段，含调休 */
const OCT_JSON = {
  data: [
    { zrxh: 5, jybz: '0', jyrq: '2026-10-01' },
    { zrxh: 6, jybz: '0', jyrq: '2026-10-02' },
    { zrxh: 7, jybz: '0', jyrq: '2026-10-03' },
    { zrxh: 1, jybz: '0', jyrq: '2026-10-04' },
    { zrxh: 2, jybz: '0', jyrq: '2026-10-05' },
    { zrxh: 3, jybz: '0', jyrq: '2026-10-06' },
    { zrxh: 4, jybz: '0', jyrq: '2026-10-07' },
    { zrxh: 5, jybz: '1', jyrq: '2026-10-08' },
    { zrxh: 6, jybz: '1', jyrq: '2026-10-09' },
  ],
  nowdate: '2026-08-10',
};

// —— 解析 ——

test('parseMonth：jybz 1 为交易日，0 为休市', () => {
  const m = parseMonth(AUG_JSON);
  assert.equal(m.get('2026-08-03'), true, '周一开市');
  assert.equal(m.get('2026-08-08'), false, '周六休市');
  assert.equal(m.size, 10);
});

test('parseMonth：国庆假期整段为休市，10-08 起恢复（这是周末判定拿不到的信息）', () => {
  const m = parseMonth(OCT_JSON);
  for (const d of ['2026-10-01', '2026-10-05', '2026-10-07']) {
    assert.equal(m.get(d), false, `${d} 应为休市`);
  }
  // 10-08 是周四，正常开市；周末判定对整段假期无能为力
  assert.equal(m.get('2026-10-08'), true);
  // 10-09 是周五，也开市
  assert.equal(m.get('2026-10-09'), true);
});

test('parseMonth：空 data（越界月份）给空 Map 而不抛错', () => {
  // 实测 2027-01、1999-01、'abc' 都返回 { data: [] }
  for (const empty of [{ data: [] }, {}, null, undefined, { data: null }]) {
    assert.equal(parseMonth(empty).size, 0);
  }
});

test('parseMonth：跳过日期格式不对的行', () => {
  const m = parseMonth({ data: [{ jyrq: '2026-8-3', jybz: '1' }, { jyrq: '', jybz: '1' }, { jybz: '1' }] });
  assert.equal(m.size, 0);
});

test('monthOf：截出年月', () => {
  assert.equal(monthOf('2026-08-10'), '2026-08');
  assert.equal(monthOf(''), '');
});

test('fetchMonth：拒绝非法月份格式', async () => {
  let called = false;
  const spy = async () => {
    called = true;
  };
  for (const bad of ['2026-8', 'abc', '', '20260810']) {
    await assert.rejects(() => fetchMonth(bad, { fetchImpl: spy }), /YYYY-MM/);
  }
  assert.equal(called, false);
});

test('fetchMonth：带上 month 参数', async () => {
  const box = {};
  const spy = async (url) => {
    box.url = url;
    return {
      ok: true,
      status: 200,
      arrayBuffer: async () => Buffer.from(JSON.stringify(AUG_JSON), 'utf8'),
    };
  };
  const r = await fetchMonth('2026-08', { fetchImpl: spy });
  assert.match(box.url, /month=2026-08/);
  assert.equal(r.days.get('2026-08-10'), true);
});

// —— 带缓存的日历 ——
//
// 核心约定：日历不可用时必须返回 null（未知），让调用方回落到周末判定。
// 返回 false（休市）会在接口挂掉时把交易日误报成休市，比不接日历更糟。

test('createTradingCalendar：查得到就给布尔值', async () => {
  const cal = createTradingCalendar({
    fetchMonthImpl: async (month) => ({ month, days: parseMonth(AUG_JSON) }),
  });
  assert.equal(await cal.isTradingDay('2026-08-10'), true);
  assert.equal(await cal.isTradingDay('2026-08-08'), false);
});

test('createTradingCalendar：同一月份只请求一次（缓存）', async () => {
  let calls = 0;
  const cal = createTradingCalendar({
    fetchMonthImpl: async (month) => {
      calls += 1;
      return { month, days: parseMonth(AUG_JSON) };
    },
  });
  await cal.isTradingDay('2026-08-03');
  await cal.isTradingDay('2026-08-04');
  await cal.isTradingDay('2026-08-10');
  assert.equal(calls, 1, '三次查询同一月份应只发一次请求');
});

test('createTradingCalendar：并发查询同月份不会打多次接口', async () => {
  let calls = 0;
  const cal = createTradingCalendar({
    fetchMonthImpl: async (month) => {
      calls += 1;
      await new Promise((r) => setTimeout(r, 10));
      return { month, days: parseMonth(AUG_JSON) };
    },
  });
  const results = await Promise.all([
    cal.isTradingDay('2026-08-03'),
    cal.isTradingDay('2026-08-08'),
    cal.isTradingDay('2026-08-10'),
  ]);
  assert.equal(calls, 1, '并发也要合并成一次请求');
  assert.deepEqual(results, [true, false, true]);
});

test('createTradingCalendar：接口失败返回 null（未知），不是 false', async () => {
  // 返回 false 会把交易日误报成休市，比不接日历更糟
  const cal = createTradingCalendar({
    fetchMonthImpl: async () => {
      throw new Error('网络不可达');
    },
  });
  assert.equal(await cal.isTradingDay('2026-08-10'), null);
});

test('createTradingCalendar：失败过的月份不反复重试', async () => {
  let calls = 0;
  const cal = createTradingCalendar({
    fetchMonthImpl: async () => {
      calls += 1;
      throw new Error('网络不可达');
    },
  });
  await cal.isTradingDay('2026-08-10');
  await cal.isTradingDay('2026-08-11');
  await cal.isTradingDay('2026-08-12');
  assert.equal(calls, 1, '失败一次后就别再打了，行情轮询很频繁');
});

test('createTradingCalendar：空 Map（越界月份）也记为不可用', async () => {
  let calls = 0;
  const cal = createTradingCalendar({
    fetchMonthImpl: async (month) => {
      calls += 1;
      return { month, days: new Map() };
    },
  });
  assert.equal(await cal.isTradingDay('2027-01-05'), null);
  await cal.isTradingDay('2027-01-06');
  assert.equal(calls, 1);
});

test('createTradingCalendar：月份载入了但没这天，按未知处理', async () => {
  const cal = createTradingCalendar({
    fetchMonthImpl: async (month) => ({ month, days: parseMonth(AUG_JSON) }),
  });
  // AUG_JSON 只到 08-10，08-20 不在里面
  assert.equal(await cal.isTradingDay('2026-08-20'), null);
});

test('createTradingCalendar：非法日期返回 null 且不发请求', async () => {
  let calls = 0;
  const cal = createTradingCalendar({
    fetchMonthImpl: async () => {
      calls += 1;
      return { month: '', days: new Map() };
    },
  });
  for (const bad of ['', null, '2026-08', 'abc']) {
    assert.equal(await cal.isTradingDay(bad), null);
  }
  assert.equal(calls, 0);
});

test('peek：同步读缓存，未载入时为 null', async () => {
  const cal = createTradingCalendar({
    fetchMonthImpl: async (month) => ({ month, days: parseMonth(AUG_JSON) }),
  });
  assert.equal(cal.peek('2026-08-10'), null, '还没载入');
  await cal.isTradingDay('2026-08-10');
  assert.equal(cal.peek('2026-08-10'), true, '载入后同步可读');
  assert.equal(cal.peek('2026-08-08'), false);
});

test('reset：清空缓存后会重新请求', async () => {
  let calls = 0;
  const cal = createTradingCalendar({
    fetchMonthImpl: async (month) => {
      calls += 1;
      return { month, days: parseMonth(AUG_JSON) };
    },
  });
  await cal.isTradingDay('2026-08-10');
  cal.reset();
  await cal.isTradingDay('2026-08-10');
  assert.equal(calls, 2);
});

test('跨月：两个月份各请求一次', async () => {
  const byMonth = { '2026-08': AUG_JSON, '2026-10': OCT_JSON };
  let calls = 0;
  const cal = createTradingCalendar({
    fetchMonthImpl: async (month) => {
      calls += 1;
      return { month, days: parseMonth(byMonth[month] || { data: [] }) };
    },
  });
  assert.equal(await cal.isTradingDay('2026-08-10'), true);
  assert.equal(await cal.isTradingDay('2026-10-05'), false, '国庆假期');
  assert.equal(calls, 2);
});
