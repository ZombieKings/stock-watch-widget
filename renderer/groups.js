'use strict';

/**
 * 技术指标 / 资金流向两个可折叠分组的纯渲染逻辑。
 *
 * 拆成独立文件是为了能在 node 下单测：这里只做「数据 → DOM 结构」的映射，
 * 不碰 window.api、不管定时器、不读 state。取数与折叠状态持久化留在 renderer.js。
 *
 * 判定阈值取业界通行值，但**不给买卖建议**，只做视觉标注：
 *   RSI ≥ 70 超买 / ≤ 30 超卖
 *   KDJ  K ≥ 80 超买 / ≤ 20 超卖
 * 「超买」不等于「该卖」，措辞上避免暗示操作。
 */

const RSI_HOT = 70;
const RSI_COLD = 30;
const KDJ_HOT = 80;
const KDJ_COLD = 20;

/** 数值 → 定长字符串；null/NaN 统一显示 '--'，不显示 'NaN' */
function fmt(v, digits = 2) {
  return Number.isFinite(v) ? v.toFixed(digits) : '--';
}

/**
 * 金额 → 「1.16亿 / 3520万 / 812」，带符号。
 *
 * 名字不能叫 fmtMoney：renderer.js 已有同名顶层函数，共享全局作用域会撞车。
 * 也不直接复用它 —— 那个的万元档是 1 位小数、门槛 1e6；资金流数额跨度大，
 * 这里要整数万、门槛 1e4。
 */
function fmtFlowMoney(v) {
  if (!Number.isFinite(v)) return '--';
  const sign = v > 0 ? '+' : v < 0 ? '-' : '';
  const abs = Math.abs(v);
  if (abs >= 1e8) return `${sign}${(abs / 1e8).toFixed(2)}亿`;
  if (abs >= 1e4) return `${sign}${(abs / 1e4).toFixed(0)}万`;
  return `${sign}${abs.toFixed(0)}`;
}

/** 涨跌配色类名：正红负绿零灰，与行情区一致 */
function signClass(v) {
  if (!Number.isFinite(v) || v === 0) return 'is-flat';
  return v > 0 ? 'is-up' : 'is-down';
}

/** 造一个 <span class="ind-val"> 键值对 */
function valSpan(doc, key, value, extraClass = '') {
  const el = doc.createElement('span');
  el.className = `ind-val${extraClass ? ` ${extraClass}` : ''}`;
  const k = doc.createElement('span');
  k.className = 'k';
  k.textContent = key;
  const v = doc.createElement('span');
  v.className = 'v';
  v.textContent = value;
  el.append(k, v);
  return el;
}

function indRow(doc, name, vals, wide = false) {
  const row = doc.createElement('div');
  row.className = `ind-row${wide ? ' wide' : ''}`;
  const label = doc.createElement('span');
  label.className = 'ind-name';
  label.textContent = name;
  const box = doc.createElement('span');
  box.className = 'ind-vals';
  for (const v of vals) box.appendChild(v);
  row.append(label, box);
  return row;
}

/**
 * 子图画布。
 *
 * 这里只建 DOM 不绘制：canvas 必须先进文档、拿到 clientWidth 才能按 DPR 定尺寸，
 * 在 appendChild 之前画会得到 0 宽的空图。绘制由 drawIndCharts 在插完之后统一做。
 *
 * data-ind 标出画哪个指标，绘制时据此分派，省得再维护一份 canvas 引用列表。
 */
function indCanvas(doc, kind) {
  const wrap = doc.createElement('div');
  wrap.className = 'ind-chart';
  const cv = doc.createElement('canvas');
  cv.className = 'ind-canvas';
  cv.dataset.ind = kind;
  wrap.appendChild(cv);
  return wrap;
}

/** 有哪些子图，以及各自从 series 里取哪个字段判断是否有数据可画 */
const IND_CHARTS = [
  ['macd', 'dif'],
  ['rsi', 'rsi6'],
  ['kdj', 'k'],
  ['boll', 'close'],
];

/**
 * 绘制已插入文档的子图。
 *
 * 与 renderIndicators 分开，是因为它还要被 resize 和 DPR 变化复用 ——
 * 那两种情况下 DOM 没变，只需重画。
 *
 * @param {HTMLElement} grid renderIndicators 填充过的容器
 * @param {object|null} series collectIndicators 结果里的 series
 * @returns {number} 实际画出的子图数量
 */
