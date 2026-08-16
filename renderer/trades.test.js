'use strict';

/**
 * renderer/trades.js 的单测。
 *
 * DOM 桩与 listview.test.js 那份同源，同样**不实现 innerHTML** ——
 * 真有人改成拼 innerHTML 就会抛 TypeError，比写断言更强的保证。
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  renderTradeList,
  tradeRow,
  tradeRowTitle,
  renderRealizedRow,
  renderTradeEditor,
  holdingSourceHint,
  tradeHint,
  trFmtPrice,
  trFmtShares,
  trFmtMoney,
  trFmtDate,
  trSideLabel,
  trSignClass,
} = require('./trades');

const { replayTrades } = require('../src/trades');

// —— DOM 桩 ——

class El {
  constructor(doc, tag) {
    this.ownerDocument = doc;
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.className = '';
    this.style = {};
    this.dataset = {};
    this._text = '';
    this._attrs = {};
    this.title = '';
    this.type = '';
  }

  get classList() {
    const self = this;
    return {
      add(...names) {
        const cur = String(self.className).split(/\s+/).filter(Boolean);
        for (const n of names) if (!cur.includes(n)) cur.push(n);
        self.className = cur.join(' ');
      },
      contains(name) {
        return String(self.className).split(/\s+/).includes(name);
      },
    };
  }

  setAttribute(k, v) {
    this._attrs[k] = String(v);
  }
  getAttribute(k) {
    return this._attrs[k];
  }
  addEventListener(type, handler) {
    this._listeners = this._listeners || {};
    (this._listeners[type] = this._listeners[type] || []).push(handler);
  }
  fire(type) {
    for (const fn of (this._listeners && this._listeners[type]) || []) fn();
  }
  appendChild(child) {
    this.children.push(child);
    return child;
  }
  append(...kids) {
    for (const k of kids) this.appendChild(k);
  }
  set textContent(v) {
    this.children = [];
    this._text = String(v);
  }
  get textContent() {
    if (this.children.length === 0) return this._text;
    return this.children.map((c) => c.textContent).join('');
  }
  findAll(cls) {
    const out = [];
    const walk = (node) => {
      for (const c of node.children) {
        if (String(c.className).split(/\s+/).includes(cls)) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }
  find(cls) {
    return this.findAll(cls)[0] || null;
  }
}

function fakeDoc() {
  const doc = { createElement: (tag) => new El(doc, tag) };
  return doc;
}

function newBox() {
  return fakeDoc().createElement('div');
}

function buy(date, price, shares) {
  return { date, side: 'buy', price, shares };
}
function sell(date, price, shares) {
  return { date, side: 'sell', price, shares };
}

/** 造一份带 id 的回放结果，模拟真实数据流 */
function lotsOf(...trades) {
  const withIds = trades.map((t, i) => ({ ...t, id: `t${i}` }));
  return replayTrades(withIds).lots;
}

// —— 格式化 ——

test('trFmtPrice 去掉无意义的尾随零', () => {
  assert.equal(trFmtPrice(1620.5), '1620.5');
  assert.equal(trFmtPrice(1.2345), '1.2345');
  assert.equal(trFmtPrice(100), '100');
  assert.equal(trFmtPrice(null), '--');
});

test('trFmtShares 整数不带小数点，小数份额保留两位', () => {
  assert.equal(trFmtShares(100), '100');
  assert.equal(trFmtShares(1234.56), '1234.56');
  assert.equal(trFmtShares(null), '--');
});

test('trFmtMoney 带符号，万/亿分档', () => {
  assert.equal(trFmtMoney(3590), '+3590.00');
  assert.equal(trFmtMoney(-5000), '-5000.00');
  assert.equal(trFmtMoney(12500000), '+1250.0万');
  assert.equal(trFmtMoney(0), '0.00');
  assert.equal(trFmtMoney(null), '--');
});

test('trFmtDate 只留月-日', () => {
  assert.equal(trFmtDate('2026-03-14'), '03-14');
  assert.equal(trFmtDate(''), '');
  assert.equal(trFmtDate(null), '');
});

test('trSideLabel 用单字——一行里要塞四项信息', () => {
  assert.equal(trSideLabel('buy'), '买');
  assert.equal(trSideLabel('sell'), '卖');
  assert.equal(trSideLabel('garbage'), '买', '未知方向按买入处理');
});

test('trSignClass 正红负绿零灰', () => {
  assert.equal(trSignClass(1), 'up');
  assert.equal(trSignClass(-1), 'down');
  assert.equal(trSignClass(0), 'flat');
  assert.equal(trSignClass(null), 'flat');
});

