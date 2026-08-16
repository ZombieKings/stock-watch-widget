'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  ALERT_KINDS,
  ALERT_DIRS,
  MAX_RULES_PER_CODE,
  normalizeRule,
  normalizeRules,
  normalizeRulesByCode,
  ruleKey,
  ruleLabel,
  currentValue,
  matchRule,
  formatValue,
  formatAlert,
  evaluateAlerts,
  pruneFired,
} = require('./alertRules');

const { computePosition } = require('./position');

/** 造一条规则 */
function rule(kind, dir, value, over = {}) {
  return { kind, dir, value, ...over };
}

/** 造一个 collectWatchlist item */
function item(over = {}) {
  return {
    code: 'sh600519',
    digits: '600519',
    alias: '',
    name: '贵州茅台',
    price: 1309.22,
    change: 12.3,
    changePct: 0.95,
    position: null,
    ...over,
  };
}

const TODAY = '2026-08-13';

// —— normalizeRule ——

test('normalizeRule 接受三类合法条件', () => {
  for (const kind of ALERT_KINDS) {
    for (const dir of ALERT_DIRS) {
      const r = normalizeRule(rule(kind, dir, 5));
      assert.ok(r, `${kind}/${dir} 应被接受`);
      assert.equal(r.kind, kind);
      assert.equal(r.dir, dir);
    }
  }
});

test('normalizeRule 拒绝未登记的 kind', () => {
  for (const bad of ['volume', 'turnover', '', 'CHANGEPCT', null, 42]) {
    assert.equal(normalizeRule(rule(bad, 'gte', 5)), null, `kind=${JSON.stringify(bad)}`);
  }
});

test('normalizeRule 拒绝未登记的 dir', () => {
  for (const bad of ['gt', 'lt', 'eq', '', 'GTE', null]) {
    assert.equal(normalizeRule(rule('price', bad, 5)), null, `dir=${JSON.stringify(bad)}`);
  }
});

test('normalizeRule 的 value 非数字时整条丢弃', () => {
  for (const bad of ['abc', '', null, undefined, NaN, Infinity, {}, []]) {
    assert.equal(normalizeRule(rule('price', 'gte', bad)), null, `value=${JSON.stringify(bad)}`);
  }
});

test('normalizeRule 接受字符串数值（输入框存的是原文）', () => {
  const r = normalizeRule(rule('price', 'lte', '1600.5'));
  assert.equal(r.value, 1600.5);
});

test('价格阈值必须为正——0 与负价没有现实含义', () => {
  assert.equal(normalizeRule(rule('price', 'gte', 0)), null);
  assert.equal(normalizeRule(rule('price', 'gte', -10)), null);
});

test('涨跌幅与盈亏阈值可以为负——「跌 5% 提醒我」是最常用的规则', () => {
  assert.equal(normalizeRule(rule('changePct', 'lte', -5)).value, -5);
  assert.equal(normalizeRule(rule('profitPct', 'lte', -10)).value, -10);
  assert.equal(normalizeRule(rule('changePct', 'gte', 0)).value, 0, '0 也合法：「转正提醒我」');
});

test('value 保留 4 位小数——价格阈值可能是基金净值', () => {
  assert.equal(normalizeRule(rule('price', 'gte', 1.2345)).value, 1.2345);
  assert.equal(normalizeRule(rule('price', 'gte', 1.23456)).value, 1.2346);
});

test('enabled 缺省为 true，只有显式 false 才算关掉', () => {
  assert.equal(normalizeRule(rule('price', 'gte', 5)).enabled, true);
  assert.equal(normalizeRule(rule('price', 'gte', 5, { enabled: false })).enabled, false);
  // 手改过的配置里可能是别的值，除了 false 一律当启用
  assert.equal(normalizeRule(rule('price', 'gte', 5, { enabled: 'no' })).enabled, true);
  assert.equal(normalizeRule(rule('price', 'gte', 5, { enabled: 0 })).enabled, true);
});