function drawIndCharts(grid, series) {
  if (!grid || !series) return 0;
  const lib = typeof window !== 'undefined' ? window.StockIndChart : null;
  if (!lib) return 0;

  const byKind = {
    macd: lib.drawMacd,
    rsi: lib.drawRsi,
    kdj: lib.drawKdj,
    boll: lib.drawBoll,
  };

  let n = 0;
  for (const cv of grid.querySelectorAll('canvas[data-ind]')) {
    const fn = byKind[cv.dataset.ind];
    // 收起时 clientWidth 为 0（display:none），画了也看不到还会把尺寸定成 0，
    // 展开后不重画就一直是空的 —— 直接跳过，由展开时的重绘补上
    if (!fn || !cv.clientWidth) continue;
    if (fn(cv, series)) n += 1;
  }
  return n;
}

/** RSI/KDJ 的超买超卖标注 */
function hotColdClass(v, hot, cold) {
  if (!Number.isFinite(v)) return '';
  if (v >= hot) return 'is-hot';
  if (v <= cold) return 'is-cold';
  return '';
}

/**
 * 渲染技术指标网格。
 * @param {HTMLElement} grid 容器，会被清空
 * @param {object|null} data collectIndicators 的结果；null 表示加载中
 * @param {{ error?: string, loading?: boolean }} [opts]
 */
function renderIndicators(grid, data, opts = {}) {
  const doc = grid.ownerDocument;
  grid.textContent = '';

  if (opts.loading) {
    grid.appendChild(emptyNote(doc, '加载中…'));
    return;
  }
  if (opts.error) {
    grid.appendChild(emptyNote(doc, opts.error));
    return;
  }
  if (!data) {
    grid.appendChild(emptyNote(doc, '暂无数据'));
    return;
  }
  // 数据不足时（新股上市不满 26 根）四组指标全是 null，给一句明确的解释，
  // 而不是摆四行 '--' 让用户以为是坏了
  if (data.macd && data.macd.dif == null && data.boll && data.boll.mid == null) {
    grid.appendChild(emptyNote(doc, `K 线不足（${data.barCount || 0} 根），无法计算`));
    return;
  }

  const m = data.macd || {};
  const r = data.rsi || {};
  const k = data.kdj || {};
  const b = data.boll || {};

  // 每个指标：一行数值 + 一张趋势子图。
  // 子图只在有 series 时插入 —— 老版本 IPC 结果没这个字段，
  // 那时仍显示数值，不至于整块空掉。
  const s = data.series;
  const hasSeries = (key) => !!(s && Array.isArray(s[key]) && s[key].length > 0);
  const addChart = (kind, probe) => {
    if (hasSeries(probe)) grid.appendChild(indCanvas(doc, kind));
  };

  // MACD：柱子的正负是多空信号，着色；DIF/DEA 只是数值，不着色
  grid.appendChild(
    indRow(doc, 'MACD', [
      valSpan(doc, 'DIF', fmt(m.dif)),
      valSpan(doc, 'DEA', fmt(m.dea)),
      valSpan(doc, 'M', fmt(m.macd), signClass(m.macd)),
    ])
  );
  addChart('macd', 'dif');

  grid.appendChild(
    indRow(doc, 'RSI', [
      valSpan(doc, '6', fmt(r.rsi6, 1), hotColdClass(r.rsi6, RSI_HOT, RSI_COLD)),
      valSpan(doc, '12', fmt(r.rsi12, 1), hotColdClass(r.rsi12, RSI_HOT, RSI_COLD)),
      valSpan(doc, '24', fmt(r.rsi24, 1), hotColdClass(r.rsi24, RSI_HOT, RSI_COLD)),
    ])
  );
  addChart('rsi', 'rsi6');

  grid.appendChild(
    indRow(doc, 'KDJ', [
      valSpan(doc, 'K', fmt(k.k, 1), hotColdClass(k.k, KDJ_HOT, KDJ_COLD)),
      valSpan(doc, 'D', fmt(k.d, 1), hotColdClass(k.d, KDJ_HOT, KDJ_COLD)),
      valSpan(doc, 'J', fmt(k.j, 1)),
    ])
  );
  addChart('kdj', 'k');

  // BOLL 占满整行：三个价格数值比上面几行宽
  const pctB = Number.isFinite(b.pctB) ? `${(b.pctB * 100).toFixed(0)}%` : '--';
  grid.appendChild(
    indRow(
      doc,
      'BOLL',
      [
        valSpan(doc, '上', fmt(b.up)),
        valSpan(doc, '中', fmt(b.mid)),
        valSpan(doc, '下', fmt(b.low)),
        valSpan(doc, '位置', pctB),
      ],
      true
    )
  );
  addChart('boll', 'close');
}

