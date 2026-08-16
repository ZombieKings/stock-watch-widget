'use strict';

/**
 * groups.js 的单测。
 *
 * 项目没有 jsdom（devDeps 只有 electron），为几个 createElement/append
 * 引一个依赖不划算，所以这里手写一个够用的 DOM 桩：只实现 groups.js 真正
 * 用到的那几样（createElement / append / appendChild / textContent /
 * className / ownerDocument / style）。
 *
 * 桩的语义要跟浏览器一致，否则测试会通过而真实环境挂：
 *   - textContent = '' 必须清空子节点（renderIndicators 靠这个重画）
 *   - textContent 读取时要递归拼接子孙文本
 */

const { test } = require('node:test');
const assert = require('node:assert');

const {
  renderIndicators,
  renderFlow,
  renderMargin,
  renderFinance,
  renderLhb,
  renderReports,
  indicatorHint,
  flowHint,
  marginHint,
  financeHint,
  lhbHint,
  fmtFlowMoney,
  fmtAbsMoney,
  shortPeriod,
  signClass,
  hotColdClass,
} = require('./groups');

// —— DOM 桩 ——

class El {
  constructor(doc, tag) {
    this.ownerDocument = doc;
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.className = '';
    this.style = {};
    this._text = '';
    /** canvas 的 data-ind 走这里；绘制分派靠它 */
    this.dataset = {};
    /**
     * 默认 0，与「收起态 display:none」一致 —— drawIndCharts 要靠 clientWidth
     * 判断能不能画，桩里给非 0 默认值会让「收起时跳过」那条测试假绿。
     */
    this.clientWidth = 0;
    this.clientHeight = 0;
  }

  /**
   * classList 的最小实现。
   *
   * renderReports 用 classList.add 给可点击的条目打标；桩里没有它会直接抛
   * TypeError。这里按「读写同一个 className 字符串」实现，与浏览器语义一致 ——
   * 若做成独立集合，测试里读 className 就看不到 add 进去的类。
   */
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

  /** 事件系统：只记下来，测试通过 fire() 触发 */
  addEventListener(type, handler) {
    this._listeners = this._listeners || {};
    (this._listeners[type] = this._listeners[type] || []).push(handler);
  }

  /** 触发已注册的事件，用于验证点击回调真的接上了 */
  fire(type) {
    for (const fn of (this._listeners && this._listeners[type]) || []) fn();
  }