test('normalizeRule 非对象输入返回 null', () => {
  for (const bad of [null, undefined, 'x', 42, []]) {
    assert.equal(normalizeRule(bad), null, `normalizeRule(${JSON.stringify(bad)})`);
  }
});

// —— normalizeRules ——

test('同 kind+dir 只留最后一条——两条一样的规则会发两条相同通知', () => {
  const list = normalizeRules([rule('changePct', 'gte', 5), rule('changePct', 'gte', 8)]);
  assert.equal(list.length, 1);
  assert.equal(list[0].value, 8, '留最后一条：设置界面追加在末尾，新填的更可能是想要的');
});

test('同 kind 不同 dir 都保留', () => {
  const list = normalizeRules([rule('changePct', 'gte', 5), rule('changePct', 'lte', -5)]);
  assert.equal(list.length, 2);
});

test('normalizeRules 剔除非法项', () => {
  const list = normalizeRules([rule('changePct', 'gte', 5), rule('bad', 'gte', 1), null, 'x']);
  assert.equal(list.length, 1);
});

test('normalizeRules 超上限时截断', () => {
  const many = [];
  for (let i = 0; i < MAX_RULES_PER_CODE + 5; i += 1) {
    // 用不同的 kind|dir 组合才不会被去重吃掉；不够时补不同 value 的同组合（会被去重）
    many.push(rule(ALERT_KINDS[i % 3], ALERT_DIRS[i % 2], i + 1));
  }
  const list = normalizeRules(many);
  assert.ok(list.length <= MAX_RULES_PER_CODE, `不该超过 ${MAX_RULES_PER_CODE}，得到 ${list.length}`);
});

test('normalizeRules 非数组输入返回空数组', () => {
  for (const bad of [null, undefined, 'x', 42, {}]) {
    assert.deepEqual(normalizeRules(bad), [], `normalizeRules(${JSON.stringify(bad)})`);
  }
});

// —— ruleKey ——

test('ruleKey 不含数组下标——删掉前面一条不该让后面那条重新提醒', () => {
  const a = rule('changePct', 'gte', 5);
  const b = rule('price', 'lte', 1600);
  // 无论 b 在数组里排第几，键都一样
  assert.equal(ruleKey('sh600519', b), ruleKey('sh600519', b));
  assert.notEqual(ruleKey('sh600519', a), ruleKey('sh600519', b));
});

test('ruleKey 含 value——改了阈值算新规则，当天能再提醒', () => {
  // 这是有意的：用户调整阈值说明他想重新观察这个位置
  const k1 = ruleKey('sh600519', rule('price', 'gte', 1300));
  const k2 = ruleKey('sh600519', rule('price', 'gte', 1400));
  assert.notEqual(k1, k2);
});

test('ruleKey 区分股票——同样的规则挂在两只股票上互不影响', () => {
  const r = rule('changePct', 'gte', 5);
  assert.notEqual(ruleKey('sh600519', r), ruleKey('sz000858', r));
});

test('ruleKey 区分方向', () => {
  assert.notEqual(
    ruleKey('sh600519', rule('changePct', 'gte', 5)),
    ruleKey('sh600519', rule('changePct', 'lte', 5))
  );
});

// —— matchRule：changePct ——

test('changePct/gte 正好等于阈值时命中（≥ 而非 >）', () => {
  // 用户填「涨幅 5%」的预期是「涨到 5% 提醒我」，正好 5.00% 不提醒会像漏了
  assert.equal(matchRule(rule('changePct', 'gte', 5), item({ changePct: 5 })), true);
  assert.equal(matchRule(rule('changePct', 'gte', 5), item({ changePct: 5.01 })), true);
  assert.equal(matchRule(rule('changePct', 'gte', 5), item({ changePct: 4.99 })), false);
});

test('changePct/lte 用于「跌破提醒」', () => {
  assert.equal(matchRule(rule('changePct', 'lte', -5), item({ changePct: -5 })), true);
  assert.equal(matchRule(rule('changePct', 'lte', -5), item({ changePct: -6 })), true);
  assert.equal(matchRule(rule('changePct', 'lte', -5), item({ changePct: -4 })), false);
});