function emptyNote(doc, text) {
  const el = doc.createElement('div');
  el.className = 'group-empty';
  el.textContent = text;
  return el;
}

/** 资金流的六个档位。顺序按「主力 → 拆解」，主力放第一个 */
const FLOW_CELLS = [
  ['main', '主力'],
  ['huge', '超大单'],
  ['large', '大单'],
  ['medium', '中单'],
  ['small', '小单'],
];

/**
 * 渲染资金流向。
 * @param {HTMLElement} grid 数值区，会被清空
 * @param {HTMLElement} bars 迷你柱区，会被清空
 * @param {object|null} data collectFlow 的结果
 */
function renderFlow(grid, bars, data, opts = {}) {
  const doc = grid.ownerDocument;
  grid.textContent = '';
  bars.textContent = '';

  if (opts.loading) {
    grid.appendChild(emptyNote(doc, '加载中…'));
    return;
  }
  if (opts.error) {
    grid.appendChild(emptyNote(doc, opts.error));
    return;
  }
  const latest = data && data.latest;
  if (!latest) {
    // 指数、新股、长期停牌都会走到这里
    grid.appendChild(emptyNote(doc, '暂无资金流数据'));
    return;
  }

  for (const [key, label] of FLOW_CELLS) {
    const cell = doc.createElement('div');
    cell.className = 'flow-cell';
    const l = doc.createElement('span');
    l.className = 'flow-label';
    l.textContent = label;
    const a = doc.createElement('span');
    a.className = `flow-amount ${signClass(latest[key])}`;
    a.textContent = fmtFlowMoney(latest[key]);
    cell.append(l, a);
    grid.appendChild(cell);
  }

  // 第六格放累计，凑满两行三列
  const sumCell = doc.createElement('div');
  sumCell.className = 'flow-cell';
  const sl = doc.createElement('span');
  sl.className = 'flow-label';
  sl.textContent = `${(data.days || []).length}日累计`;
  const sa = doc.createElement('span');
  sa.className = `flow-amount ${signClass(data.mainSum)}`;
  sa.textContent = fmtFlowMoney(data.mainSum);
  sumCell.append(sl, sa);
  grid.appendChild(sumCell);

  renderFlowBars(bars, data.days || []);
}

/**
 * 近 N 日主力净额迷你柱。共享一条水平基线，正的往上、负的往下。
 * 高度按**绝对值最大的一天**归一化，这样单日暴量不会把其它天压成看不见的一条线
 * ——反过来说，柱高只能横向比较同一只股票的这几天，不能跨股票比。
 */
function renderFlowBars(container, days) {
  const doc = container.ownerDocument;
  container.textContent = '';
  if (days.length === 0) return;

  const peak = days.reduce((mx, d) => (Number.isFinite(d.main) ? Math.max(mx, Math.abs(d.main)) : mx), 0);

  for (const d of days) {
    const bar = doc.createElement('div');
    bar.className = 'flow-bar';
    bar.title = `${d.date} 主力 ${fmtFlowMoney(d.main)}`;

    const top = doc.createElement('div');
    top.className = 'flow-bar-half top';
    const bottom = doc.createElement('div');
    bottom.className = 'flow-bar-half';

    const v = Number.isFinite(d.main) ? d.main : 0;
    // peak 为 0 时（全部无数据或恰好全为 0）比例记 0，避免除零
    const ratio = peak > 0 ? Math.abs(v) / peak : 0;
    const fill = doc.createElement('div');
    fill.className = `flow-bar-fill ${v >= 0 ? 'is-up' : 'is-down'}`;
    // 至少留 1px，否则接近 0 的那天会整根消失，看起来像缺数据
    fill.style.height = `${Math.max(ratio * 100, v !== 0 ? 4 : 0)}%`;
    (v >= 0 ? top : bottom).appendChild(fill);

    const label = doc.createElement('div');
    label.className = 'flow-bar-date';
    // 只留「月-日」，日期全写挤不下
    label.textContent = String(d.date || '').slice(5);

    bar.append(top, bottom, label);
    container.appendChild(bar);
  }
}