  /** 只支持 'canvas[data-ind]' 这一种选择器，够 drawIndCharts 用 */
  querySelectorAll(sel) {
    if (sel !== 'canvas[data-ind]') throw new Error(`桩未实现选择器：${sel}`);
    const out = [];
    const walk = (node) => {
      for (const c of node.children) {
        if (c.tagName === 'CANVAS' && c.dataset && c.dataset.ind) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }

  appendChild(child) {
    this.children.push(child);
    return child;
  }

  append(...kids) {
    for (const k of kids) this.appendChild(k);
  }

  set textContent(v) {
    // 浏览器语义：赋值会清掉所有子节点
    this.children = [];
    this._text = String(v);
  }

  get textContent() {
    if (this.children.length === 0) return this._text;
    return this.children.map((c) => c.textContent).join('');
  }

  /** 按 class 深度查找，测试里用来定位具体单元格 */
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

function newGrid() {
  return fakeDoc().createElement('div');
}

/** 一份完整的 collectIndicators 结果（数值取自贵州茅台 2026-08-07 实测） */
function indData(over = {}) {
  return {
    code: 'sh600519',
    period: 'day',
    date: '2026-08-07',
    close: 1309.22,
    barCount: 81,
    macd: { dif: 23.06, dea: 24.4, macd: -2.69 },
    rsi: { rsi6: 46.08, rsi12: 54.63, rsi24: 53.53 },
    kdj: { k: 44.36, d: 59.76, j: 13.56 },
    boll: { up: 1381.3, mid: 1298.66, low: 1216.03, pctB: 0.564 },
    ...over,
  };
}

/** 一份 collectFlow 结果（同上，5 日真实数据的净额） */
function flowData(over = {}) {
  const days = [
    { date: '2026-08-03', main: -22180448, large: 163591040, huge: -185771488, medium: 22397824, small: -217368 },
    { date: '2026-08-04', main: -668398240, large: -215226752, huge: -453171488, medium: 668804096, small: -405840 },
    { date: '2026-08-05', main: -837513552, large: -524643888, huge: -312869664, medium: 837852016, small: -338471 },
    { date: '2026-08-06', main: -165793504, large: -126662304, huge: -39131200, medium: 165920256, small: -126753 },
    { date: '2026-08-07', main: -116062624, large: -108712640, huge: -7349984, medium: 116315168, small: -252559 },
  ];
  return {
    code: 'sh600519',
    name: '贵州茅台',
    days,
    latest: { ...days[4], consistent: true },
    mainSum: days.reduce((s, d) => s + d.main, 0),
    ...over,
  };
}

// —— 格式化 ——

test('fmtFlowMoney：亿 / 万 / 元三档，带符号', () => {
  assert.equal(fmtFlowMoney(-116062624), '-1.16亿');
  assert.equal(fmtFlowMoney(251153824), '+2.51亿');
  assert.equal(fmtFlowMoney(-35200000), '-3520万');
  assert.equal(fmtFlowMoney(8123), '+8123');
  assert.equal(fmtFlowMoney(0), '0');
});

test('fmtFlowMoney：非数字显示 "--" 而不是 NaN', () => {
  for (const bad of [null, undefined, NaN, 'abc']) {
    assert.equal(fmtFlowMoney(bad), '--', `${bad} 应显示 --`);
  }
});

test('signClass：正红负绿零灰', () => {
  assert.equal(signClass(1), 'is-up');
  assert.equal(signClass(-1), 'is-down');
  assert.equal(signClass(0), 'is-flat');
  assert.equal(signClass(null), 'is-flat');
  assert.equal(signClass(NaN), 'is-flat');
});

test('hotColdClass：超买超卖阈值', () => {
  assert.equal(hotColdClass(75, 70, 30), 'is-hot');
  assert.equal(hotColdClass(70, 70, 30), 'is-hot', '等于阈值也算');
  assert.equal(hotColdClass(25, 70, 30), 'is-cold');
  assert.equal(hotColdClass(30, 70, 30), 'is-cold', '等于阈值也算');
  assert.equal(hotColdClass(50, 70, 30), '');
  assert.equal(hotColdClass(null, 70, 30), '');
});

// —— 技术指标 ——

test('renderIndicators 画出四行：MACD / RSI / KDJ / BOLL', () => {
  const grid = newGrid();
  renderIndicators(grid, indData());
  const rows = grid.findAll('ind-row');
  assert.equal(rows.length, 4);
  const names = grid.findAll('ind-name').map((n) => n.textContent);
  assert.deepEqual(names, ['MACD', 'RSI', 'KDJ', 'BOLL']);
});

test('renderIndicators 数值按指标精度显示', () => {
  const grid = newGrid();
  renderIndicators(grid, indData());
  const text = grid.textContent;
  assert.match(text, /23\.06/, 'DIF 两位小数');
  assert.match(text, /46\.1/, 'RSI 一位小数');
  assert.match(text, /1381\.30/, 'BOLL 上轨两位小数');
  assert.match(text, /56%/, 'pctB 显示为百分比整数');
});

test('renderIndicators MACD 绿柱着色为 is-down', () => {
  const grid = newGrid();
  renderIndicators(grid, indData());
  // macd = -2.69 → 绿柱
  const macdRow = grid.findAll('ind-row')[0];
  const vals = macdRow.findAll('ind-val');
  assert.ok(vals[2].className.includes('is-down'), `柱应为 is-down，实得 ${vals[2].className}`);
  // DIF/DEA 不着色：它们是数值不是信号
  assert.ok(!vals[0].className.includes('is-up') && !vals[0].className.includes('is-down'));
});

test('renderIndicators MACD 红柱着色为 is-up', () => {
  const grid = newGrid();
  renderIndicators(grid, indData({ macd: { dif: 5, dea: 2, macd: 3 } }));
  const vals = grid.findAll('ind-row')[0].findAll('ind-val');
  assert.ok(vals[2].className.includes('is-up'));
});

test('renderIndicators RSI 超买标 is-hot，超卖标 is-cold', () => {
  const grid = newGrid();
  renderIndicators(grid, indData({ rsi: { rsi6: 85, rsi12: 50, rsi24: 15 } }));
  const vals = grid.findAll('ind-row')[1].findAll('ind-val');
  assert.ok(vals[0].className.includes('is-hot'), 'RSI6=85 应超买');
  assert.equal(vals[1].className.trim(), 'ind-val', 'RSI12=50 不标注');
  assert.ok(vals[2].className.includes('is-cold'), 'RSI24=15 应超卖');
});

test('renderIndicators KDJ 用 80/20 阈值，不是 RSI 的 70/30', () => {
  const grid = newGrid();
  // K=75 在 RSI 口径下算超买，在 KDJ 口径下不算
  renderIndicators(grid, indData({ kdj: { k: 75, d: 50, j: 60 } }));
  const vals = grid.findAll('ind-row')[2].findAll('ind-val');
  assert.equal(vals[0].className.trim(), 'ind-val', 'K=75 未达 KDJ 的 80 阈值');
});

test('renderIndicators BOLL 占满整行', () => {
  const grid = newGrid();
  renderIndicators(grid, indData());
  const bollRow = grid.findAll('ind-row')[3];
  assert.ok(bollRow.className.includes('wide'), 'BOLL 行应有 wide 类');
});

test('renderIndicators null 值显示 "--"，不显示 NaN', () => {
  const grid = newGrid();
  renderIndicators(
    grid,
    indData({
      macd: { dif: 1, dea: 2, macd: 3 },
      rsi: { rsi6: null, rsi12: null, rsi24: null },
      kdj: { k: null, d: null, j: null },
      boll: { up: 10, mid: 9, low: 8, pctB: null },
    })
  );
  const text = grid.textContent;
  assert.ok(!text.includes('NaN'), `不得出现 NaN：${text}`);
  assert.match(text, /--/);
});

test('renderIndicators 数据不足时给出明确说明，而非四行 "--"', () => {
  const grid = newGrid();
  renderIndicators(
    grid,
    indData({
      barCount: 5,
      macd: { dif: null, dea: null, macd: null },
      rsi: { rsi6: null, rsi12: null, rsi24: null },
      kdj: { k: null, d: null, j: null },
      boll: { up: null, mid: null, low: null, pctB: null },
    })
  );
  assert.equal(grid.findAll('ind-row').length, 0, '不应画出指标行');
  assert.match(grid.textContent, /K 线不足/);
  assert.match(grid.textContent, /5 根/);
});

test('renderIndicators 加载中 / 出错 / 无数据三态', () => {
  let grid = newGrid();
  renderIndicators(grid, null, { loading: true });
  assert.match(grid.textContent, /加载中/);

  grid = newGrid();
  renderIndicators(grid, null, { error: '网络超时' });
  assert.match(grid.textContent, /网络超时/);

  grid = newGrid();
  renderIndicators(grid, null);
  assert.match(grid.textContent, /暂无数据/);
});

test('renderIndicators 重复调用会清空上一次的内容', () => {
  const grid = newGrid();
  renderIndicators(grid, indData());
  renderIndicators(grid, indData());
  assert.equal(grid.findAll('ind-row').length, 4, '不应累积成 8 行');
});

// —— 资金流向 ——

test('renderFlow 画出六格：五档 + 累计', () => {
  const grid = newGrid();
  const bars = newGrid();
  renderFlow(grid, bars, flowData());
  const cells = grid.findAll('flow-cell');
  assert.equal(cells.length, 6);
  const labels = grid.findAll('flow-label').map((l) => l.textContent);
  assert.deepEqual(labels, ['主力', '超大单', '大单', '中单', '小单', '5日累计']);
});

test('renderFlow 金额格式与着色', () => {
  const grid = newGrid();
  renderFlow(grid, newGrid(), flowData());
  const amounts = grid.findAll('flow-amount');
  assert.equal(amounts[0].textContent, '-1.16亿', '主力净流出');
  assert.ok(amounts[0].className.includes('is-down'));
  // 大单 -1.08 亿 也是流出
  assert.ok(amounts[2].className.includes('is-down'));
  // 中单 +1.16 亿 是流入
  assert.ok(amounts[3].className.includes('is-up'));
});

test('renderFlow 累计用 mainSum，标签带天数', () => {
  const grid = newGrid();
  renderFlow(grid, newGrid(), flowData());
  const cells = grid.findAll('flow-cell');
  const sum = cells[5];
  assert.match(sum.textContent, /5日累计/);
  assert.match(sum.textContent, /-18\.10亿/);
});

test('renderFlow 迷你柱：每天一根，正负分居基线两侧', () => {
  const bars = newGrid();
  renderFlow(newGrid(), bars, flowData());
  assert.equal(bars.findAll('flow-bar').length, 5, '5 天 5 根');
  // 全是净流出 → 全部在下半格
  const fills = bars.findAll('flow-bar-fill');
  assert.equal(fills.length, 5);
  for (const f of fills) {
    assert.ok(f.className.includes('is-down'), `应为 is-down：${f.className}`);
  }
});

test('renderFlow 迷你柱按绝对值最大的一天归一化', () => {
  const bars = newGrid();
  renderFlow(newGrid(), bars, flowData());
  const fills = bars.findAll('flow-bar-fill');
  // 最大绝对值是 08-05 的 -8.375 亿 → 该根应为 100%
  assert.equal(fills[2].style.height, '100%');
  // 08-07 的 -1.16 亿 ≈ 13.9%
  const h = parseFloat(fills[4].style.height);
  assert.ok(h > 10 && h < 18, `08-07 高度应约 14%，实得 ${fills[4].style.height}`);
});

test('renderFlow 迷你柱正负混合时分居两侧', () => {
  const days = [
    { date: '2026-08-06', main: 1e8 },
    { date: '2026-08-07', main: -5e7 },
  ];
  const bars = newGrid();
  renderFlow(newGrid(), bars, { days, latest: { ...days[1] }, mainSum: 5e7 });
  const fills = bars.findAll('flow-bar-fill');
  assert.ok(fills[0].className.includes('is-up'));
  assert.ok(fills[1].className.includes('is-down'));
  assert.equal(fills[0].style.height, '100%', '正的那根是最大绝对值');
});

test('renderFlow 无数据时提示，且不画柱', () => {
  const grid = newGrid();
  const bars = newGrid();
  renderFlow(grid, bars, { code: 'sh000001', name: '', days: [], latest: null, mainSum: 0 });
  assert.match(grid.textContent, /暂无资金流数据/);
  assert.equal(bars.findAll('flow-bar').length, 0);
});

test('renderFlow 加载中与出错两态', () => {
  let grid = newGrid();
  renderFlow(grid, newGrid(), null, { loading: true });
  assert.match(grid.textContent, /加载中/);

  grid = newGrid();
  renderFlow(grid, newGrid(), null, { error: '请求失败' });
  assert.match(grid.textContent, /请求失败/);
});

test('renderFlow 重复调用清空旧内容', () => {
  const grid = newGrid();
  const bars = newGrid();
  renderFlow(grid, bars, flowData());
  renderFlow(grid, bars, flowData());
  assert.equal(grid.findAll('flow-cell').length, 6);
  assert.equal(bars.findAll('flow-bar').length, 5);
});

test('renderFlow 缺档位时该格显示 "--" 而不是崩', () => {
  const grid = newGrid();
  const d = flowData();
  d.latest = { date: '2026-08-07', main: -1e8 }; // 只有主力，其余档缺失
  renderFlow(grid, newGrid(), d);
  const amounts = grid.findAll('flow-amount');
  assert.equal(amounts[0].textContent, '-1.00亿');
  assert.equal(amounts[1].textContent, '--', '缺失的超大单应为 --');
});

// —— 分组头部摘要 ——

test('indicatorHint 收起时也能看到 MACD 柱', () => {
  assert.match(indicatorHint(indData()), /绿柱/);
  assert.match(indicatorHint(indData()), /-2\.69/);
  assert.match(indicatorHint(indData({ macd: { dif: 5, dea: 2, macd: 3 } })), /红柱/);
});

test('indicatorHint 无数据时返回空串（不占位）', () => {
  assert.equal(indicatorHint(null), '');
  assert.equal(indicatorHint({ macd: { macd: null } }), '');
});

test('flowHint 收起时显示主力净额', () => {
  assert.match(flowHint(flowData()), /主力 -1\.16亿/);
});

test('flowHint 无数据时返回空串', () => {
  assert.equal(flowHint(null), '');
  assert.equal(flowHint({ latest: null }), '');
});

// —— 全局作用域卫兵 ——

test('renderer/ 各脚本的顶层声明不重名（普通 script 共享全局作用域）', () => {
  // 这一条是为一个真实踩过的坑加的：groups.js 曾用 `const API`，
  // 与 candle.js 的 `const API` 撞车 → 浏览器解析期 SyntaxError，
  // 整个 groups.js 不执行、window.StockGroups 为 undefined。
  // node 下每个文件是独立模块作用域，所以其它单测全绿也发现不了。
  const fs = require('node:fs');
  const path = require('node:path');

  // 与 index.html 的 <script> 顺序一致；它们共享 window 的全局作用域
  const files = ['axis.js', 'chart.js', 'candle.js', 'indchart.js', 'groups.js', 'renderer.js'];
  const seen = new Map();
  const clashes = [];

  for (const f of files) {
    const src = fs.readFileSync(path.join(__dirname, f), 'utf8');
    // 只看列首的声明 = 顶层；缩进过的在函数内，不进全局
    for (const m of src.matchAll(/^(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/gm)) {
      const name = m[1];
      if (seen.has(name)) clashes.push(`${name}（${seen.get(name)} 与 ${f}）`);
      else seen.set(name, f);
    }
  }

  assert.deepEqual(clashes, [], `顶层声明重名会让后加载的脚本整体不执行：${clashes.join('；')}`);
});

test('groups.js 不声明与 preload 的 window.api 同名的顶层变量', () => {
  const fs = require('node:fs');
  const src = fs.readFileSync(require('node:path').join(__dirname, 'groups.js'), 'utf8');
  assert.equal(/^(?:const|let|var)\s+api\b/m.test(src), false, '顶层 `api` 会与 contextBridge 暴露的 window.api 冲突');
});

// —— 融资融券 ——

/** 一份 collectMargin 结果（贵州茅台 2026-08-07 实测数值） */
function marginData(over = {}) {
  const days = [
    { date: '2026-08-03', finBalance: 17400000000, finNet: -50000000, shortBalance: 120000000, totalBalance: 17520000000, finBalanceRatio: 1.06 },
    { date: '2026-08-04', finBalance: 17450000000, finNet: 50000000, shortBalance: 125000000, totalBalance: 17575000000, finBalanceRatio: 1.07 },
    { date: '2026-08-05', finBalance: 17500000000, finNet: 50000000, shortBalance: 130000000, totalBalance: 17630000000, finBalanceRatio: 1.07 },
    { date: '2026-08-06', finBalance: 17526638429, finNet: 12531572, shortBalance: 134490151.9, totalBalance: 17661128580.9, finBalanceRatio: 1.0714 },
    { date: '2026-08-07', finBalance: 17544302364, finNet: 17663935, shortBalance: 130500431.16, totalBalance: 17674802795.16, finBalanceRatio: 1.07197612 },
  ];
  return {
    code: 'sh600519',
    supported: true,
    name: '贵州茅台',
    days,
    latest: days[4],
    finNetSum: days.reduce((s, d) => s + d.finNet, 0),
    ...over,
  };
}

test('renderMargin：画出余额与净买入，余额用无符号格式', () => {
  const grid = newGrid();
  const bars = newGrid();
  renderMargin(grid, bars, marginData());

  const amounts = grid.findAll('flow-amount').map((el) => el.textContent);
  // 融资余额 175.44 亿，是存量，不该带 +
  assert.ok(
    amounts.some((t) => t === '175.44亿'),
    `应有无符号的融资余额，实际：${amounts.join(' | ')}`
  );
  // 净买入是有向的，要带符号
  assert.ok(amounts.some((t) => t.startsWith('+')), '净买入应带符号');
});

test('renderMargin：余额不上涨跌色（存量无方向），净买入才染色', () => {
  const grid = newGrid();
  renderMargin(grid, newGrid(), marginData());

  const cells = grid.findAll('flow-cell');
  const byLabel = new Map(
    cells.map((c) => [c.find('flow-label').textContent, c.find('flow-amount')])
  );

  const balance = byLabel.get('融资余额');
  assert.ok(balance, '应有融资余额格');
  assert.ok(
    !/is-up|is-down/.test(balance.className),
    `余额不该有涨跌色，否则 175 亿会显示成红色像在涨（className=${balance.className}）`
  );

  const net = byLabel.get('融资净买入');
  assert.match(net.className, /is-up/, '净买入为正应染涨色');
});

test('renderMargin：占流通市值为 null（ETF）时显示 --', () => {
  const grid = newGrid();
  const data = marginData();
  data.latest = { ...data.latest, finBalanceRatio: null };
  renderMargin(grid, newGrid(), data);

  const cell = grid.findAll('flow-cell').find((c) => c.find('flow-label').textContent === '占流通市值');
  assert.equal(cell.find('flow-amount').textContent, '--');
});

test('renderMargin：迷你柱按 finNet 归一化，正负分居上下半格', () => {
  const bars = newGrid();
  renderMargin(newGrid(), bars, marginData());

  const barEls = bars.findAll('flow-bar');
  assert.equal(barEls.length, 5);
  // 08-03 是负的，填充应在下半格
  const first = barEls[0];
  const halves = first.findAll('flow-bar-half');
  assert.equal(halves[0].children.length, 0, '负值时上半格应为空');
  assert.equal(halves[1].children.length, 1, '负值填充在下半格');
  assert.match(halves[1].children[0].className, /is-down/);
});

test('renderMargin：指数给明确说明而不是空白', () => {
  const grid = newGrid();
  renderMargin(grid, newGrid(), { supported: false, days: [], latest: null });
  assert.match(grid.textContent, /指数无两融数据/);
});

test('renderMargin：非两融标的说「非两融标的」而不是「加载失败」', () => {
  // 多数小盘股不是两融标的，这是正常情况
  const grid = newGrid();
  renderMargin(grid, newGrid(), { supported: true, days: [], latest: null, finNetSum: 0 });
  assert.match(grid.textContent, /非两融标的/);
});

test('renderMargin：loading 与 error 各有其态，且清空旧内容', () => {
  const grid = newGrid();
  const bars = newGrid();
  renderMargin(grid, bars, marginData());
  assert.ok(grid.findAll('flow-cell').length > 0);

  renderMargin(grid, bars, null, { loading: true });
  assert.match(grid.textContent, /加载中/);
  assert.equal(grid.findAll('flow-cell').length, 0, '重画要清掉旧格子');

  renderMargin(grid, bars, null, { error: '两融加载失败' });
  assert.match(grid.textContent, /两融加载失败/);
});

test('marginHint：给融资余额；不支持或无数据时为空串', () => {
  assert.match(marginHint(marginData()), /融资 175\.44亿/);
  assert.equal(marginHint({ supported: false }), '');
  assert.equal(marginHint({ supported: true, latest: null }), '');
  assert.equal(marginHint(null), '');
});

// —— 财务指标 ——

/** 一份 collectFinance 结果（贵州茅台真实数值） */
function financeData(over = {}) {
  const periods = [
    {
      reportDate: '2026-03-31',
      reportName: '2026一季报',
      reportType: '一季报',
      noticeDate: '2026-04-25',
      eps: 21.76,
      bps: 216.32,
      roe: 10.57,
      grossMargin: 89.76,
      netMargin: 52.22,
      debtRatio: 12.12,
      revenue: 54702912385.23,
      netProfit: 27242512886.45,
      revenueYoy: 6.34,
      netProfitYoy: 1.47,
    },
    { reportDate: '2025-12-31', reportName: '2025年报', eps: 65.66, bps: 195.36, roe: 32.53 },
    { reportDate: '2025-09-30', reportName: '2025三季报', eps: 49.2, roe: 25.1 },
  ];
  return { code: 'sh600519', supported: true, periods, latest: periods[0], ...over };
}

test('renderFinance：报告期抬头必须有——没有它下面的数字没意义', () => {
  const grid = newGrid();
  renderFinance(grid, financeData());
  assert.equal(grid.find('fin-period').textContent, '2026一季报');
});

test('renderFinance：画出六项关键比率，百分比带 %', () => {
  const grid = newGrid();
  renderFinance(grid, financeData());

  const byLabel = new Map(
    grid.findAll('fin-cell').map((c) => [c.find('fin-label').textContent, c.find('fin-value').textContent])
  );
  assert.equal(byLabel.get('EPS'), '21.76', '元不加单位后缀');
  assert.equal(byLabel.get('ROE'), '10.57%');
  assert.equal(byLabel.get('毛利率'), '89.76%');
  assert.equal(byLabel.get('资产负债率'), '12.12%');
});

test('renderFinance：营收与净利润单独占行，同比着色', () => {
  const grid = newGrid();
  renderFinance(grid, financeData());

  const rows = grid.findAll('fin-money');
  assert.equal(rows.length, 2, '营收与净利润各一行');
  assert.match(rows[0].textContent, /547\.03亿/, '营收按亿格式化');
  const yoy = rows[0].find('fin-yoy');
  assert.match(yoy.textContent, /\+6\.34%/);
  assert.match(yoy.className, /is-up/);
});

test('renderFinance：同比为负时染跌色', () => {
  const data = financeData();
  data.latest = { ...data.latest, revenueYoy: -3.5 };
  const grid = newGrid();
  renderFinance(grid, data);
  assert.match(grid.findAll('fin-money')[0].find('fin-yoy').className, /is-down/);
});

test('renderFinance：往期 EPS 对照，不含最新一期', () => {
  const grid = newGrid();
  renderFinance(grid, financeData());
  const items = grid.findAll('fin-hist-item').map((el) => el.textContent);
  assert.equal(items.length, 2, '3 期数据里最新那期在上面已展示，往期只剩 2 个');
  assert.match(items[0], /25年 65\.66/);
  assert.match(items[1], /25Q3 49\.20/);
});

test('renderFinance：缺失字段显示 -- 而不是 NaN', () => {
  const grid = newGrid();
  renderFinance(grid, financeData({ latest: { reportDate: '2026-03-31', reportName: '2026一季报', eps: 21.76 }, periods: [] }));
  const values = grid.findAll('fin-value').map((el) => el.textContent);
  assert.ok(values.includes('--'), '缺失项应为 --');
  assert.ok(!values.some((v) => v.includes('NaN')), `不该出现 NaN：${values.join(' | ')}`);
});

test('renderFinance：基金与指数给明确说明', () => {
  const grid = newGrid();
  renderFinance(grid, { supported: false, periods: [], latest: null });
  assert.match(grid.textContent, /基金与指数无财务数据/);
});

test('renderFinance：loading 与 error 态', () => {
  const grid = newGrid();
  renderFinance(grid, financeData());
  assert.ok(grid.findAll('fin-cell').length > 0);

  renderFinance(grid, null, { loading: true });
  assert.match(grid.textContent, /加载中/);
  assert.equal(grid.findAll('fin-cell').length, 0);

  renderFinance(grid, null, { error: '财务加载失败' });
  assert.match(grid.textContent, /财务加载失败/);
});

test('shortPeriod：报告期名压成可辨认的短形式', () => {
  assert.equal(shortPeriod({ reportName: '2025年报', reportDate: '2025-12-31' }), '25年');
  assert.equal(shortPeriod({ reportName: '2026一季报', reportDate: '2026-03-31' }), '26Q1');
  assert.equal(shortPeriod({ reportName: '2025中报', reportDate: '2025-06-30' }), '25Q2');
  assert.equal(shortPeriod({ reportName: '2025三季报', reportDate: '2025-09-30' }), '25Q3');
  // 认不出来时回落到年份，不抛错
  assert.equal(shortPeriod({ reportName: '', reportDate: '2025-12-31' }), '25');
  assert.equal(shortPeriod(null), '');
});

test('financeHint：给 ROE；不支持时为空串', () => {
  assert.match(financeHint(financeData()), /ROE 10\.57%/);
  assert.equal(financeHint({ supported: false }), '');
  assert.equal(financeHint(null), '');
  // 没有 ROE 时退而报告期
  assert.equal(financeHint({ supported: true, latest: { reportName: '2026一季报' } }), '2026一季报');
});

test('fmtAbsMoney：无符号金额，与 fmtFlowMoney 的区别只在符号', () => {
  assert.equal(fmtAbsMoney(17544302364), '175.44亿');
  assert.equal(fmtAbsMoney(35200000), '3520万');
  assert.equal(fmtAbsMoney(812), '812');
  assert.equal(fmtAbsMoney(-17544302364), '175.44亿', '负值也不带符号（余额不会是负的，但要防 NaN）');
  assert.equal(fmtAbsMoney(null), '--');
  assert.equal(fmtAbsMoney(NaN), '--');
  // 对比：有向格式带符号
  assert.equal(fmtFlowMoney(17544302364), '+175.44亿');
});

// —— 龙虎榜 ——
//
// 最要紧的一点：区分「近期上榜」与「陈年记录」。茅台最近一次上榜是 2013 年，
// 不加区分地展示会让人以为刚上榜。

/** 一份 collectLhb 结果（奥士康 2026-08-07 实测数值） */
function lhbData(over = {}) {
  return {
    code: 'sz002913',
    supported: true,
    items: [
      {
        date: '2026-08-07',
        name: '奥士康',
        reason: '连续三个交易日内，涨幅偏离值累计达到20%的证券',
        seatNote: '4家机构买入，成功率15.98%',
        buyAmount: 309185983.66,
        sellAmount: 348836908.59,
        netAmount: -39650924.93,
        changePct: 10.004,
        after1d: null,
        after5d: null,
      },
    ],
    latest: null,
    isRecent: true,
    daysSince: 3,
    total: 13,
    ...over,
  };
}

test('renderLhb：画出日期、涨跌幅与净买入', () => {
  const list = newGrid();
  const data = lhbData();
  data.latest = data.items[0];
  renderLhb(list, data);

  const item = list.find('lhb-item');
  assert.ok(item, '应有一条记录');
  assert.equal(item.find('lhb-date').textContent, '2026-08-07');
  assert.match(item.find('lhb-pct').textContent, /\+10\.00%/);
  assert.match(item.find('lhb-net').textContent, /净-3965万/);
  assert.match(item.find('lhb-net').className, /is-down/, '净卖出染跌色');
});

test('renderLhb：上榜原因与营业部摘要都要显示', () => {
  const list = newGrid();
  const data = lhbData();
  data.latest = data.items[0];
  renderLhb(list, data);
  assert.match(list.find('lhb-reason').textContent, /涨幅偏离值累计达到20%/);
  assert.match(list.find('lhb-meta').textContent, /4家机构买入/);
});

test('renderLhb：近期上榜时不加「距今 N 天」提示', () => {
  const list = newGrid();
  const data = lhbData({ isRecent: true, daysSince: 3 });
  data.latest = data.items[0];
  renderLhb(list, data);
  assert.equal(list.find('lhb-stale'), null, '3 天前上榜无需提示');
});

test('renderLhb：陈年记录要明说距今多久——否则日期会被当成近期', () => {
  const list = newGrid();
  const data = lhbData({ isRecent: false, daysSince: 4943 });
  data.items = [{ ...data.items[0], date: '2013-01-28' }];
  data.latest = data.items[0];
  renderLhb(list, data);

  const stale = list.find('lhb-stale');
  assert.ok(stale, '应有陈旧提示');
  assert.match(stale.textContent, /4943 天/);
  assert.equal(list.findAll('lhb-item').length, 1, '记录本身仍要列出');
});

test('renderLhb：上榜后表现有值才显示（最新一条为 null）', () => {
  const list = newGrid();
  const data = lhbData();
  data.items = [{ ...data.items[0], after1d: 0.15, after5d: -2.2 }];
  data.latest = data.items[0];
  renderLhb(list, data);
  const meta = list.find('lhb-meta').textContent;
  assert.match(meta, /次日 \+0\.15%/);
  assert.match(meta, /5日 -2\.20%/);

  // null 时不该出现「次日 --」
  const list2 = newGrid();
  const d2 = lhbData();
  d2.latest = d2.items[0];
  renderLhb(list2, d2);
  assert.ok(!/次日/.test(list2.find('lhb-meta').textContent));
});

test('renderLhb：从未上榜说「从未上榜」，基金说不上榜', () => {
  const a = newGrid();
  renderLhb(a, { supported: true, items: [], latest: null, isRecent: false, daysSince: null });
  assert.match(a.textContent, /从未上榜/);

  const b = newGrid();
  renderLhb(b, { supported: false, items: [], latest: null });
  assert.match(b.textContent, /基金与指数不上龙虎榜/);
});

test('renderLhb：loading 与 error 态，且清空旧内容', () => {
  const list = newGrid();
  const data = lhbData();
  data.latest = data.items[0];
  renderLhb(list, data);
  assert.equal(list.findAll('lhb-item').length, 1);

  renderLhb(list, null, { loading: true });
  assert.match(list.textContent, /加载中/);
  assert.equal(list.findAll('lhb-item').length, 0);

  renderLhb(list, null, { error: '龙虎榜加载失败' });
  assert.match(list.textContent, /龙虎榜加载失败/);
});

test('lhbHint：只在近期上榜时说话', () => {
  const recent = lhbData({ isRecent: true, daysSince: 3 });
  recent.latest = recent.items[0];
  assert.match(lhbHint(recent), /08-07 净-3965万/);

  // 陈年记录不说话，否则收起态看着像刚发生
  const old = lhbData({ isRecent: false, daysSince: 4943 });
  old.latest = { ...old.items[0], date: '2013-01-28' };
  assert.equal(lhbHint(old), '');

  assert.equal(lhbHint({ supported: false }), '');
  assert.equal(lhbHint(null), '');
});

// —— 研报 ——

/** 一份 collectReports 结果（贵州茅台真实条目） */
function reportsData(over = {}) {
  return {
    code: 'sh600519',
    supported: true,
    items: [
      {
        title: '需求根基稳固，市场化定价持续兑现',
        org: '中邮证券',
        researcher: '蔡雪昱,张子健',
        date: '2026-07-23',
        rating: '买入',
        ratingRaw: '买入',
        industry: '白酒Ⅱ',
        epsThisYear: 67.19,
        peThisYear: 19.42,
        pages: 5,
        url: 'https://data.eastmoney.com/report/zw_stock.jshtml?infocode=AP202607231827290069',
      },
      {
        title: '飞天茅台年内二次提价',
        org: '群益证券',
        date: '2026-07-20',
        rating: '增持',
        peThisYear: 18.5,
        pages: 3,
        url: 'https://data.eastmoney.com/report/zw_stock.jshtml?infocode=X',
      },
    ],
    total: 114,
    summary: { counts: [['买入', 1], ['增持', 1]], top: '买入', total: 2 },
    ...over,
  };
}

test('renderReports：顶部给评级分布，不给加权平均分', () => {
  const list = newGrid();
  renderReports(list, reportsData());
  const summary = list.find('rep-summary');
  assert.ok(summary, '应有评级分布条');
  assert.match(summary.textContent, /买入 1/);
  assert.match(summary.textContent, /增持 1/);
  assert.match(summary.textContent, /共 114 篇/, 'total 大于列表长度时要说明');
});

test('renderReports：评级配色不借用涨跌色', () => {
  // 借用 is-up 会让「买入」显示成红色，看着像已经在涨
  const list = newGrid();
  renderReports(list, reportsData());
  for (const chip of list.findAll('rep-rating')) {
    assert.ok(
      !/is-up|is-down/.test(chip.className),
      `评级不该用涨跌色类名（${chip.textContent} → ${chip.className}）`
    );
  }
  // 正向评级用 is-pos
  const pos = list.findAll('rep-rating').find((c) => c.textContent.includes('买入'));
  assert.match(pos.className, /is-pos/);
});

test('renderReports：减持/卖出归为负向', () => {
  const list = newGrid();
  const data = reportsData({
    items: [{ title: 'X', org: 'A', date: '2026-07-01', rating: '减持', url: '' }],
    summary: { counts: [['减持', 1]], top: '减持', total: 1 },
  });
  renderReports(list, data);
  const chips = list.findAll('rep-rating').filter((c) => c.textContent.includes('减持'));
  assert.ok(chips.length > 0);
  for (const c of chips) assert.match(c.className, /is-neg/);
});

test('renderReports：每条给机构、预测 PE 与页数', () => {
  const list = newGrid();
  renderReports(list, reportsData());
  const meta = list.findAll('rep-meta')[0].textContent;
  assert.match(meta, /中邮证券/);
  // 要写清是「预测」，免得与行情区的实际 PE 混淆
  assert.match(meta, /预测PE 19\.4/);
  assert.match(meta, /5页/);
});

test('renderReports：标题用 textContent 写入（第三方内容不拼 HTML）', () => {
  const list = newGrid();
  const evil = '<img src=x onerror=alert(1)>标题';
  renderReports(list, reportsData({ items: [{ title: evil, org: 'A', date: '2026-07-01', url: '' }], summary: { counts: [] } }));
  // 桩的 textContent 是纯文本，原样存下说明没被当成 HTML 解析
  assert.equal(list.find('news-title').textContent, evil);
});

test('renderReports：点击带 url 的条目会回调 onOpen 并传对 url', () => {
  const opened = [];
  const list = newGrid();
  renderReports(list, reportsData(), { onOpen: (u) => opened.push(u) });

  const items = list.findAll('rep-item');
  assert.match(items[0].className, /is-clickable/);

  items[0].fire('click');
  assert.equal(opened.length, 1);
  assert.match(opened[0], /infocode=AP202607231827290069/, '要传该条自己的 url');

  // 无 onOpen 时不加点击态，避免给出「能点」的错觉
  const list2 = newGrid();
  renderReports(list2, reportsData());
  assert.ok(!/is-clickable/.test(list2.findAll('rep-item')[0].className));
});

test('renderReports：无 url 的条目不给点击态', () => {
  const list = newGrid();
  renderReports(
    list,
    reportsData({ items: [{ title: 'X', org: 'A', date: '2026-07-01', rating: '买入', url: '' }], summary: { counts: [['买入', 1]] } }),
    { onOpen: () => {} }
  );
  assert.ok(!/is-clickable/.test(list.find('rep-item').className));
});

test('renderReports：预测 PE 为 null 时整项不显示（不写 0.0）', () => {
  const list = newGrid();
  renderReports(
    list,
    reportsData({ items: [{ title: 'X', org: 'A', date: '2026-07-01', peThisYear: null, url: '' }], summary: { counts: [] } })
  );
  const meta = list.find('rep-meta');
  assert.ok(!/预测PE/.test(meta ? meta.textContent : ''), 'null 时不该出现预测 PE');
});

test('renderReports：基金说无研报，空列表说暂无', () => {
  const a = newGrid();
  renderReports(a, { supported: false, items: [], summary: { counts: [] } });
  assert.match(a.textContent, /基金与指数无机构研报/);

  const b = newGrid();
  renderReports(b, { supported: true, items: [], summary: { counts: [] } });
  assert.match(b.textContent, /暂无机构研报/);
});

test('renderReports：loading 与 error 态，且清空旧内容', () => {
  const list = newGrid();
  renderReports(list, reportsData());
  assert.equal(list.findAll('rep-item').length, 2);

  renderReports(list, null, { loading: true });
  assert.match(list.textContent, /加载中/);
  assert.equal(list.findAll('rep-item').length, 0);

  renderReports(list, null, { error: '研报加载失败' });
  assert.match(list.textContent, /研报加载失败/);
  assert.ok(list.find('error-box'), '错误用 error-box 呈现，与新闻区一致');
});