test('changePct 缺失时不命中', () => {
  for (const bad of [null, undefined, NaN, 'abc']) {
    assert.equal(matchRule(rule('changePct', 'lte', 0), item({ changePct: bad })), false);
  }
});

// —— matchRule：price ——

test('price/lte 用于「跌到某价提醒」', () => {
  assert.equal(matchRule(rule('price', 'lte', 1300), item({ price: 1300 })), true);
  assert.equal(matchRule(rule('price', 'lte', 1300), item({ price: 1250 })), true);
  assert.equal(matchRule(rule('price', 'lte', 1300), item({ price: 1350 })), false);
});

test('停牌（price 为 0 / null）时 price 规则不命中', () => {
  // 不排除的话「价格 ≤ 15」这类规则每天开盘前都会命中一次，天天误报
  for (const p of [0, null, undefined, NaN, -1, 'x']) {
    assert.equal(
      matchRule(rule('price', 'lte', 1300), item({ price: p })),
      false,
      `price=${JSON.stringify(p)} 不该命中`
    );
  }
});

test('停牌时 price/gte 同样不命中', () => {
  assert.equal(matchRule(rule('price', 'gte', 1), item({ price: 0 })), false);
});

// —— matchRule：profitPct ——

test('profitPct 用 item.position.profitPct，不自己算', () => {
  // 口径必须与界面一致，重算一遍容易出现「通知说 -5%、界面显示 -4.98%」
  const pos = computePosition({ cost: 1250, shares: 100, price: 1309.22 });
  assert.equal(matchRule(rule('profitPct', 'gte', 4), item({ position: pos })), true);
  assert.equal(matchRule(rule('profitPct', 'gte', 5), item({ position: pos })), false);
  assert.equal(currentValue('profitPct', item({ position: pos })), pos.profitPct);
});

test('未设成本价时 profitPct 规则不命中', () => {
  assert.equal(matchRule(rule('profitPct', 'lte', -10), item({ position: null })), false);
});

test('position 存在但 profitPct 非数字时不命中', () => {
  assert.equal(matchRule(rule('profitPct', 'lte', 0), item({ position: { cost: 1250 } })), false);
});

test('profitPct 亏损方向', () => {
  const pos = computePosition({ cost: 1400, shares: 100, price: 1309.22 });
  assert.equal(matchRule(rule('profitPct', 'lte', -5), item({ position: pos })), true);
  assert.equal(matchRule(rule('profitPct', 'lte', -10), item({ position: pos })), false);
});

// —— matchRule：通用 ——

test('拿不到行情的项（有 error）一律不命中', () => {
  // 硬算会把「无数据」当成「跌到 0」，于是所有跌破规则都会误报
  const broken = item({ error: '无数据', price: null, changePct: null });
  for (const kind of ALERT_KINDS) {
    for (const dir of ALERT_DIRS) {
      assert.equal(matchRule(rule(kind, dir, 0), broken), false, `${kind}/${dir} 不该命中`);
    }
  }
});

test('enabled=false 的规则不命中', () => {
  const r = normalizeRule(rule('changePct', 'gte', 0, { enabled: false }));
  assert.equal(matchRule(r, item({ changePct: 5 })), false);
});

test('matchRule 输入为空时返回 false 而不抛', () => {
  assert.equal(matchRule(null, item()), false);
  assert.equal(matchRule(rule('price', 'gte', 1), null), false);
  assert.equal(matchRule(null, null), false);
});

// —— evaluateAlerts：核心约束 ——