/** 融资融券的四个格子。顺序按「余额 → 当日变化」 */
const MARGIN_CELLS = [
  ['finBalance', '融资余额', 'plain'],
  ['finNet', '融资净买入', 'signed'],
  ['shortBalance', '融券余额', 'plain'],
  ['totalBalance', '两融合计', 'plain'],
];

/**
 * 渲染融资融券。
 *
 * 与 renderFlow 分开而不是套一个通用函数：资金流的五档全是有向净额（正负都有意义），
 * 两融是「余额（永远为正）+ 净买入（有向）」两类混排，配色规则不同 ——
 * 给余额上涨跌色会让「融资余额 17.5亿」显示成红色，看着像在涨。
 *
 * @param {HTMLElement} grid 数值区，会被清空
 * @param {HTMLElement} bars 迷你柱区，会被清空
 * @param {object|null} data collectMargin 的结果
 */
function renderMargin(grid, bars, data, opts = {}) {
  const doc = grid.ownerDocument;
  grid.textContent = '';
  bars.textContent = '';

  if (opts.loading) {
    grid.appendChild(emptyNote(doc, '加载中…'));
    return;
  }
  if (opts.error) {
    grid.appendChild(emptyNote(doc, opts.error));
    return;
  }
  if (data && data.supported === false) {
    grid.appendChild(emptyNote(doc, '指数无两融数据'));
    return;
  }
  const latest = data && data.latest;
  if (!latest) {
    // 非两融标的（多数小盘股）会走到这里，是正常情况而非错误
    grid.appendChild(emptyNote(doc, '非两融标的'));
    return;
  }

  for (const [key, label, mode] of MARGIN_CELLS) {
    const cell = doc.createElement('div');
    cell.className = 'flow-cell';
    const l = doc.createElement('span');
    l.className = 'flow-label';
    l.textContent = label;
    const a = doc.createElement('span');
    // 余额是存量，永远为正，上涨跌色会误导；只有净买入才染色
    a.className = `flow-amount${mode === 'signed' ? ` ${signClass(latest[key])}` : ''}`;
    a.textContent = mode === 'signed' ? fmtFlowMoney(latest[key]) : fmtAbsMoney(latest[key]);
    cell.append(l, a);
    grid.appendChild(cell);
  }

  // 第五格：融资余额占流通市值。ETF 该字段为 null，显示 '--'
  const ratioCell = doc.createElement('div');
  ratioCell.className = 'flow-cell';
  const rl = doc.createElement('span');
  rl.className = 'flow-label';
  rl.textContent = '占流通市值';
  const ra = doc.createElement('span');
  ra.className = 'flow-amount';
  ra.textContent = Number.isFinite(latest.finBalanceRatio) ? `${fmt(latest.finBalanceRatio)}%` : '--';
  ratioCell.append(rl, ra);
  grid.appendChild(ratioCell);

  // 第六格：区间净买入累计，凑满两行三列
  const sumCell = doc.createElement('div');
  sumCell.className = 'flow-cell';
  const sl = doc.createElement('span');
  sl.className = 'flow-label';
  sl.textContent = `${(data.days || []).length}日净买入`;
  const sa = doc.createElement('span');
  sa.className = `flow-amount ${signClass(data.finNetSum)}`;
  sa.textContent = fmtFlowMoney(data.finNetSum);
  sumCell.append(sl, sa);
  grid.appendChild(sumCell);

  renderMarginBars(bars, data.days || []);
}

/**
 * 近 N 日融资净买入迷你柱。
 *
 * 复用 flow-bar 那套 CSS，但归一化的字段是 finNet 而非 main。没有把
 * renderFlowBars 改成带 key 参数的通用版：那个函数的 title 文案与
 * 「主力」字样耦合，加参数就得连文案一起参数化，反而更绕。
 */