// —— renderTradeList ——

test('渲染 N 笔流水产出 N 行', () => {
  const box = newBox();
  renderTradeList(box, lotsOf(buy('2026-03-14', 100, 10), buy('2026-04-01', 110, 10), sell('2026-05-01', 120, 5)));
  assert.equal(box.findAll('trade-row').length, 3);
});

test('空流水给出空态提示', () => {
  const box = newBox();
  renderTradeList(box, []);
  assert.equal(box.findAll('trade-row').length, 0);
  assert.match(box.textContent, /还没有交易记录/);
});

test('lots 非数组时按空处理，不抛错', () => {
  for (const bad of [null, undefined, 'x', 42, {}]) {
    const box = newBox();
    renderTradeList(box, bad);
    assert.match(box.textContent, /还没有交易记录/, `lots=${JSON.stringify(bad)}`);
  }
});

test('流水倒序显示——最近的操作在最上面', () => {
  const box = newBox();
  renderTradeList(box, lotsOf(buy('2026-03-14', 100, 10), buy('2026-08-01', 200, 10)));
  const dates = box.findAll('trade-date').map((e) => e.textContent);
  assert.deepEqual(dates, ['08-01', '03-14']);
});

test('渲染不修改传入的 lots 数组（倒序是复制而非原地反转）', () => {
  const lots = lotsOf(buy('2026-03-14', 100, 10), buy('2026-08-01', 200, 10));
  const before = lots.map((l) => l.date);
  renderTradeList(newBox(), lots);
  assert.deepEqual(lots.map((l) => l.date), before, '原数组顺序必须不变');
});

test('重画会清掉旧内容', () => {
  const box = newBox();
  renderTradeList(box, lotsOf(buy('2026-03-14', 100, 10), buy('2026-04-01', 110, 10)));
  assert.equal(box.findAll('trade-row').length, 2);
  renderTradeList(box, lotsOf(buy('2026-03-14', 100, 10)));
  assert.equal(box.findAll('trade-row').length, 1);
});

test('oversold 时在顶部给出警告——问题出在整串流水的关系上，指不到具体某笔', () => {
  const box = newBox();
  const s = replayTrades([buy('2026-03-14', 100, 50), sell('2026-04-01', 110, 80)]);
  assert.equal(s.oversold, true);
  renderTradeList(box, s.lots, { oversold: s.oversold });
  assert.ok(box.find('trade-warn'), '应有警告元素');
  assert.match(box.textContent, /漏记了买入/);
});

test('正常流水不出 oversold 警告', () => {
  const box = newBox();
  const s = replayTrades([buy('2026-03-14', 100, 50), sell('2026-04-01', 110, 50)]);
  renderTradeList(box, s.lots, { oversold: s.oversold });
  assert.equal(box.find('trade-warn'), null);
});

// —— tradeRow ——

test('一行含日期、方向、成交（价格×数量）', () => {
  const row = tradeRow(fakeDoc(), { date: '2026-03-14', side: 'buy', price: 1620.5, shares: 100 });
  assert.equal(row.find('trade-date').textContent, '03-14');
  assert.equal(row.find('trade-side').textContent, '买');
  assert.equal(row.find('trade-deal').textContent, '1620.5 × 100');
});

test('买入行不显示已实现盈亏——买入恒为 0，显示 0 会让人以为「这笔白做了」', () => {
  const lots = lotsOf(buy('2026-03-14', 100, 100));
  const row = tradeRow(fakeDoc(), lots[0]);
  assert.equal(row.find('trade-realized'), null);
});

test('卖出行显示已实现盈亏并染色', () => {
  const lots = lotsOf(buy('2026-03-14', 100, 100), sell('2026-04-01', 120, 50));
  const row = tradeRow(fakeDoc(), lots[1]);
  const realized = row.find('trade-realized');
  assert.ok(realized);
  assert.equal(realized.textContent, '+1000.00');
  assert.ok(realized.className.includes('up'));
});

test('亏损卖出染 down 色', () => {
  const lots = lotsOf(buy('2026-03-14', 100, 100), sell('2026-04-01', 90, 50));
  const row = tradeRow(fakeDoc(), lots[1]);
  assert.ok(row.find('trade-realized').className.includes('down'));
});

test('已实现恰好为 0 的卖出不显示金额（不占地方）', () => {
  const lots = lotsOf(buy('2026-03-14', 100, 100), sell('2026-04-01', 100, 50));
  const row = tradeRow(fakeDoc(), lots[1]);
  assert.equal(row.find('trade-realized'), null);
});

