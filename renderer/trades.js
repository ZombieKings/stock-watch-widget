'use strict';

/**
 * 交易流水的渲染：时间线列表、已实现盈亏行、设置面板里的编辑行。
 *
 * 只做「数据 → DOM」，不碰 window.api、不管定时器、不读 state ——
 * 与 groups.js / listview.js 同一套约定，可在 node 下用 DOM 桩单测。
 *
 * 顶层符号一律加 tr 前缀或包在 TRADES_API 里：renderer/ 下的脚本共享全局作用域，
 * 与 renderer.js 已有的 fmtPrice / fmtMoney / dirClass 重名会在**解析期**抛错，
 * 整个文件一行都不执行，而 node 单测照样全绿。所以下面的格式化函数是刻意重写。
 *
 * 口径提醒：已实现盈亏**不含**手续费、印花税、过户费。加进来要引入
 * 「不同券商不同费率」「费率随时间变」一串问题，超出轻量版的边界；
 * 界面上明确标注，用户拿它和券商 App 对不上是预期行为。
 */

/** 价格：4 位有效小数，去掉无意义的尾随零（基金净值 4 位、股票 2 位） */
function trFmtPrice(v) {
  if (!Number.isFinite(v)) return '--';
  return String(Math.round(v * 1e4) / 1e4);
}

/** 数量：整数不带小数点，基金份额可能有小数才保留 */
function trFmtShares(v) {
  if (!Number.isFinite(v)) return '--';
  return Number.isInteger(v) ? String(v) : v.toFixed(2);
}

/** 金额：带符号，万/亿分档 */
function trFmtMoney(v) {
  if (!Number.isFinite(v)) return '--';
  const sign = v > 0 ? '+' : v < 0 ? '-' : '';
  const abs = Math.abs(v);
  if (abs >= 1e8) return `${sign}${(abs / 1e8).toFixed(2)}亿`;
  if (abs >= 1e6) return `${sign}${(abs / 1e4).toFixed(1)}万`;
  return `${sign}${abs.toFixed(2)}`;
}

/** 涨跌配色：正红负绿零灰，与行情区一致 */
function trSignClass(v) {
  if (!Number.isFinite(v) || v === 0) return 'flat';
  return v > 0 ? 'up' : 'down';
}

/** 'YYYY-MM-DD' → 'MM-DD'。年份在 340px 宽里占不起，完整日期进 title */
function trFmtDate(date) {
  return String(date || '').slice(5);
}

/** 方向标签。用单字「买/卖」而非「买入/卖出」——一行里要塞四项信息 */
function trSideLabel(side) {
  return side === 'sell' ? '卖' : '买';
}

/**
 * 渲染流水时间线（「什么时候加的仓」）。
 *
 * 倒序显示：最近的操作在最上面，与新闻列表的习惯一致。传入的 lots 是
 * replayTrades 的结果，本身按日期升序（回放需要），这里反转而不改原数组。
 *
 * @param {HTMLElement} container 会被清空
 * @param {Array} lots replayTrades 结果里的 lots（带 sharesAfter / avgCostAfter）
 * @param {{ onRemove?: (id: string) => void, oversold?: boolean }} [opts]
 */
function renderTradeList(container, lots, opts = {}) {
  const doc = container.ownerDocument;
  container.textContent = '';

  const list = Array.isArray(lots) ? lots : [];
  if (list.length === 0) {
    const empty = doc.createElement('div');
    empty.className = 'group-empty';
    empty.textContent = '还没有交易记录';
    container.appendChild(empty);
    return;
  }

  // 卖出多于持仓：数据有误（漏记买入或记错数量）。放在最上面而不是某一行旁边，
  // 因为问题出在整串流水的关系上，指不到具体某一笔
  if (opts.oversold) {
    const warn = doc.createElement('div');
    warn.className = 'trade-warn';
    warn.textContent = '卖出数量多于持仓，请检查是否漏记了买入';
    container.appendChild(warn);
  }

  for (let i = list.length - 1; i >= 0; i -= 1) {
    container.appendChild(tradeRow(doc, list[i], opts));
  }
}