function renderMarginBars(container, days) {
  const doc = container.ownerDocument;
  container.textContent = '';
  if (days.length === 0) return;

  const peak = days.reduce(
    (mx, d) => (Number.isFinite(d.finNet) ? Math.max(mx, Math.abs(d.finNet)) : mx),
    0
  );

  for (const d of days) {
    const bar = doc.createElement('div');
    bar.className = 'flow-bar';
    bar.title = `${d.date} 融资净买入 ${fmtFlowMoney(d.finNet)}`;

    const top = doc.createElement('div');
    top.className = 'flow-bar-half top';
    const bottom = doc.createElement('div');
    bottom.className = 'flow-bar-half';

    const v = Number.isFinite(d.finNet) ? d.finNet : 0;
    const ratio = peak > 0 ? Math.abs(v) / peak : 0;
    const fill = doc.createElement('div');
    fill.className = `flow-bar-fill ${v >= 0 ? 'is-up' : 'is-down'}`;
    fill.style.height = `${Math.max(ratio * 100, v !== 0 ? 4 : 0)}%`;
    (v >= 0 ? top : bottom).appendChild(fill);

    const label = doc.createElement('div');
    label.className = 'flow-bar-date';
    label.textContent = String(d.date || '').slice(5);

    bar.append(top, bottom, label);
    container.appendChild(bar);
  }
}

/**
 * 无向金额（余额类）→ 「17.54亿 / 3520万」，不带符号。
 * 与 fmtFlowMoney 的区别只在符号，但混用会让余额显示成 '+17.54亿'。
 */
function fmtAbsMoney(v) {
  if (!Number.isFinite(v)) return '--';
  const abs = Math.abs(v);
  if (abs >= 1e8) return `${(abs / 1e8).toFixed(2)}亿`;
  if (abs >= 1e4) return `${(abs / 1e4).toFixed(0)}万`;
  return abs.toFixed(0);
}

/** 财务指标要展示的行：[字段, 标签, 单位] */
const FINANCE_ROWS = [
  ['eps', 'EPS', '元'],
  ['bps', '每股净资产', '元'],
  ['roe', 'ROE', '%'],
  ['grossMargin', '毛利率', '%'],
  ['netMargin', '净利率', '%'],
  ['debtRatio', '资产负债率', '%'],
];

/**
 * 渲染财务主要指标。
 *
 * 布局思路：最新一期的关键比率用两列网格，营收/净利润及其同比单独一行
 * （金额位数多，挤在网格里会换行）。历史各期只列 EPS 做对照，
 * 完整的多期表格在 320px 宽里放不下。
 *
 * @param {HTMLElement} grid 会被清空
 * @param {object|null} data collectFinance 的结果
 */
function renderFinance(grid, data, opts = {}) {
  const doc = grid.ownerDocument;
  grid.textContent = '';

  if (opts.loading) {
    grid.appendChild(emptyNote(doc, '加载中…'));
    return;
  }
  if (opts.error) {
    grid.appendChild(emptyNote(doc, opts.error));
    return;
  }
  if (data && data.supported === false) {
    grid.appendChild(emptyNote(doc, '基金与指数无财务数据'));
    return;
  }
  const latest = data && data.latest;
  if (!latest) {
    grid.appendChild(emptyNote(doc, '暂无财务数据'));
    return;
  }

  // 报告期抬头：不写清是哪一期，下面的数字就没有意义
  const head = doc.createElement('div');
  head.className = 'fin-period';
  head.textContent = latest.reportName || latest.reportDate;
  if (latest.noticeDate) head.title = `公告日 ${latest.noticeDate}`;
  grid.appendChild(head);

  // 关键比率：两列网格
  const cells = doc.createElement('div');
  cells.className = 'fin-grid';
  for (const [key, label, unit] of FINANCE_ROWS) {
    const cell = doc.createElement('div');
    cell.className = 'fin-cell';
    const l = doc.createElement('span');
    l.className = 'fin-label';
    l.textContent = label;
    const v = doc.createElement('span');
    v.className = 'fin-value';
    const raw = latest[key];
    v.textContent = Number.isFinite(raw) ? `${fmt(raw)}${unit === '%' ? '%' : ''}` : '--';
    cell.append(l, v);
    cells.appendChild(cell);
  }
  grid.appendChild(cells);

  // 营收与净利润：金额 + 同比，各占一行
  grid.appendChild(moneyRow(doc, '营业总收入', latest.revenue, latest.revenueYoy));
  grid.appendChild(moneyRow(doc, '归母净利润', latest.netProfit, latest.netProfitYoy));

  // 历史各期 EPS 对照
  const periods = (data.periods || []).slice(1);
  if (periods.length > 0) {
    const hist = doc.createElement('div');
    hist.className = 'fin-hist';
    const hl = doc.createElement('span');
    hl.className = 'fin-label';
    hl.textContent = '往期 EPS';
    hist.appendChild(hl);
    for (const p of periods) {
      const span = doc.createElement('span');
      span.className = 'fin-hist-item';
      span.title = p.reportName || p.reportDate;
      // 报告期名太长（'2025年报'），取年份后两位 + 期次首字
      span.textContent = `${shortPeriod(p)} ${fmt(p.eps)}`;
      hist.appendChild(span);
    }
    grid.appendChild(hist);
  }
}