test('行上带买卖方向的类名，供 CSS 区分配色', () => {
  const b = tradeRow(fakeDoc(), buy('2026-03-14', 100, 10));
  const s = tradeRow(fakeDoc(), sell('2026-03-14', 100, 10));
  assert.ok(b.classList.contains('is-buy'));
  assert.ok(s.classList.contains('is-sell'));
});

test('传了 onRemove 时出删除按钮，点击回传 id', () => {
  let removed = null;
  const row = tradeRow(fakeDoc(), { ...buy('2026-03-14', 100, 10), id: 'abc' }, {
    onRemove: (id) => {
      removed = id;
    },
  });
  const del = row.find('trade-remove');
  assert.ok(del);
  del.fire('click');
  assert.equal(removed, 'abc');
});

test('没有 id 的条目不出删除按钮——删不掉的按钮不该出现', () => {
  const row = tradeRow(fakeDoc(), buy('2026-03-14', 100, 10), { onRemove: () => {} });
  assert.equal(row.find('trade-remove'), null);
});

test('未传 onRemove 时不出删除按钮', () => {
  const row = tradeRow(fakeDoc(), { ...buy('2026-03-14', 100, 10), id: 'abc' }, {});
  assert.equal(row.find('trade-remove'), null);
});

// —— tradeRowTitle ——

test('title 补上「这笔之后持仓变成多少」——这是流水列表真正的价值', () => {
  const lots = lotsOf(buy('2026-03-14', 100, 100), buy('2026-04-01', 200, 100));
  const t = tradeRowTitle(lots[1]);
  assert.match(t, /此后持仓 200/);
  assert.match(t, /成本 150/, '两笔加权后成本 150');
});

test('清仓那笔的 title 说「此后已清仓」', () => {
  const lots = lotsOf(buy('2026-03-14', 100, 100), sell('2026-04-01', 120, 100));
  assert.match(tradeRowTitle(lots[1]), /此后已清仓/);
});

test('卖出的 title 含本笔已实现', () => {
  const lots = lotsOf(buy('2026-03-14', 100, 100), sell('2026-04-01', 120, 50));
  assert.match(tradeRowTitle(lots[1]), /本笔已实现 \+1000\.00/);
});

test('tradeRowTitle 输入为空时返回空串', () => {
  assert.equal(tradeRowTitle(null), '');
  assert.equal(typeof tradeRowTitle({}), 'string');
});

// —— renderRealizedRow ——

test('有流水时显示已实现金额', () => {
  const box = newBox();
  renderRealizedRow(box, { total: 3590, hasTrades: true, byMonth: {} }, { range: 'all' });
  assert.equal(box.find('realized-value').textContent, '+3590.00');
  assert.match(box.find('realized-label').textContent, /已实现/);
});

test('无流水时整行隐藏——显示「已实现 0.00」纯属占地方', () => {
  const box = newBox();
  renderRealizedRow(box, { total: 0, hasTrades: false });
  assert.ok(box.className.includes('hidden'));
  assert.equal(box.children.length, 0);
});

test('data 为空时整行隐藏', () => {
  const box = newBox();
  renderRealizedRow(box, null);
  assert.ok(box.className.includes('hidden'));
});

test('重画会去掉 hidden——从无流水变有流水时要能重新出现', () => {
  const box = newBox();
  renderRealizedRow(box, null);
  assert.ok(box.className.includes('hidden'));
  renderRealizedRow(box, { total: 100, hasTrades: true });
  assert.ok(!box.className.includes('hidden'));
});

test('亏损时染 down 色', () => {
  const box = newBox();
  renderRealizedRow(box, { total: -5000, hasTrades: true });
  assert.ok(box.find('realized-value').className.includes('down'));
});

test('两个区间 chip，当前区间高亮', () => {
  const box = newBox();
  renderRealizedRow(box, { total: 100, hasTrades: true }, { range: 'month' });
  const chips = box.findAll('realized-chip');
  assert.equal(chips.length, 2);
  const monthChip = chips.find((c) => c.dataset.range === 'month');
  const allChip = chips.find((c) => c.dataset.range === 'all');
  assert.ok(monthChip.className.includes('on'));
  assert.ok(!allChip.className.includes('on'));
});

test('点击区间 chip 回传 range', () => {
  const box = newBox();
  const got = [];
  renderRealizedRow(box, { total: 100, hasTrades: true }, { range: 'all', onRange: (r) => got.push(r) });
  for (const c of box.findAll('realized-chip')) c.fire('click');
  assert.deepEqual(got, ['month', 'all']);
});