/**
 * 一条流水：日期 + 方向 + 价格 × 数量 +（卖出的）已实现盈亏。
 */
function tradeRow(doc, lot, opts = {}) {
  const row = doc.createElement('div');
  row.className = `trade-row is-${lot.side === 'sell' ? 'sell' : 'buy'}`;

  const date = doc.createElement('span');
  date.className = 'trade-date';
  date.textContent = trFmtDate(lot.date);
  row.appendChild(date);

  const side = doc.createElement('span');
  side.className = `trade-side is-${lot.side === 'sell' ? 'sell' : 'buy'}`;
  side.textContent = trSideLabel(lot.side);
  row.appendChild(side);

  const deal = doc.createElement('span');
  deal.className = 'trade-deal';
  deal.textContent = `${trFmtPrice(lot.price)} × ${trFmtShares(lot.shares)}`;
  row.appendChild(deal);

  // 已实现盈亏只有卖出才有（买入恒为 0，显示 0 会让人以为「这笔白做了」）
  if (lot.side === 'sell' && Number.isFinite(lot.realized) && lot.realized !== 0) {
    const realized = doc.createElement('span');
    realized.className = `trade-realized ${trSignClass(lot.realized)}`;
    realized.textContent = trFmtMoney(lot.realized);
    row.appendChild(realized);
  }

  if (typeof opts.onRemove === 'function' && lot.id) {
    const del = doc.createElement('button');
    del.className = 'trade-remove';
    del.type = 'button';
    del.title = '删除这笔';
    del.textContent = '✕';
    del.addEventListener('click', () => opts.onRemove(lot.id));
    row.appendChild(del);
  }

  row.title = tradeRowTitle(lot);
  return row;
}

/**
 * 悬停提示：补上行里放不下的「这笔之后持仓变成多少」。
 *
 * 这是流水列表真正的价值所在 —— 单看「3-14 买 1620.5 × 100」不知道
 * 那时的总持仓与成本演变到了哪一步。
 */
function tradeRowTitle(lot) {
  if (!lot) return '';
  const parts = [`${lot.date} ${trSideLabel(lot.side)}入 ${trFmtPrice(lot.price)} × ${trFmtShares(lot.shares)}`];
  if (Number.isFinite(lot.sharesAfter)) {
    const after =
      lot.sharesAfter > 0
        ? `此后持仓 ${trFmtShares(lot.sharesAfter)}，成本 ${trFmtPrice(lot.avgCostAfter)}`
        : '此后已清仓';
    parts.push(after);
  }
  if (lot.side === 'sell' && Number.isFinite(lot.realized)) {
    parts.push(`本笔已实现 ${trFmtMoney(lot.realized)}`);
  }
  return parts.join('\n');
}

/**
 * 渲染「已实现盈亏」行（展开态详情区用）。
 *
 * 只在有流水时出现 —— 没记流水的股票显示一个「已实现 0.00」纯属占地方。
 *
 * @param {HTMLElement} container 会被清空
 * @param {object|null} data get-realized 的结果
 * @param {{ range?: 'month'|'all' }} [opts]
 */
function renderRealizedRow(container, data, opts = {}) {
  const doc = container.ownerDocument;
  container.textContent = '';

  if (!data || data.hasTrades === false) {
    container.className = 'realized-row hidden';
    return;
  }
  container.className = 'realized-row';

  const label = doc.createElement('span');
  label.className = 'realized-label';
  label.textContent = '已实现';
  container.appendChild(label);

  const value = doc.createElement('span');
  value.className = `realized-value ${trSignClass(data.total)}`;
  value.textContent = trFmtMoney(data.total);
  container.appendChild(value);

  // 区间切换 chip。范围写在按钮上而不是标签里，省一处文字
  const range = opts.range === 'month' ? 'month' : 'all';
  for (const [key, text] of [['month', '本月'], ['all', '全部']]) {
    const chip = doc.createElement('button');
    chip.className = `chip realized-chip${range === key ? ' on' : ''}`;
    chip.type = 'button';
    chip.textContent = text;
    chip.dataset.range = key;
    if (typeof opts.onRange === 'function') {
      chip.addEventListener('click', () => opts.onRange(key));
    }
    container.appendChild(chip);
  }

  // 口径必须说清：用户拿这个数对券商 App 一定对不上
  container.title = '已实现盈亏按加权平均成本法计算，不含手续费、印花税与过户费';
}