/** 金额 + 同比一行。同比着色，金额不着色（金额本身无方向） */
function moneyRow(doc, label, amount, yoy) {
  const row = doc.createElement('div');
  row.className = 'fin-money';
  const l = doc.createElement('span');
  l.className = 'fin-label';
  l.textContent = label;
  const v = doc.createElement('span');
  v.className = 'fin-value';
  v.textContent = fmtAbsMoney(amount);
  row.append(l, v);
  if (Number.isFinite(yoy)) {
    const y = doc.createElement('span');
    y.className = `fin-yoy ${signClass(yoy)}`;
    y.textContent = `同比 ${yoy > 0 ? '+' : ''}${fmt(yoy)}%`;
    row.appendChild(y);
  }
  return row;
}

/** '2025年报' → '25年'；'2026一季报' → '26Q1'。空间有限，只保留可辨认的部分 */
function shortPeriod(p) {
  const name = String((p && p.reportName) || '');
  const yy = String((p && p.reportDate) || '').slice(2, 4);
  if (name.includes('一季')) return `${yy}Q1`;
  if (name.includes('中报') || name.includes('半年')) return `${yy}Q2`;
  if (name.includes('三季')) return `${yy}Q3`;
  if (name.includes('年报')) return `${yy}年`;
  return yy;
}

/**
 * 渲染龙虎榜。
 *
 * 列表而非网格：每条上榜记录都带日期、原因、买卖额，网格塞不下。
 * 关键设计是**区分「近期上榜」与「历史记录」** —— 茅台最近一次上榜是 2013 年，
 * 不加区分地显示会让人误以为刚上榜。
 *
 * @param {HTMLElement} list 会被清空
 * @param {object|null} data collectLhb 的结果
 */
function renderLhb(list, data, opts = {}) {
  const doc = list.ownerDocument;
  list.textContent = '';

  if (opts.loading) {
    list.appendChild(emptyNote(doc, '加载中…'));
    return;
  }
  if (opts.error) {
    list.appendChild(emptyNote(doc, opts.error));
    return;
  }
  if (data && data.supported === false) {
    list.appendChild(emptyNote(doc, '基金与指数不上龙虎榜'));
    return;
  }
  const items = (data && data.items) || [];
  if (items.length === 0) {
    list.appendChild(emptyNote(doc, '从未上榜'));
    return;
  }

  // 最近一次上榜已经很久 → 明确说出来，免得下面的日期被当成近期
  if (data && !data.isRecent && data.daysSince != null) {
    const note = doc.createElement('div');
    note.className = 'lhb-stale';
    note.textContent = `最近一次上榜距今 ${data.daysSince} 天`;
    list.appendChild(note);
  }

  for (const it of items) {
    list.appendChild(lhbRow(doc, it));
  }
}

