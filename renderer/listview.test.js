'use strict';

/**
 * listview.js 的单测。
 *
 * DOM 桩与 groups.test.js 那份同源（项目没有 jsdom，devDeps 只有 electron）。
 * 刻意**不实现 innerHTML**：本项目的安全约定是第三方文本一律走 textContent，
 * 真有人改成拼 innerHTML 就会在这里抛 TypeError —— 比写一条断言更强的保证，
 * 因为断言只覆盖被断言的那个元素，而缺失的属性覆盖所有元素。
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  renderList,
  listRow,
  listRowTitle,
  listNameText,
  renderListSummary,
  listFmtPrice,
  listFmtPct,
  listFmtMoney,
  listDirClass,
} = require('./listview');

// —— DOM 桩 ——

class El {
  constructor(doc, tag) {
    this.ownerDocument = doc;
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.className = '';
    this.style = {};
    this._text = '';
    this._attrs = {};
    this.title = '';
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

/** 一个正常的 collectWatchlist item */
function item(over = {}) {
  return {
    code: 'sh600519',
    digits: '600519',
    kind: 'stock',
    isFund: false,
    alias: '',
    name: '贵州茅台',
    realName: '贵州茅台',
    price: 1309.22,
    change: 12.3,
    changePct: 0.95,
    cost: null,
    shares: null,
    position: null,
    ...over,
  };
}

/** 带持仓的 item（position 形如 computePosition 的结果） */
function heldItem(over = {}) {
  return item({
    cost: 1250,
    shares: 100,
    position: {
      cost: 1250,
      shares: 100,
      profitPerShare: 59.22,
      profitPct: 4.74,
      hasAmount: true,
      costValue: 125000,
      marketValue: 130922,
      profit: 5922,
      todayProfit: 1230,
    },
    ...over,
  });
}

// —— 格式化 ——

test('listFmtPrice 保留 2 位小数，非数字给 --', () => {
  assert.equal(listFmtPrice(1309.22), '1309.22');
  assert.equal(listFmtPrice(4.2), '4.20');
  assert.equal(listFmtPrice(0), '0.00');
  for (const bad of [null, undefined, NaN, 'abc', Infinity]) {
    assert.equal(listFmtPrice(bad), '--', `listFmtPrice(${JSON.stringify(bad)})`);
  }
});

test('listFmtPct 正数带 +，负数带 -，零不带符号', () => {
  assert.equal(listFmtPct(0.95), '+0.95%');
  assert.equal(listFmtPct(-1.23), '-1.23%');
  assert.equal(listFmtPct(0), '0.00%');
  assert.equal(listFmtPct(null), '--');
});

test('listDirClass 红涨绿跌零灰', () => {
  assert.equal(listDirClass(1), 'up');
  assert.equal(listDirClass(-1), 'down');
  assert.equal(listDirClass(0), 'flat');
  // 拿不到涨跌额时不该染成绿色（那看着像在跌）
  assert.equal(listDirClass(null), 'flat');
  assert.equal(listDirClass(NaN), 'flat');
});

test('listFmtMoney 亿/万/元三档带符号', () => {
  assert.equal(listFmtMoney(5922), '+5922.00');
  assert.equal(listFmtMoney(-5922), '-5922.00');
  assert.equal(listFmtMoney(12500000), '+1250.0万');
  assert.equal(listFmtMoney(-250000000), '-2.50亿');
  assert.equal(listFmtMoney(0), '0.00');
  assert.equal(listFmtMoney(null), '--');
});

// —— listNameText ——

test('listNameText 优先级：别名 > 行情名 > 代码', () => {
  assert.equal(listNameText(item({ alias: '茅台' })), '茅台');
  assert.equal(listNameText(item({ alias: '' })), '贵州茅台');
  assert.equal(listNameText(item({ alias: '', name: '' })), '600519');
  assert.equal(listNameText(item({ alias: '', name: '', digits: '' })), 'sh600519');
});

test('listNameText 输入为空时不抛错', () => {
  assert.equal(listNameText(null), '--');
  assert.equal(listNameText(undefined), '--');
  assert.equal(listNameText({}), '--');
});