test('evaluateAlerts 遍历整个列表，不只当前选中那只', () => {
  // 这是需求的硬约束：预警的价值就在于盯着你没在看的那些股票
  const { alerts } = evaluateAlerts({
    items: [
      item({ code: 'sh600519', changePct: 6 }),
      item({ code: 'sz000858', name: '五粮液', changePct: 7 }),
      item({ code: 'sh510300', name: '沪深300ETF', changePct: 8 }),
    ],
    rulesByCode: {
      sh600519: [rule('changePct', 'gte', 5)],
      sz000858: [rule('changePct', 'gte', 5)],
      sh510300: [rule('changePct', 'gte', 5)],
    },
    fired: {},
    today: TODAY,
  });
  assert.equal(alerts.length, 3, '三只都该触发');
  assert.deepEqual(alerts.map((a) => a.code).sort(), ['sh510300', 'sh600519', 'sz000858']);
});

test('同一天同一规则只出一次', () => {
  const args = {
    items: [item({ changePct: 6 })],
    rulesByCode: { sh600519: [rule('changePct', 'gte', 5)] },
    fired: {},
    today: TODAY,
  };
  const first = evaluateAlerts(args);
  assert.equal(first.alerts.length, 1);

  // 把上一轮的游标带进来，模拟下一次轮询
  const second = evaluateAlerts({ ...args, fired: first.nextFired });
  assert.equal(second.alerts.length, 0, '当天不该再提醒');
});

test('股价在阈值附近来回穿越也只提醒一次', () => {
  // 盘中每 3 秒轮询，一根横盘的分时能刷出几百条通知
  const rules = { sh600519: [rule('changePct', 'gte', 5)] };
  let fired = {};
  let total = 0;
  for (const pct of [5.1, 4.9, 5.2, 4.8, 5.05, 5.3]) {
    const r = evaluateAlerts({ items: [item({ changePct: pct })], rulesByCode: rules, fired, today: TODAY });
    total += r.alerts.length;
    fired = r.nextFired;
  }
  assert.equal(total, 1, `六次穿越只该提醒一次，实际 ${total} 次`);
});

test('跨天后重新提醒一次', () => {
  const args = {
    items: [item({ changePct: 6 })],
    rulesByCode: { sh600519: [rule('changePct', 'gte', 5)] },
    today: TODAY,
  };
  const day1 = evaluateAlerts({ ...args, fired: {} });
  assert.equal(day1.alerts.length, 1);

  const day2 = evaluateAlerts({ ...args, fired: day1.nextFired, today: '2026-08-14' });
  assert.equal(day2.alerts.length, 1, '次日应重新提醒');
});

test('nextFired 是新对象，不修改传入的 fired（纯函数不变量）', () => {
  const fired = {};
  const r = evaluateAlerts({
    items: [item({ changePct: 6 })],
    rulesByCode: { sh600519: [rule('changePct', 'gte', 5)] },
    fired,
    today: TODAY,
  });
  assert.deepEqual(fired, {}, '传入的对象必须一字不改');
  assert.notEqual(r.nextFired, fired, '应是新对象');
  assert.equal(Object.keys(r.nextFired).length, 1);
});

test('nextFired 保留其它日期的旧条目——由 pruneFired 负责清理，不在这里丢', () => {
  const fired = { 'sh600519|price|gte|9999': '2026-08-01' };
  const r = evaluateAlerts({ items: [item()], rulesByCode: {}, fired, today: TODAY });
  assert.equal(r.nextFired['sh600519|price|gte|9999'], '2026-08-01');
});

test('多只股票同时命中时全部返回', () => {
  const { alerts } = evaluateAlerts({
    items: [item({ code: 'sh600519', changePct: 6, price: 1400 })],
    rulesByCode: { sh600519: [rule('changePct', 'gte', 5), rule('price', 'gte', 1300)] },
    fired: {},
    today: TODAY,
  });
  assert.equal(alerts.length, 2, '同一只股票的两条规则都命中');
});

test('孤儿规则（代码不在 items 里）被忽略且不报错', () => {
  // 用户可能先删股票再加回来，规则留着比丢掉更符合预期
  const r = evaluateAlerts({
    items: [item({ code: 'sh600519', changePct: 0 })],
    rulesByCode: {
      sh600519: [rule('changePct', 'gte', 100)],
      sz000858: [rule('changePct', 'gte', 0)], // 不在 items 里
    },
    fired: {},
    today: TODAY,
  });
  assert.equal(r.alerts.length, 0);
});

