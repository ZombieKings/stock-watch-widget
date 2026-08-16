'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const {
  isWeekend,
  marketPhase,
  isTradingNow,
  pollIntervalMs,
  phaseLabel,
  localDateKey,
  parseQuoteTime,
  isStaleForToday,
  resolvePhase,
  POLL_MS,
} = require('./marketTime');

/** 构造本地时间。2026-08-06 是周四，2026-08-08 是周六 */
function at(dateStr, h, m) {
  const [y, mo, d] = dateStr.split('-').map(Number);
  return new Date(y, mo - 1, d, h, m, 0);
}

const THU = '2026-08-06';
const SAT = '2026-08-08';
const SUN = '2026-08-09';

test('周末判定', () => {
  assert.equal(isWeekend(at(THU, 10, 0)), false);
  assert.equal(isWeekend(at(SAT, 10, 0)), true);
  assert.equal(isWeekend(at(SUN, 10, 0)), true);
});

test('工作日各时段边界', () => {
  assert.equal(marketPhase(at(THU, 8, 0)), 'preopen');
  assert.equal(marketPhase(at(THU, 9, 14)), 'preopen');
  assert.equal(marketPhase(at(THU, 9, 15)), 'auction'); // 集合竞价开始
  assert.equal(marketPhase(at(THU, 9, 29)), 'auction');
  assert.equal(marketPhase(at(THU, 9, 30)), 'trading'); // 早盘开
  assert.equal(marketPhase(at(THU, 11, 29)), 'trading');
  assert.equal(marketPhase(at(THU, 11, 30)), 'lunch'); // 早盘收
  assert.equal(marketPhase(at(THU, 12, 59)), 'lunch');
  assert.equal(marketPhase(at(THU, 13, 0)), 'trading'); // 午盘开
  assert.equal(marketPhase(at(THU, 14, 59)), 'trading');
  assert.equal(marketPhase(at(THU, 15, 0)), 'closed'); // 收盘
  assert.equal(marketPhase(at(THU, 23, 59)), 'closed');
});

test('周末任意时刻都是 weekend，不受时段影响', () => {
  assert.equal(marketPhase(at(SAT, 10, 0)), 'weekend');
  assert.equal(marketPhase(at(SUN, 14, 0)), 'weekend');
});

test('isTradingNow 只在连续竞价时段为真', () => {
  assert.equal(isTradingNow(at(THU, 10, 0)), true);
  assert.equal(isTradingNow(at(THU, 12, 0)), false); // 午休
  assert.equal(isTradingNow(at(THU, 9, 20)), false); // 集合竞价
  assert.equal(isTradingNow(at(SAT, 10, 0)), false);
});

test('轮询间隔随时段变化——收盘后不再高频打接口', () => {
  assert.equal(pollIntervalMs(at(THU, 10, 0)), POLL_MS.trading);
  assert.equal(pollIntervalMs(at(THU, 12, 0)), POLL_MS.auction);
  assert.equal(pollIntervalMs(at(THU, 9, 20)), POLL_MS.auction);
  assert.equal(pollIntervalMs(at(THU, 8, 0)), POLL_MS.preopen);
  assert.equal(pollIntervalMs(at(THU, 16, 0)), POLL_MS.closed);
  assert.equal(pollIntervalMs(at(SAT, 10, 0)), POLL_MS.closed);
  // 盘中间隔必须比收盘后短，否则时段逻辑就写反了
  assert.ok(POLL_MS.trading < POLL_MS.closed);
});

test('时段中文标签', () => {
  assert.equal(phaseLabel('trading'), '交易中');
  assert.equal(phaseLabel('lunch'), '午间休市');
  assert.equal(phaseLabel('weekend'), '休市');
  assert.equal(phaseLabel('unknown'), '');
});

test('localDateKey 用本地时区，不会因 UTC 偏移串日', () => {
  // 本地 00:30 若走 toISOString 会退到前一天（UTC+8）
  assert.equal(localDateKey(at(THU, 0, 30)), '2026-08-06');
  assert.equal(localDateKey(at(THU, 23, 30)), '2026-08-06');
});

test('解析腾讯行情时间戳', () => {
  const d = parseQuoteTime('20260806104333');
  assert.ok(d instanceof Date);
  assert.equal(d.getFullYear(), 2026);
  assert.equal(d.getMonth(), 7); // 0-based
  assert.equal(d.getDate(), 6);
  assert.equal(d.getHours(), 10);
  assert.equal(d.getMinutes(), 43);
  assert.equal(d.getSeconds(), 33);
});