test('listNameText 不做字符截断——交给 CSS ellipsis', () => {
  // 在 JS 里按字符数截会在中英混排时算错宽度：「贵州茅台」4 字比
  // "GuizhouMoutai" 13 字更宽。CSS 按实际渲染宽度截，永远准
  const long = '超级超级超级长的一个股票名称测试用';
  assert.equal(listNameText(item({ alias: long })), long);
});

// —— renderList ——

test('渲染 N 条数据产出 N 行', () => {
  const box = newBox();
  renderList(box, [item(), item({ code: 'sz000858', name: '五粮液' }), item({ code: 'sh510300' })]);
  assert.equal(box.findAll('list-row').length, 3);
});

test('空列表给出空态提示而非零行', () => {
  const box = newBox();
  renderList(box, []);
  assert.equal(box.findAll('list-row').length, 0);
  assert.ok(box.find('list-empty'), '应有空态元素');
  assert.match(box.textContent, /还没有关注的股票/);
});

test('items 非数组时按空列表处理，不抛错', () => {
  for (const bad of [null, undefined, 'abc', 42, {}]) {
    const box = newBox();
    renderList(box, bad);
    assert.ok(box.find('list-empty'), `items=${JSON.stringify(bad)}`);
  }
});

test('renderList 重画会清掉旧内容', () => {
  const box = newBox();
  renderList(box, [item(), item({ code: 'sz000858' })]);
  assert.equal(box.findAll('list-row').length, 2);
  renderList(box, [item()]);
  assert.equal(box.findAll('list-row').length, 1, '旧的两行必须被清掉');
});

// —— listRow：基本内容 ——

test('一行包含名称、现价、涨跌幅', () => {
  const row = listRow(fakeDoc(), item());
  assert.equal(row.find('list-name').textContent, '贵州茅台');
  assert.equal(row.find('list-price').textContent, '1309.22');
  assert.equal(row.find('list-pct').textContent, '+0.95%');
});

test('上涨时价格与涨跌幅同为 up 类', () => {
  const row = listRow(fakeDoc(), item({ change: 12.3, changePct: 0.95 }));
  assert.ok(row.find('list-price').className.includes('up'));
  assert.ok(row.find('list-pct').className.includes('up'));
});

test('下跌时同为 down 类', () => {
  const row = listRow(fakeDoc(), item({ change: -12.3, changePct: -0.95 }));
  assert.ok(row.find('list-price').className.includes('down'));
  assert.ok(row.find('list-pct').className.includes('down'));
});

test('染色按 change 而非 changePct——两者符号理论上一致，但以涨跌额为准', () => {
  // 与 renderer.js 的 renderQuote 保持同一口径（那边也是 dirClass(q.change)）
  const row = listRow(fakeDoc(), item({ change: 0, changePct: 0 }));
  assert.ok(row.find('list-price').className.includes('flat'));
});

// —— listRow：错误项 ——

test('拿不到行情时显示错误文字，而不是两个 --', () => {
  // 摆两个 '--' 会让人以为在停牌，实际是接口挂了
  const row = listRow(fakeDoc(), item({ error: '无数据', price: null, changePct: null }));
  assert.equal(row.find('list-error').textContent, '无数据');
  assert.equal(row.find('list-price'), null, '错误项不该有价格元素');
  assert.equal(row.find('list-pct'), null);
});

test('错误项不产出 NaN', () => {
  const row = listRow(fakeDoc(), item({ error: 'HTTP 500', price: NaN, changePct: NaN }));
  assert.ok(!row.textContent.includes('NaN'), `不该含 NaN：${row.textContent}`);
});

// —— listRow：持仓徽标 ——

test('设了成本价时出持仓徽标', () => {
  const row = listRow(fakeDoc(), heldItem());
  const hold = row.find('list-hold');
  assert.ok(hold, '应有持仓徽标');
  assert.equal(hold.textContent, '持+4.74%');
  assert.ok(hold.className.includes('up'));
});