test('规则里含非法条目时跳过它，合法的照常生效', () => {
  const { alerts } = evaluateAlerts({
    items: [item({ changePct: 6 })],
    rulesByCode: { sh600519: [{ kind: 'bad' }, rule('changePct', 'gte', 5)] },
    fired: {},
    today: TODAY,
  });
  assert.equal(alerts.length, 1);
});

test('evaluateAlerts 空输入返回空结果而不抛', () => {
  for (const p of [{}, null, undefined, { items: null, rulesByCode: null }]) {
    const r = evaluateAlerts(p);
    assert.deepEqual(r.alerts, []);
    assert.deepEqual(r.nextFired, {});
  }
});

test('没有 code 的 item 被跳过', () => {
  const r = evaluateAlerts({
    items: [{ changePct: 99 }, null],
    rulesByCode: { sh600519: [rule('changePct', 'gte', 0)] },
    fired: {},
    today: TODAY,
  });
  assert.equal(r.alerts.length, 0);
});

test('每条 alert 带 code / ruleKey / rule / title / body', () => {
  const { alerts } = evaluateAlerts({
    items: [item({ changePct: 6 })],
    rulesByCode: { sh600519: [rule('changePct', 'gte', 5)] },
    fired: {},
    today: TODAY,
  });
  const a = alerts[0];
  assert.equal(a.code, 'sh600519');
  assert.ok(a.ruleKey.includes('sh600519'));
  assert.equal(a.rule.kind, 'changePct');
  assert.ok(a.title);
  assert.ok(a.body);
});

test('改了阈值后当天可以再提醒（ruleKey 含 value 的后果）', () => {
  const items = [item({ changePct: 6 })];
  const first = evaluateAlerts({
    items,
    rulesByCode: { sh600519: [rule('changePct', 'gte', 5)] },
    fired: {},
    today: TODAY,
  });
  assert.equal(first.alerts.length, 1);

  // 用户把阈值从 5 改成 5.5，仍然命中 → 算新规则，会再提醒一次
  const second = evaluateAlerts({
    items,
    rulesByCode: { sh600519: [rule('changePct', 'gte', 5.5)] },
    fired: first.nextFired,
    today: TODAY,
  });
  assert.equal(second.alerts.length, 1, '这是有意的行为，需在设置界面说明');
});

// —— formatAlert ——

test('通知标题含名称、现价与涨跌幅', () => {
  const { title } = formatAlert(rule('changePct', 'gte', 5), item({ changePct: 6.12 }));
  assert.match(title, /贵州茅台/);
  assert.match(title, /1309\.22/);
  assert.match(title, /\+6\.12%/);
});

test('通知正文说清当前值与触发的条件——只写「触发预警」用户还得回窗口查', () => {
  const { body } = formatAlert(rule('changePct', 'gte', 5), item({ changePct: 6.12 }));
  assert.match(body, /当前涨跌幅/);
  assert.match(body, /\+6\.12%/, '要有当前值');
  assert.match(body, /≥/, '要有条件符号');
  assert.match(body, /\+5%/, '要有阈值');
});

test('通知文案对价格类规则用价格措辞', () => {
  const { body } = formatAlert(rule('price', 'lte', 1300), item({ price: 1250 }));
  assert.match(body, /当前价格 1250/);
  assert.match(body, /≤ 1300/);
});

test('通知文案对持仓盈亏类规则带 %', () => {
  const pos = computePosition({ cost: 1400, shares: 100, price: 1309.22 });
  const { body } = formatAlert(rule('profitPct', 'lte', -5), item({ position: pos }));
  assert.match(body, /当前持仓盈亏/);
  assert.match(body, /-5%/);
});

test('别名优先于行情名（与界面显示一致）', () => {
  const { title } = formatAlert(rule('price', 'gte', 1), item({ alias: '茅台' }));
  assert.match(title, /茅台/);
  assert.ok(!title.includes('贵州茅台'));
});