test('未知 range 按 all 处理', () => {
  const box = newBox();
  renderRealizedRow(box, { total: 100, hasTrades: true }, { range: 'garbage' });
  const allChip = box.findAll('realized-chip').find((c) => c.dataset.range === 'all');
  assert.ok(allChip.className.includes('on'));
});

test('title 说清口径——用户拿这个数对券商 App 一定对不上', () => {
  const box = newBox();
  renderRealizedRow(box, { total: 100, hasTrades: true });
  assert.match(box.title, /加权平均成本法/);
  assert.match(box.title, /不含手续费/);
});

// —— renderTradeEditor ——

test('编辑区渲染已有流水', () => {
  const box = newBox();
  renderTradeEditor(box, [
    { ...buy('2026-03-14', 100, 10), id: 'a' },
    { ...sell('2026-04-01', 120, 5), id: 'b' },
  ]);
  assert.equal(box.findAll('trade-edit-row').length, 2);
});

test('编辑区空列表给出引导文字', () => {
  const box = newBox();
  renderTradeEditor(box, []);
  assert.match(box.textContent, /添加第一笔/);
});

test('编辑区倒序显示，与详情区一致', () => {
  const box = newBox();
  renderTradeEditor(box, [
    { ...buy('2026-03-14', 100, 10), id: 'a' },
    { ...buy('2026-08-01', 200, 10), id: 'b' },
  ]);
  const dates = box.findAll('trade-date').map((e) => e.textContent);
  assert.deepEqual(dates, ['08-01', '03-14']);
});

test('读流水失败时显示错误而不是空列表——空列表会让人以为流水丢了', () => {
  const box = newBox();
  renderTradeEditor(box, [], { error: '流水文件无法解析' });
  assert.ok(box.find('error-box'));
  assert.match(box.textContent, /无法解析/);
  assert.equal(box.findAll('trade-edit-row').length, 0);
});

test('编辑区的删除按钮回传 id', () => {
  const box = newBox();
  let removed = null;
  renderTradeEditor(box, [{ ...buy('2026-03-14', 100, 10), id: 'abc' }], {
    onRemove: (id) => {
      removed = id;
    },
  });
  box.find('watch-remove').fire('click');
  assert.equal(removed, 'abc');
});

// —— holdingSourceHint ——

test('有持仓的流水给出「由流水推导」提示', () => {
  // 有流水时手填的成本价输入框会被忽略，必须说出来，
  // 否则用户改了输入框发现盈亏没变会以为是 bug
  const s = replayTrades([buy('2026-03-14', 1620.5, 100), buy('2026-05-20', 1700, 100)]);
  const hint = holdingSourceHint(s);
  assert.match(hint, /由流水推导/);
  assert.match(hint, /200/);
  assert.match(hint, /1660\.25/);
});

test('已清仓时提示不显示浮动盈亏', () => {
  const s = replayTrades([buy('2026-03-14', 100, 100), sell('2026-04-01', 120, 100)]);
  assert.match(holdingSourceHint(s), /已清仓/);
});

test('无流水时不给提示（此时手填值生效，没什么要解释的）', () => {
  assert.equal(holdingSourceHint(replayTrades([])), '');
  assert.equal(holdingSourceHint(null), '');
});

// —— tradeHint ——

test('有已实现盈亏时摘要给金额', () => {
  const s = replayTrades([buy('2026-03-14', 100, 100), sell('2026-04-01', 120, 50)]);
  assert.match(tradeHint(s), /已实现 \+1000\.00/);
});

test('只有买入时摘要给笔数', () => {
  const s = replayTrades([buy('2026-03-14', 100, 100), buy('2026-04-01', 110, 100)]);
  assert.equal(tradeHint(s), '2 笔');
});

test('无流水时摘要为空', () => {
  assert.equal(tradeHint(replayTrades([])), '');
  assert.equal(tradeHint(null), '');
});

// —— 安全约定 ——

test('第三方与用户输入都走 textContent，绝不拼 innerHTML', () => {
  // DOM 桩没有 innerHTML：真有人改成拼 innerHTML 就会抛 TypeError。
  // 流水是用户自己输的，但仍按不可信处理——它会被写进文件再读回来
  const box = newBox();
  renderTradeEditor(box, [{ date: '2026-03-14', side: '<script>x</script>', price: 100, shares: 10, id: 'a' }]);
  const side = box.find('trade-side');
  assert.equal(side.textContent, '买', '未知方向按买入处理，恶意字符串不会进 DOM');
  assert.equal(side.children.length, 0);
});