test('未设持仓时不出徽标——一堆占位符比不显示更干扰', () => {
  const row = listRow(fakeDoc(), item({ position: null }));
  assert.equal(row.find('list-hold'), null);
  assert.ok(!row.classList.contains('has-hold'));
});

test('有徽标时行上打 has-hold 标记，供 CSS 收紧名称宽度', () => {
  const row = listRow(fakeDoc(), heldItem());
  assert.ok(row.classList.contains('has-hold'));
});

test('持仓亏损时徽标为 down 类', () => {
  const row = listRow(fakeDoc(), heldItem({ position: { cost: 1400, profitPct: -6.48, hasAmount: false } }));
  assert.ok(row.find('list-hold').className.includes('down'));
});

test('position 存在但 profitPct 非数字时不出徽标', () => {
  // computePosition 不会产出这种形状，但配置手改过或旧版本数据可能，
  // 出一个「持--%」的徽标不如不出
  const row = listRow(fakeDoc(), item({ position: { cost: 1250, profitPct: null } }));
  assert.equal(row.find('list-hold'), null);
});

test('徽标在名称之后、价格之前——出现与消失不推动右侧数字', () => {
  const row = listRow(fakeDoc(), heldItem());
  const classes = row.children.map((c) => c.className.split(/\s+/)[0]);
  assert.deepEqual(classes, ['list-name', 'list-hold', 'list-price', 'list-pct']);
});

// —— listRow：选中态与点击 ——

test('选中项带 active 类与 aria-selected', () => {
  const row = listRow(fakeDoc(), item(), { selected: 'sh600519' });
  assert.ok(row.classList.contains('active'));
  assert.equal(row.getAttribute('aria-selected'), 'true');
});

test('非选中项不带 active', () => {
  const row = listRow(fakeDoc(), item(), { selected: 'sz000858' });
  assert.ok(!row.classList.contains('active'));
  assert.equal(row.getAttribute('aria-selected'), 'false');
});

test('未传 selected 时所有行都不是选中态', () => {
  const row = listRow(fakeDoc(), item(), {});
  assert.ok(!row.classList.contains('active'));
});

test('点击行触发 onPick 且传对 code', () => {
  let picked = null;
  const row = listRow(fakeDoc(), item({ code: 'sz000858' }), {
    onPick: (code) => {
      picked = code;
    },
  });
  assert.ok(row.classList.contains('is-clickable'));
  row.fire('click');
  assert.equal(picked, 'sz000858');
});

test('未传 onPick 时行不可点击——列表模式的唯一出口就是点行，但渲染层可能还没接好', () => {
  const row = listRow(fakeDoc(), item(), {});
  assert.ok(!row.classList.contains('is-clickable'));
  row.fire('click'); // 不该抛错
});

test('错误项同样可点击——切过去看详情才能知道到底怎么了', () => {
  let picked = null;
  const row = listRow(fakeDoc(), item({ error: '无数据' }), { onPick: (c) => (picked = c) });
  row.fire('click');
  assert.equal(picked, 'sh600519');
});

test('renderList 把 selected 与 onPick 透传到每一行', () => {
  const box = newBox();
  const picks = [];
  renderList(box, [item(), item({ code: 'sz000858' })], {
    selected: 'sz000858',
    onPick: (c) => picks.push(c),
  });
  const rows = box.findAll('list-row');
  assert.ok(!rows[0].classList.contains('active'));
  assert.ok(rows[1].classList.contains('active'));
  rows[0].fire('click');
  assert.deepEqual(picks, ['sh600519']);
});

// —— listRowTitle ——

test('title 含名称、代码、价格与涨跌幅', () => {
  const t = listRowTitle(item());
  assert.match(t, /贵州茅台/);
  assert.match(t, /600519/);
  assert.match(t, /1309\.22/);
  assert.match(t, /\+0\.95%/);
});

test('title 在有持仓时补上成本与盈亏金额', () => {
  const t = listRowTitle(heldItem());
  assert.match(t, /成本 1250\.00/);
  assert.match(t, /盈亏 \+5922\.00/);
});