test('通知文案不做任何标签拼接', () => {
  // Notification 的 body 不解析 HTML，但这里也不拼标签，
  // 免得将来有人把这段文案塞进 DOM
  const { title, body } = formatAlert(rule('price', 'gte', 1), item({ alias: '<b>x</b>' }));
  assert.ok(!/<\w+>/.test(body), `body 不该含标签：${body}`);
  // 名称里的尖括号原样带出（它是数据不是标记），但没有额外生成任何标签
  assert.match(title, /<b>x<\/b>/);
});

test('formatAlert 在数据缺失时不产出 NaN 或 undefined', () => {
  const { title, body } = formatAlert(rule('price', 'gte', 1), item({ price: null, changePct: null }));
  for (const s of [title, body]) {
    assert.ok(!s.includes('NaN'), `不该含 NaN：${s}`);
    assert.ok(!s.includes('undefined'), `不该含 undefined：${s}`);
  }
});

// —— formatValue / ruleLabel ——

test('formatValue 百分比类带 % 与正号', () => {
  assert.equal(formatValue('changePct', 5), '+5%');
  assert.equal(formatValue('changePct', -5), '-5%');
  assert.equal(formatValue('profitPct', 20), '+20%');
});

test('formatValue 价格类不带 % 也不带正号', () => {
  assert.equal(formatValue('price', 1300), '1300');
  assert.equal(formatValue('price', 1.2345), '1.2345');
});

test('formatValue 去掉无意义的尾随零', () => {
  assert.equal(formatValue('price', 1.23), '1.23');
  assert.equal(formatValue('price', 5), '5');
});

test('ruleLabel 给出人类可读的描述', () => {
  assert.equal(ruleLabel(rule('changePct', 'gte', 5)), '涨跌幅 ≥ +5%');
  assert.equal(ruleLabel(rule('price', 'lte', 1600)), '价格 ≤ 1600');
  assert.equal(ruleLabel(rule('profitPct', 'lte', -10)), '持仓盈亏 ≤ -10%');
});

test('ruleLabel 输入为空时返回空串', () => {
  assert.equal(ruleLabel(null), '');
  assert.equal(ruleLabel(undefined), '');
});

// —— pruneFired ——

test('pruneFired 剔除非今日条目', () => {
  const out = pruneFired(
    { a: '2026-08-13', b: '2026-08-12', c: '2026-08-13', d: '2026-07-01' },
    '2026-08-13'
  );
  assert.deepEqual(out, { a: '2026-08-13', c: '2026-08-13' });
});

test('pruneFired 全是旧条目时返回空对象——跨天自动重置靠它', () => {
  assert.deepEqual(pruneFired({ a: '2026-08-01' }, '2026-08-13'), {});
});

test('pruneFired 空输入返回空对象', () => {
  for (const bad of [null, undefined, 'x', 42, []]) {
    assert.deepEqual(pruneFired(bad, TODAY), {}, `pruneFired(${JSON.stringify(bad)})`);
  }
});

test('pruneFired 防止 fired 无限增长', () => {
  // 用户改过很多次阈值的话，历史键会一直累积
  const big = {};
  for (let i = 0; i < 500; i += 1) big[`k${i}`] = '2026-01-01';
  big.today = TODAY;
  assert.deepEqual(pruneFired(big, TODAY), { today: TODAY });
});

// —— normalizeRulesByCode ——

test('normalizeRulesByCode 逐个代码规范化', () => {
  const out = normalizeRulesByCode({
    sh600519: [rule('changePct', 'gte', 5)],
    sz000858: [rule('price', 'lte', 100)],
  });
  assert.deepEqual(Object.keys(out).sort(), ['sh600519', 'sz000858']);
});

test('normalizeRulesByCode 删掉空规则数组的键——否则配置文件单调膨胀', () => {
  const out = normalizeRulesByCode({
    sh600519: [rule('changePct', 'gte', 5)],
    sz000858: [],
    sz300750: [{ kind: 'bad' }], // 全部非法 → 空
  });
  assert.deepEqual(Object.keys(out), ['sh600519']);
});