test('非法时间戳返回 null', () => {
  for (const bad of ['', null, undefined, '2026080', 'abcdefghijklmn', '20260806']) {
    assert.equal(parseQuoteTime(bad), null, `应拒绝: ${JSON.stringify(bad)}`);
  }
});

test('行情时间戳不是今天 → 判为休市（法定节假日）', () => {
  const now = at(THU, 10, 0);
  // 同日 → 正常
  assert.equal(isStaleForToday(at(THU, 9, 45), now), false);
  // 前一交易日快照 → 今天没开市
  assert.equal(isStaleForToday(at('2026-08-05', 15, 0), now), true);
});

test('拿不到时间戳时不误报休市', () => {
  assert.equal(isStaleForToday(null, at(THU, 10, 0)), false);
});

// —— resolvePhase：三层休市判定的组合 ——
//
// 优先级：交易日历（权威，能提前知道调休）> 行情时间戳过期 > 周末+时段。
// 日历不可用（null）时行为必须与接入日历之前完全一致，否则离线就废了。

test('resolvePhase：日历说不开市 → 法定节假日，开盘前就能判出来', () => {
  // 这是接日历唯一真正新增的能力：09:15 之前还没有任何行情数据，
  // 靠时间戳回落根本判不出来
  const r = resolvePhase({ now: at(THU, 8, 0), quoteTime: null, isTradingDay: false });
  assert.equal(r.phase, 'closed');
  assert.equal(r.label, '休市');
  assert.equal(r.isHoliday, true);
  assert.equal(r.source, 'calendar');
});

test('resolvePhase：日历说开市且时间戳是今天 → 按时段走', () => {
  const r = resolvePhase({ now: at(THU, 10, 0), quoteTime: at(THU, 9, 59), isTradingDay: true });
  assert.equal(r.phase, 'trading');
  assert.equal(r.label, '交易中');
  assert.equal(r.isHoliday, false);
  assert.equal(r.source, 'clock');
});

test('resolvePhase：日历说开市但时间戳过期 → 判为数据延迟，不报休市', () => {
  // 日历是权威的：它说今天开市，那拿不到今天的数据更可能是行情源延迟
  const r = resolvePhase({ now: at(THU, 10, 0), quoteTime: at('2026-08-05', 15, 0), isTradingDay: true });
  assert.equal(r.isHoliday, false, '不能因为数据旧就说休市');
  assert.equal(r.phase, 'trading', '保留原时段');
  assert.equal(r.source, 'calendar-trading-stale');
});

test('resolvePhase：日历不可用 + 时间戳过期 → 维持接入前的行为（报休市）', () => {
  const r = resolvePhase({ now: at(THU, 10, 0), quoteTime: at('2026-08-05', 15, 0), isTradingDay: null });
  assert.equal(r.phase, 'closed');
  assert.equal(r.isHoliday, true);
  assert.equal(r.source, 'stale');
});

test('resolvePhase：开盘前时间戳必然是旧的，不能据此报休市', () => {
  // 不加这个例外，每天早上都会显示「休市」
  const r = resolvePhase({ now: at(THU, 8, 0), quoteTime: at('2026-08-05', 15, 0), isTradingDay: null });
  assert.equal(r.phase, 'preopen');
  assert.equal(r.isHoliday, false);
  assert.equal(r.source, 'clock');
});

test('resolvePhase：周末不问日历，直接周末', () => {
  for (const day of [SAT, SUN]) {
    const r = resolvePhase({ now: at(day, 10, 0), quoteTime: null, isTradingDay: null });
    assert.equal(r.phase, 'weekend');
    assert.equal(r.isHoliday, false, '周末是常规休市，不算法定节假日');
    assert.equal(r.source, 'weekend');
  }
});

test('resolvePhase：日历不可用时各时段与 marketPhase 完全一致', () => {
  // 回归保险：接日历不该改变原有的时段划分
  for (const [h, m] of [[8, 0], [9, 20], [10, 0], [12, 0], [14, 0], [16, 0]]) {
    const now = at(THU, h, m);
    const r = resolvePhase({ now, quoteTime: now, isTradingDay: null });
    assert.equal(r.phase, marketPhase(now), `${h}:${m} 时段应一致`);
    assert.equal(r.label, phaseLabel(marketPhase(now)));
  }
});

test('resolvePhase：不传参数也不抛错，用当前时间', () => {
  const r = resolvePhase();
  assert.ok(typeof r.phase === 'string' && r.phase.length > 0);
  assert.equal(typeof r.isHoliday, 'boolean');
});
