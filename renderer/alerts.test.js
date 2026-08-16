'use strict';

/**
 * renderer/alerts.js 的单测。DOM 桩与 listview.test.js 同源，
 * 同样不实现 innerHTML（拼 innerHTML 会抛 TypeError）。
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  renderRuleEditor,
  ruleRow,
  ruleRowTitle,
  ruleLabel,
  renderAlertStatus,
  countRules,
  addRule,
  removeRule,
  toggleRule,
  alFormatValue,
  AL_KIND_LABELS,
} = require('./alerts');

// 跨模块一致性用
const srcAlerts = require('../src/alertRules');

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

function rule(kind, dir, value, over = {}) {
  return { kind, dir, value, enabled: true, ...over };
}

const WATCHLIST = [
  { code: 'sh600519', digits: '600519', alias: '', name: '贵州茅台' },
  { code: 'sz000858', digits: '000858', alias: '五粮液', name: '五粮液' },
];

// —— alFormatValue / ruleLabel ——

test('alFormatValue 百分比带 % 与正号，价格都不带', () => {
  assert.equal(alFormatValue('changePct', 5), '+5%');
  assert.equal(alFormatValue('changePct', -5), '-5%');
  assert.equal(alFormatValue('profitPct', 20), '+20%');
  assert.equal(alFormatValue('price', 1300), '1300');
  assert.equal(alFormatValue('price', 1.2345), '1.2345');
});

test('ruleLabel 给出人类可读描述', () => {
  assert.equal(ruleLabel(rule('changePct', 'gte', 5)), '涨跌幅 ≥ +5%');
  assert.equal(ruleLabel(rule('price', 'lte', 1600)), '价格 ≤ 1600');
  assert.equal(ruleLabel(rule('profitPct', 'lte', -10)), '持仓盈亏 ≤ -10%');
});

test('ruleLabel 输入为空时返回空串', () => {
  assert.equal(ruleLabel(null), '');
  assert.equal(ruleLabel(undefined), '');
});

test('渲染层的 ruleLabel 与主进程侧的 alertRules.ruleLabel 文案一致', () => {
  // 两处刻意各写一份（renderer 不能 require src/ 下的 CommonJS 模块），
  // 靠这条测试盯着不漂移 —— 通知里写「涨跌幅 ≥ +5%」而界面写「涨幅 > 5%」
  // 会让人以为是两条不同的规则
  for (const r of [
    rule('changePct', 'gte', 5),
    rule('changePct', 'lte', -3),
    rule('price', 'gte', 1300),
    rule('price', 'lte', 1.2345),
    rule('profitPct', 'gte', 20),
    rule('profitPct', 'lte', -10),
  ]) {
    assert.equal(ruleLabel(r), srcAlerts.ruleLabel(r), `${r.kind}/${r.dir}/${r.value}`);
  }
});

test('两处的类型标签表也一致', () => {
  assert.deepEqual(AL_KIND_LABELS, srcAlerts.KIND_LABELS);
});

// —— renderRuleEditor ——

test('渲染 N 条规则产出 N 行', () => {
  const box = newBox();
  renderRuleEditor(
    box,
    { sh600519: [rule('changePct', 'gte', 5), rule('price', 'lte', 1200)], sz000858: [rule('price', 'gte', 200)] },
    WATCHLIST
  );
  assert.equal(box.findAll('rule-row').length, 3);
});

test('没有规则时给出引导文字', () => {
  const box = newBox();
  renderRuleEditor(box, {}, WATCHLIST);
  assert.equal(box.findAll('rule-row').length, 0);
  assert.match(box.textContent, /还没有预警规则/);
  assert.match(box.textContent, /系统通知/, '说清触发时会发生什么');
});

test('rulesByCode 非对象时按空处理', () => {
  for (const bad of [null, undefined, 'x', 42, []]) {
    const box = newBox();
    renderRuleEditor(box, bad, WATCHLIST);
    assert.match(box.textContent, /还没有预警规则/, `输入 ${JSON.stringify(bad)}`);
  }
});

test('空规则数组的键不产出行', () => {
  const box = newBox();
  renderRuleEditor(box, { sh600519: [], sz000858: [rule('price', 'gte', 200)] }, WATCHLIST);
  assert.equal(box.findAll('rule-row').length, 1);
});

test('股票名用别名优先，与界面其它处一致', () => {
  const box = newBox();
  renderRuleEditor(box, { sz000858: [rule('price', 'gte', 200)] }, WATCHLIST);
  assert.equal(box.find('rule-name').textContent, '五粮液');
});

test('重画会清掉旧内容', () => {
  const box = newBox();
  renderRuleEditor(box, { sh600519: [rule('changePct', 'gte', 5)] }, WATCHLIST);
  assert.equal(box.findAll('rule-row').length, 1);
  renderRuleEditor(box, {}, WATCHLIST);
  assert.equal(box.findAll('rule-row').length, 0);
});

// —— 孤儿规则 ——

test('不在关注列表里的规则被标出来', () => {
  // 它不参与匹配（引擎只遍历行情列表），不说明的话用户会以为规则失效是 bug
  const box = newBox();
  renderRuleEditor(box, { sz300750: [rule('price', 'gte', 200)] }, WATCHLIST);
  const row = box.find('rule-row');
  assert.ok(row.classList.contains('is-orphan'));
  assert.ok(box.find('rule-tag'), '应有「不在关注列表」标记');
  assert.match(box.textContent, /不在关注列表/);
});

test('孤儿规则显示代码本身（查不到名称）', () => {
  const box = newBox();
  renderRuleEditor(box, { sz300750: [rule('price', 'gte', 200)] }, WATCHLIST);
  assert.equal(box.find('rule-name').textContent, 'sz300750');
});

test('孤儿规则排在关注列表内的规则之后——它是历史遗留，不该占视线焦点', () => {
  const box = newBox();
  renderRuleEditor(
    box,
    { sz300750: [rule('price', 'gte', 1)], sh600519: [rule('changePct', 'gte', 5)] },
    WATCHLIST
  );
  const names = box.findAll('rule-name').map((e) => e.textContent);
  assert.deepEqual(names, ['贵州茅台', 'sz300750']);
});

test('关注列表为空时所有规则都算孤儿，但不抛错', () => {
  const box = newBox();
  renderRuleEditor(box, { sh600519: [rule('price', 'gte', 1)] }, []);
  assert.ok(box.find('rule-row').classList.contains('is-orphan'));
});

// —— 停用态 ——

test('停用的规则带 is-off 类', () => {
  const box = newBox();
  renderRuleEditor(box, { sh600519: [rule('changePct', 'gte', 5, { enabled: false })] }, WATCHLIST);
  assert.ok(box.find('rule-row').classList.contains('is-off'));
});

test('启用中的规则不带 is-off', () => {
  const box = newBox();
  renderRuleEditor(box, { sh600519: [rule('changePct', 'gte', 5)] }, WATCHLIST);
  assert.ok(!box.find('rule-row').classList.contains('is-off'));
});

test('启用/停用 chip 的文案与 on 类跟着状态走', () => {
  const on = ruleRow(fakeDoc(), 'sh600519', rule('price', 'gte', 1), { onToggle: () => {} });
  const off = ruleRow(fakeDoc(), 'sh600519', rule('price', 'gte', 1, { enabled: false }), {
    onToggle: () => {},
  });
  assert.equal(on.find('rule-toggle').textContent, '启用中');
  assert.ok(on.find('rule-toggle').className.includes('on'));
  assert.equal(off.find('rule-toggle').textContent, '已停用');
  assert.ok(!off.find('rule-toggle').className.includes('on'));
});

// —— 交互 ——

test('点删除按钮回传 code 与规则', () => {
  let got = null;
  const row = ruleRow(fakeDoc(), 'sh600519', rule('changePct', 'gte', 5), {
    onRemove: (code, r) => {
      got = { code, r };
    },
  });
  row.find('watch-remove').fire('click');
  assert.equal(got.code, 'sh600519');
  assert.equal(got.r.value, 5);
});

test('点启用/停用 chip 回传 code 与规则', () => {
  let got = null;
  const row = ruleRow(fakeDoc(), 'sh600519', rule('price', 'lte', 1200), {
    onToggle: (code, r) => {
      got = { code, r };
    },
  });
  row.find('rule-toggle').fire('click');
  assert.equal(got.code, 'sh600519');
  assert.equal(got.r.kind, 'price');
});

test('未传回调时不出对应按钮', () => {
  const row = ruleRow(fakeDoc(), 'sh600519', rule('price', 'gte', 1), {});
  assert.equal(row.find('watch-remove'), null);
  assert.equal(row.find('rule-toggle'), null);
});

test('renderRuleEditor 把回调透传到每一行', () => {
  const box = newBox();
  const removed = [];
  renderRuleEditor(
    box,
    { sh600519: [rule('changePct', 'gte', 5)], sz000858: [rule('price', 'gte', 200)] },
    WATCHLIST,
    { onRemove: (code) => removed.push(code) }
  );
  for (const btn of box.findAll('watch-remove')) btn.fire('click');
  assert.deepEqual(removed.sort(), ['sh600519', 'sz000858']);
});

// —— ruleRowTitle ——

test('title 含代码、条件与「每天一次」的说明', () => {
  const t = ruleRowTitle('sh600519', rule('changePct', 'gte', 5), { name: '贵州茅台' });
  assert.match(t, /贵州茅台/);
  assert.match(t, /sh600519/);
  assert.match(t, /涨跌幅 ≥ \+5%/);
  assert.match(t, /每天最多提醒一次/);
});

test('停用的规则 title 说明它不会触发', () => {
  const t = ruleRowTitle('sh600519', rule('price', 'gte', 1, { enabled: false }), {});
  assert.match(t, /已停用/);
});

test('孤儿规则 title 说明加回关注列表即恢复', () => {
  const t = ruleRowTitle('sz300750', rule('price', 'gte', 1), { orphan: true });
  assert.match(t, /加回来即恢复/);
});

// —— renderAlertStatus ——

test('总开关开启时报告生效条数', () => {
  const box = newBox();
  renderAlertStatus(box, { enabled: true, rules: { sh600519: [rule('price', 'gte', 1)] } });
  assert.match(box.textContent, /1 条规则生效中/);
});

test('总开关关闭时说明规则被保留——便于临时静音而不必删规则', () => {
  const box = newBox();
  renderAlertStatus(box, {
    enabled: false,
    rules: { sh600519: [rule('price', 'gte', 1), rule('price', 'lte', 2)] },
  });
  assert.match(box.textContent, /静音/);
  assert.match(box.textContent, /2 条规则保留/);
});

test('无规则时的两种文案', () => {
  const on = newBox();
  renderAlertStatus(on, { enabled: true, rules: {} });
  assert.match(on.textContent, /尚无规则/);

  const off = newBox();
  renderAlertStatus(off, { enabled: false, rules: {} });
  assert.match(off.textContent, /预警已关闭/);
});

test('renderAlertStatus 输入为空时不抛错', () => {
  const box = newBox();
  assert.doesNotThrow(() => renderAlertStatus(box, null));
  assert.equal(box.children.length, 0);
});

// —— countRules ——

test('countRules 累加所有股票的规则数', () => {
  assert.equal(countRules({ a: [1, 2], b: [3] }), 3);
  assert.equal(countRules({}), 0);
});

test('countRules 忽略非数组的值', () => {
  assert.equal(countRules({ a: [1], b: 'x', c: null }), 1);
});

test('countRules 非对象输入返回 0', () => {
  for (const bad of [null, undefined, 'x', 42]) {
    assert.equal(countRules(bad), 0, `countRules(${JSON.stringify(bad)})`);
  }
});

// —— addRule / removeRule / toggleRule（纯函数，不改原对象）——

test('addRule 追加一条并返回新对象', () => {
  const src = { sh600519: [rule('changePct', 'gte', 5)] };
  const out = addRule(src, 'sh600519', rule('price', 'lte', 1200));
  assert.equal(out.sh600519.length, 2);
  assert.equal(src.sh600519.length, 1, '原对象必须不变');
  assert.notEqual(out, src);
});

test('addRule 给没有规则的股票建新键', () => {
  const out = addRule({}, 'sh600519', rule('price', 'gte', 1));
  assert.equal(out.sh600519.length, 1);
});

test('addRule 非对象输入也能工作', () => {
  const out = addRule(null, 'sh600519', rule('price', 'gte', 1));
  assert.equal(out.sh600519.length, 1);
});

test('removeRule 按 kind+dir+value 删除', () => {
  // 按这三项而非 id：设置界面里新加的规则还没落盘、没有 id
  const src = { sh600519: [rule('changePct', 'gte', 5), rule('price', 'lte', 1200)] };
  const out = removeRule(src, 'sh600519', rule('changePct', 'gte', 5));
  assert.equal(out.sh600519.length, 1);
  assert.equal(out.sh600519[0].kind, 'price');
  assert.equal(src.sh600519.length, 2, '原对象必须不变');
});

test('removeRule 删空后去掉该键——与 config.normalizeAlerts 的行为一致', () => {
  const out = removeRule({ sh600519: [rule('price', 'gte', 1)] }, 'sh600519', rule('price', 'gte', 1));
  assert.ok(!('sh600519' in out));
});

test('removeRule 只删匹配的那条，同 kind 不同 dir 的保留', () => {
  const src = { sh600519: [rule('changePct', 'gte', 5), rule('changePct', 'lte', -5)] };
  const out = removeRule(src, 'sh600519', rule('changePct', 'gte', 5));
  assert.equal(out.sh600519.length, 1);
  assert.equal(out.sh600519[0].dir, 'lte');
});

test('removeRule 删不存在的规则不报错', () => {
  const src = { sh600519: [rule('price', 'gte', 1)] };
  const out = removeRule(src, 'sh600519', rule('price', 'lte', 999));
  assert.equal(out.sh600519.length, 1);
});

test('removeRule 对不存在的代码不报错', () => {
  assert.doesNotThrow(() => removeRule({}, 'sh600519', rule('price', 'gte', 1)));
});

test('toggleRule 翻转 enabled 并返回新对象', () => {
  const src = { sh600519: [rule('price', 'gte', 1)] };
  const off = toggleRule(src, 'sh600519', rule('price', 'gte', 1));
  assert.equal(off.sh600519[0].enabled, false);
  assert.equal(src.sh600519[0].enabled, true, '原对象必须不变');

  const on = toggleRule(off, 'sh600519', rule('price', 'gte', 1));
  assert.equal(on.sh600519[0].enabled, true, '再翻一次回到启用');
});

test('toggleRule 只影响匹配的那条', () => {
  const src = { sh600519: [rule('changePct', 'gte', 5), rule('price', 'lte', 1200)] };
  const out = toggleRule(src, 'sh600519', rule('price', 'lte', 1200));
  assert.equal(out.sh600519[0].enabled, true, '另一条不受影响');
  assert.equal(out.sh600519[1].enabled, false);
});

// —— 与主进程侧引擎的配合 ——

test('本地拼出的规则能被主进程的 normalizeRules 接受', () => {
  // 设置面板先在本地拼出完整的 rules 再整体提交（config.patch 对 rules
  // 是整体替换语义）。拼出来的形状必须过得了主进程那道校验
  let rules = {};
  rules = addRule(rules, 'sh600519', rule('changePct', 'gte', 5));
  rules = addRule(rules, 'sh600519', rule('price', 'lte', 1200));

  const normalized = srcAlerts.normalizeRules(rules.sh600519);
  assert.equal(normalized.length, 2, '两条都该被接受');
  assert.equal(normalized[0].kind, 'changePct');
});

test('停用态能经 normalizeRules 往返而不丢', () => {
  let rules = addRule({}, 'sh600519', rule('price', 'gte', 1));
  rules = toggleRule(rules, 'sh600519', rule('price', 'gte', 1));
  const normalized = srcAlerts.normalizeRules(rules.sh600519);
  assert.equal(normalized[0].enabled, false, '停用状态必须存得下来');
});

// —— 安全约定 ——

test('股票名走 textContent，绝不拼 innerHTML', () => {
  // DOM 桩没有 innerHTML：真去赋值会抛 TypeError。
  // 名称来自行情接口（第三方内容）
  const box = newBox();
  const evil = '<img src=x onerror=alert(1)>';
  renderRuleEditor(box, { sh600519: [rule('price', 'gte', 1)] }, [
    { code: 'sh600519', alias: evil, name: evil, digits: '600519' },
  ]);
  const name = box.find('rule-name');
  assert.equal(name.textContent, evil);
  assert.equal(name.children.length, 0, '没有被解析成节点');
});