test('normalizeRulesByCode 非对象输入返回空对象', () => {
  for (const bad of [null, undefined, 'x', 42, []]) {
    assert.deepEqual(normalizeRulesByCode(bad), {}, `输入 ${JSON.stringify(bad)}`);
  }
});

// —— 综合场景 ——

test('综合：三只股票各设不同规则，只有该触发的触发', () => {
  const pos = computePosition({ cost: 1400, shares: 100, price: 1309.22 });
  const r = evaluateAlerts({
    items: [
      item({ code: 'sh600519', changePct: 0.95, price: 1309.22, position: pos }),
      item({ code: 'sz000858', name: '五粮液', changePct: -6.2, price: 142.5 }),
      item({ code: 'sh510300', name: '沪深300ETF', changePct: 0.3, price: 4.02, error: '' }),
    ],
    rulesByCode: {
      // 盈亏 ≤ -5% → 命中（实际 -6.48%）；涨幅 ≥ 5% → 不命中（0.95%）
      sh600519: [rule('profitPct', 'lte', -5), rule('changePct', 'gte', 5)],
      // 跌幅 ≤ -5% → 命中（-6.2%）
      sz000858: [rule('changePct', 'lte', -5)],
      // 价格 ≤ 3.5 → 不命中（4.02）
      sh510300: [rule('price', 'lte', 3.5)],
    },
    fired: {},
    today: TODAY,
  });

  assert.equal(r.alerts.length, 2);
  assert.deepEqual(r.alerts.map((a) => a.code).sort(), ['sh600519', 'sz000858']);
  assert.equal(r.alerts.find((a) => a.code === 'sh600519').rule.kind, 'profitPct');
});

test('综合：一整天的轮询序列，各条规则各提醒一次', () => {
  // 注意每条规则用不同的 kind|dir 组合：同组合会被 normalizeRules 去重，
  // 「涨幅≥3% 与 涨幅≥6% 并存」是表达不了的（见上面那条去重测试）。
  // 想要多档阈值得靠不同维度，这正是 340px 界面下的实际用法
  const rules = {
    sh600519: [
      rule('changePct', 'gte', 3), // 涨幅上破
      rule('changePct', 'lte', -3), // 跌幅下破
      rule('price', 'gte', 1400), // 价格上破
    ],
  };
  let fired = {};
  const got = [];
  // 一天的行情：先冲高破 3% 与 1400，再翻绿跌破 -3%
  const ticks = [
    { changePct: 1, price: 1320 },
    { changePct: 3.1, price: 1345 }, // 破涨幅
    { changePct: 4, price: 1360 },
    { changePct: 6, price: 1405 }, // 破价格
    { changePct: 2, price: 1330 },
    { changePct: -3.5, price: 1260 }, // 破跌幅
    { changePct: -4, price: 1250 },
  ];
  for (const t of ticks) {
    const r = evaluateAlerts({ items: [item(t)], rulesByCode: rules, fired, today: TODAY });
    for (const a of r.alerts) got.push(`${a.rule.kind}/${a.rule.dir}`);
    fired = r.nextFired;
  }
  assert.deepEqual(
    got,
    ['changePct/gte', 'price/gte', 'changePct/lte'],
    '三条规则各在首次触发时提醒一次，且按触发顺序'
  );
});

test('综合：同一 kind+dir 想要多档阈值时，只有最后一条生效', () => {
  // 把上一条测试踩到的那个设计约束单独钉住：这是 normalizeRules 的去重语义，
  // 不是 bug。用户在设置界面填两条「涨幅≥」时，只有后填的那条留下
  const r = evaluateAlerts({
    items: [item({ changePct: 4 })],
    rulesByCode: { sh600519: [rule('changePct', 'gte', 3), rule('changePct', 'gte', 6)] },
    fired: {},
    today: TODAY,
  });
  assert.equal(r.alerts.length, 0, '只剩「≥6%」那条，4% 不命中');
});