/**
 * 渲染设置面板里的流水编辑区。
 *
 * 340px 宽下唯一放得下的形态：紧凑列表 + 一个四格输入行。
 * 不做表格 —— 表头加四列在这个宽度里会挤成竖排。
 *
 * @param {HTMLElement} container 会被清空
 * @param {Array} trades 已规范化的流水
 * @param {{ onRemove?, onAdd?, error?: string }} [opts]
 */
function renderTradeEditor(container, trades, opts = {}) {
  const doc = container.ownerDocument;
  container.textContent = '';

  // 读流水文件失败时：明确说出来，且不显示空列表（那会让人以为流水丢了）
  if (opts.error) {
    const err = doc.createElement('div');
    err.className = 'error-box';
    err.textContent = opts.error;
    container.appendChild(err);
    return;
  }

  const list = Array.isArray(trades) ? trades : [];
  if (list.length === 0) {
    const hint = doc.createElement('div');
    hint.className = 'hint';
    hint.textContent = '填下面一行并按「＋」添加第一笔';
    container.appendChild(hint);
  } else {
    const box = doc.createElement('div');
    box.className = 'trade-editor-list';
    // 倒序：最近的在上面，与详情区的时间线一致
    for (let i = list.length - 1; i >= 0; i -= 1) {
      box.appendChild(editorRow(doc, list[i], opts));
    }
    container.appendChild(box);
  }
}

/** 编辑区的一行：日期 + 方向 + 价格×数量 + 删除 */
function editorRow(doc, trade, opts) {
  const row = doc.createElement('div');
  row.className = 'trade-edit-row';

  const date = doc.createElement('span');
  date.className = 'trade-date';
  date.textContent = trFmtDate(trade.date);
  row.appendChild(date);

  const side = doc.createElement('span');
  side.className = `trade-side is-${trade.side === 'sell' ? 'sell' : 'buy'}`;
  side.textContent = trSideLabel(trade.side);
  row.appendChild(side);

  const deal = doc.createElement('span');
  deal.className = 'trade-deal';
  deal.textContent = `${trFmtPrice(trade.price)} × ${trFmtShares(trade.shares)}`;
  row.appendChild(deal);

  if (typeof opts.onRemove === 'function' && trade.id) {
    const del = doc.createElement('button');
    del.className = 'watch-remove';
    del.type = 'button';
    del.title = '移除';
    del.textContent = '✕';
    del.addEventListener('click', () => opts.onRemove(trade.id));
    row.appendChild(del);
  }

  row.title = `${trade.date} ${trSideLabel(trade.side)} ${trFmtPrice(trade.price)} × ${trFmtShares(trade.shares)}`;
  return row;
}

/**
 * 持仓来源提示。
 *
 * 有流水时手填的成本价输入框会被忽略，必须说出来 —— 否则用户改了输入框
 * 发现盈亏没变，会以为是 bug。
 *
 * @param {object|null} summary replayTrades 的结果
 */
function holdingSourceHint(summary) {
  if (!summary || !Array.isArray(summary.lots) || summary.lots.length === 0) return '';
  if (summary.shares > 0) {
    return `持仓由流水推导：${trFmtShares(summary.shares)} 股，成本 ${trFmtPrice(summary.avgCost)}`;
  }
  return '流水显示已清仓，不显示浮动盈亏';
}

/** 分组头部的摘要文字：收起时也能看到最关键的一个数 */
function tradeHint(summary) {
  if (!summary || !Array.isArray(summary.lots) || summary.lots.length === 0) return '';
  if (summary.realized !== 0) return `已实现 ${trFmtMoney(summary.realized)}`;
  return `${summary.lots.length} 笔`;
}

/** 见文件头注释：导出对象名必须全局唯一 */
const TRADES_API = {
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
};

if (typeof module !== 'undefined' && module.exports) module.exports = TRADES_API;
if (typeof window !== 'undefined') window.StockTrades = TRADES_API;