/** 一条上榜记录 */
function lhbRow(doc, it) {
  const row = doc.createElement('div');
  row.className = 'lhb-item';

  const head = doc.createElement('div');
  head.className = 'lhb-head';

  const date = doc.createElement('span');
  date.className = 'lhb-date';
  date.textContent = it.date;
  head.appendChild(date);

  if (Number.isFinite(it.changePct)) {
    const pct = doc.createElement('span');
    pct.className = `lhb-pct ${signClass(it.changePct)}`;
    pct.textContent = `${it.changePct > 0 ? '+' : ''}${fmt(it.changePct)}%`;
    head.appendChild(pct);
  }

  const net = doc.createElement('span');
  net.className = `lhb-net ${signClass(it.netAmount)}`;
  net.textContent = `净${fmtFlowMoney(it.netAmount)}`;
  head.appendChild(net);

  row.appendChild(head);

  // 上榜原因：第三方文本，用 textContent
  if (it.reason) {
    const reason = doc.createElement('div');
    reason.className = 'lhb-reason';
    reason.textContent = it.reason;
    reason.title = it.reason;
    row.appendChild(reason);
  }

  // 营业部摘要 + 上榜后表现
  const meta = doc.createElement('div');
  meta.className = 'lhb-meta';
  if (it.seatNote) {
    const seat = doc.createElement('span');
    seat.textContent = it.seatNote;
    meta.appendChild(seat);
  }
  // 上榜后 N 日涨跌：最新一条为 null（还没走完），有值才显示
  let metaCount = 0;
  if (it.seatNote) metaCount += 1;
  for (const [key, label] of [['after1d', '次日'], ['after5d', '5日']]) {
    if (!Number.isFinite(it[key])) continue;
    const span = doc.createElement('span');
    span.className = signClass(it[key]);
    span.textContent = `${label} ${it[key] > 0 ? '+' : ''}${fmt(it[key])}%`;
    meta.appendChild(span);
    metaCount += 1;
  }
  // 用自己数的计数而非 childNodes.length：本文件只往里 append 元素，
  // 两者等价，但 children/childNodes 的差异不值得在渲染层里赌
  if (metaCount > 0) row.appendChild(meta);

  return row;
}

/**
 * 渲染研报列表（与新闻页平级的标签页）。
 *
 * 评级分布放在顶部：单看一条研报的评级没有参考价值，「买入 7 / 增持 2」
 * 这种分布才有。刻意只做计数不算加权平均分 —— 各家评级口径不完全可比，
 * 算出一个分数会显得比实际更精确。
 *
 * @param {HTMLElement} list 会被清空
 * @param {object|null} data collectReports 的结果
 * @param {{ onOpen?: (url: string) => void }} [opts] 点击标题的回调，
 *        由 renderer.js 传入 window.api.openExternal —— 本文件不碰 window.api
 */
function renderReports(list, data, opts = {}) {
  const doc = list.ownerDocument;
  list.textContent = '';

  if (opts.loading) {
    list.appendChild(emptyNote(doc, '加载中…'));
    return;
  }
  if (opts.error) {
    const div = doc.createElement('div');
    div.className = 'error-box';
    div.textContent = opts.error;
    list.appendChild(div);
    return;
  }
  if (data && data.supported === false) {
    list.appendChild(emptyNote(doc, '基金与指数无机构研报'));
    return;
  }
  const items = (data && data.items) || [];
  if (items.length === 0) {
    list.appendChild(emptyNote(doc, '暂无机构研报'));
    return;
  }

  // 评级分布
  const summary = data.summary || { counts: [] };
  if (summary.counts && summary.counts.length > 0) {
    const bar = doc.createElement('div');
    bar.className = 'rep-summary';
    for (const [rating, n] of summary.counts) {
      const chip = doc.createElement('span');
      chip.className = `rep-rating ${ratingClass(rating)}`;
      chip.textContent = `${rating} ${n}`;
      bar.appendChild(chip);
    }
    if (data.total > items.length) {
      const more = doc.createElement('span');
      more.className = 'rep-total';
      more.textContent = `共 ${data.total} 篇`;
      bar.appendChild(more);
    }
    list.appendChild(bar);
  }

  for (const it of items) {
    list.appendChild(reportRow(doc, it, opts.onOpen));
  }
}

/**
 * 评级 → 配色类名。
 *
 * 只区分三档：正向（买入/增持/推荐）、中性、负向（减持/卖出）。
 * 不给「买入」用涨色红 —— 评级不是涨跌，借用行情配色会让人误读成已经在涨。
 * 用独立的 is-pos / is-neg，配色在 style.css 里另定。
 */
function ratingClass(rating) {
  const s = String(rating || '');
  if (/买入|增持|推荐|强烈/.test(s)) return 'is-pos';
  if (/减持|卖出|回避/.test(s)) return 'is-neg';
  return '';
}