test('只填成本价（无数量）时 title 不写金额', () => {
  const t = listRowTitle(item({ position: { cost: 1250, profitPct: 4.74, hasAmount: false } }));
  assert.match(t, /成本 1250\.00/);
  assert.ok(!t.includes('盈亏'), `无数量时算不出金额，不该出现「盈亏」：${t}`);
});

test('错误项的 title 说明错误，不摆价格', () => {
  const t = listRowTitle(item({ error: '请求超时（12000ms）', price: null }));
  assert.match(t, /请求超时/);
  assert.ok(!t.includes('价 '), `错误项不该显示价格：${t}`);
});

test('listRowTitle 输入为空时不抛错', () => {
  assert.equal(listRowTitle(null), '');
  assert.equal(typeof listRowTitle({}), 'string');
});

// —— renderListSummary ——

test('有持仓汇总时显示条数、金额与比例', () => {
  const box = newBox();
  renderListSummary(box, {
    counted: 2,
    costValue: 145000,
    marketValue: 152000,
    profit: 7000,
    profitPct: 4.83,
    todayProfit: 1230,
  });
  assert.match(box.find('list-summary-label').textContent, /持仓 \(2\)/);
  assert.equal(box.find('list-summary-profit').textContent, '+7000.00');
  assert.equal(box.find('list-summary-pct').textContent, '+4.83%');
});

test('无持仓时汇总行整体隐藏', () => {
  const box = newBox();
  renderListSummary(box, null);
  assert.ok(box.className.includes('hidden'));
  assert.equal(box.children.length, 0);
});

test('汇总行重画会先清掉 hidden——从无持仓变有持仓时要能重新出现', () => {
  const box = newBox();
  renderListSummary(box, null);
  assert.ok(box.className.includes('hidden'));
  renderListSummary(box, { counted: 1, costValue: 1000, marketValue: 1100, profit: 100, profitPct: 10 });
  assert.ok(!box.className.includes('hidden'), '有持仓时必须去掉 hidden');
});

test('汇总亏损时染 down 色', () => {
  const box = newBox();
  renderListSummary(box, { counted: 1, costValue: 1000, marketValue: 900, profit: -100, profitPct: -10 });
  assert.ok(box.find('list-summary-profit').className.includes('down'));
  assert.ok(box.find('list-summary-pct').className.includes('down'));
});

test('汇总 title 含成本、市值、盈亏；有当日盈亏时一并列出', () => {
  const box = newBox();
  renderListSummary(box, {
    counted: 2,
    costValue: 145000,
    marketValue: 152000,
    profit: 7000,
    profitPct: 4.83,
    todayProfit: 1230,
  });
  assert.match(box.title, /总成本/);
  assert.match(box.title, /总市值/);
  assert.match(box.title, /当日盈亏/);
});

test('汇总无当日盈亏时 title 不提它——0 会被误读成「今天没涨没跌」', () => {
  const box = newBox();
  renderListSummary(box, {
    counted: 1,
    costValue: 1000,
    marketValue: 1100,
    profit: 100,
    profitPct: 10,
    todayProfit: null,
  });
  assert.ok(!box.title.includes('当日盈亏'));
});

// —— 安全约定 ——

test('第三方文本走 textContent，绝不拼 innerHTML', () => {
  // DOM 桩没有 innerHTML：真有人改成拼 innerHTML 就会抛 TypeError。
  // 股票名称来自行情接口，属于第三方内容
  const box = newBox();
  const evil = '<img src=x onerror=alert(1)>';
  renderList(box, [item({ alias: evil })], { onPick: () => {} });
  // 名称被当纯文本存下，没有被解析成节点
  assert.equal(box.find('list-name').textContent, evil);
  assert.equal(box.find('list-name').children.length, 0);
});

test('错误文字同样走 textContent', () => {
  const box = newBox();
  renderList(box, [item({ error: '<script>x</script>' })]);
  assert.equal(box.find('list-error').textContent, '<script>x</script>');
  assert.equal(box.find('list-error').children.length, 0);
});