/** 一条研报 */
function reportRow(doc, it, onOpen) {
  const row = doc.createElement('div');
  row.className = 'rep-item';

  const head = doc.createElement('div');
  head.className = 'rep-head';

  const date = doc.createElement('span');
  date.className = 'news-time';
  date.textContent = String(it.date || '').slice(5);
  head.appendChild(date);

  // 标题：第三方内容，只用 textContent
  const title = doc.createElement('span');
  title.className = 'news-title';
  title.textContent = it.title;
  head.appendChild(title);

  if (it.rating) {
    const tag = doc.createElement('span');
    tag.className = `rep-rating ${ratingClass(it.rating)}`;
    tag.textContent = it.rating;
    head.appendChild(tag);
  }

  row.appendChild(head);

  // 机构、研究员、预测 PE
  const meta = doc.createElement('div');
  meta.className = 'rep-meta';
  let metaCount = 0;
  if (it.org) {
    const org = doc.createElement('span');
    org.textContent = it.org;
    meta.appendChild(org);
    metaCount += 1;
  }
  if (Number.isFinite(it.peThisYear)) {
    const pe = doc.createElement('span');
    // 写清是「预测」，免得与行情区的实际 PE 混淆
    pe.textContent = `预测PE ${fmt(it.peThisYear, 1)}`;
    pe.title = Number.isFinite(it.epsThisYear) ? `预测 EPS ${fmt(it.epsThisYear)} 元` : '';
    meta.appendChild(pe);
    metaCount += 1;
  }
  if (it.pages != null) {
    const pages = doc.createElement('span');
    pages.textContent = `${it.pages}页`;
    meta.appendChild(pages);
    metaCount += 1;
  }
  if (metaCount > 0) row.appendChild(meta);

  row.title = `${it.date} ${it.org}${it.researcher ? ` · ${it.researcher}` : ''}\n${it.title}`;

  if (it.url && typeof onOpen === 'function') {
    row.classList.add('is-clickable');
    row.addEventListener('click', () => onOpen(it.url));
  }
  return row;
}

/** 分组头部的摘要文字：收起时也能看到最关键的一个数 */
function indicatorHint(data) {
  if (!data || !data.macd || data.macd.macd == null) return '';
  const m = data.macd.macd;
  return `MACD ${m > 0 ? '红柱' : m < 0 ? '绿柱' : '零轴'} ${fmt(m)}`;
}

function flowHint(data) {
  const latest = data && data.latest;
  if (!latest || latest.main == null) return '';
  return `主力 ${fmtFlowMoney(latest.main)}`;
}

function marginHint(data) {
  if (data && data.supported === false) return '';
  const latest = data && data.latest;
  if (!latest || latest.finBalance == null) return '';
  return `融资 ${fmtAbsMoney(latest.finBalance)}`;
}

function financeHint(data) {
  if (data && data.supported === false) return '';
  const latest = data && data.latest;
  if (!latest) return '';
  // 摘要给 ROE：单个数字里最能概括盈利能力的一个
  if (Number.isFinite(latest.roe)) return `ROE ${fmt(latest.roe)}%`;
  return latest.reportName || '';
}

/**
 * 龙虎榜摘要。
 *
 * 只在**近期**上榜时说话：不加这个判断，长期不上榜的股票会一直显示
 * 一条几年前的记录，收起态看着像刚发生的事。
 */
function lhbHint(data) {
  if (!data || data.supported === false) return '';
  if (!data.isRecent || !data.latest) return '';
  return `${data.latest.date.slice(5)} 净${fmtFlowMoney(data.latest.netAmount)}`;
}

/**
 * 导出对象的变量名必须全局唯一。
 *
 * renderer/ 下的脚本都是普通 <script>（非 ESM），顶层 const 共享同一个全局作用域：
 *   - 叫 `api`  → 与 preload 的 contextBridge `window.api` 冲突
 *   - 叫 `API`  → 与 candle.js 的顶层 `const API` 冲突
 * 两种情况都抛 "Identifier ... has already been declared"，且是**解析期**错误，
 * 整个文件一行都不执行 —— window.StockGroups 变 undefined，但单测照样全绿
 * （node 里每个文件是独立模块作用域，撞不上）。所以这里带前缀。
 */
const GROUPS_API = {
  renderIndicators,
  drawIndCharts,
  IND_CHARTS,
  renderFlow,
  renderFlowBars,
  renderMargin,
  renderMarginBars,
  renderFinance,
  renderLhb,
  renderReports,
  ratingClass,
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
  MARGIN_CELLS,
  FINANCE_ROWS,
  RSI_HOT,
  RSI_COLD,
  KDJ_HOT,
  KDJ_COLD,
};

if (typeof module !== 'undefined' && module.exports) module.exports = GROUPS_API;
if (typeof window !== 'undefined') window.StockGroups = GROUPS_API;
