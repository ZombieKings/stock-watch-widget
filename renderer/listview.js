'use strict';

/**
 * 列表模式（多股同屏）的行渲染。
 *
 * 只做「数据 → DOM」，不碰 window.api、不管定时器、不读 state ——
 * 与 groups.js 同一套约定，因此能在 node 下用手写 DOM 桩单测。
 * 取数、模式切换、窗口定高都留在 renderer.js。
 *
 * 顶层符号一律加 LIST_ 前缀：renderer/ 下的脚本共享全局作用域，
 * 与 renderer.js 已有的 fmtPrice / fmtPct / dirClass 重名会在**解析期**抛错，
 * 整个文件一行都不执行（window.StockListView 变 undefined），
 * 而 node 单测照样全绿——每个文件在 node 里是独立模块作用域，撞不上。
 * 所以下面几个格式化函数是刻意重写而非复用，几行重复换一个隔离。
 */

/** 价格：与 renderer.js 的 fmtPrice 同口径，2 位小数 */
function listFmtPrice(v) {
  return Number.isFinite(v) ? v.toFixed(2) : '--';
}

/** 涨跌幅：带符号，2 位小数 */
function listFmtPct(v) {
  if (!Number.isFinite(v)) return '--';
  return `${v > 0 ? '+' : ''}${v.toFixed(2)}%`;
}

/** 涨跌方向 → CSS class。红涨绿跌，与行情区共用一套配色 */
function listDirClass(v) {
  if (!Number.isFinite(v) || v === 0) return 'flat';
  return v > 0 ? 'up' : 'down';
}

/**
 * 一行显示的名称。
 *
 * 只做取值优先级（别名 > 行情名 > 代码），截断交给 CSS 的 ellipsis ——
 * 在 JS 里按字符数截会在中英混排时算错宽度（「贵州茅台」4 字比 "GuizhouMoutai"
 * 13 字更宽），而 CSS 按实际渲染宽度截，永远准。
 */
function listNameText(item) {
  if (!item) return '--';
  return item.alias || item.name || item.digits || item.code || '--';
}

/**
 * 画列表模式的所有行。
 *
 * @param {HTMLElement} container 会被清空
 * @param {Array} items collectWatchlist 的 items
 * @param {{ selected?: string, onPick?: (code: string) => void }} [opts]
 */
function renderList(container, items, opts = {}) {
  const doc = container.ownerDocument;
  container.textContent = '';

  const list = Array.isArray(items) ? items : [];
  if (list.length === 0) {
    const empty = doc.createElement('div');
    empty.className = 'list-empty';
    empty.textContent = '还没有关注的股票，点 ⚙ 添加';
    container.appendChild(empty);
    return;
  }

  for (const item of list) {
    container.appendChild(listRow(doc, item, opts));
  }
}

/**
 * 一行：名称 + 现价 + 涨跌幅（+ 持仓盈亏徽标）。
 *
 * 340px 宽下的排布取舍：价格与涨跌幅 flex-shrink:0，宁可截断名称也不压数字 ——
 * 数字被切掉半位没法读，名称省略号是可预期的（完整名称在 title 里）。
 * 与 .collapsed-price 同一套理由。
 */
function listRow(doc, item, opts = {}) {
  const row = doc.createElement('div');
  const isActive = Boolean(opts.selected && item.code === opts.selected);
  row.className = `list-row${isActive ? ' active' : ''}`;
  row.setAttribute('role', 'option');
  row.setAttribute('aria-selected', String(isActive));

  const name = doc.createElement('span');
  name.className = 'list-name';
  name.textContent = listNameText(item);
  row.appendChild(name);

  // 持仓盈亏徽标：只在设了成本价时出现。
  // 放在名称之后、价格之前，这样它出现与消失都不会推动右侧的数字
  const pos = item.position;
  if (pos && Number.isFinite(pos.profitPct)) {
    const hold = doc.createElement('span');
    hold.className = `list-hold ${listDirClass(pos.profitPct)}`;
    hold.textContent = `持${listFmtPct(pos.profitPct)}`;
    row.appendChild(hold);
    // 有徽标时名称能用的横向空间变小，标出来让 CSS 收紧 max-width
    row.classList.add('has-hold');
  }

  if (item.error) {
    // 拿不到行情：把错误显示在价格位置，而不是摆两个 '--' 让人以为在停牌
    const err = doc.createElement('span');
    err.className = 'list-error';
    err.textContent = item.error;
    row.appendChild(err);
  } else {
    const cls = listDirClass(item.change);

    const price = doc.createElement('span');
    price.className = `list-price ${cls}`;
    price.textContent = listFmtPrice(item.price);
    row.appendChild(price);

    const pct = doc.createElement('span');
    pct.className = `list-pct ${cls}`;
    pct.textContent = listFmtPct(item.changePct);
    row.appendChild(pct);
  }

  row.title = listRowTitle(item);

  if (typeof opts.onPick === 'function' && item.code) {
    row.classList.add('is-clickable');
    row.addEventListener('click', () => opts.onPick(item.code));
  }
  return row;
}

/**
 * 悬停提示：把行里放不下的信息补齐。
 *
 * 列表模式一行只有约 320px 可用，装不下开高低与持仓明细，
 * 但收盘复盘时想看 —— 放进 title 是零成本的去处。
 */
function listRowTitle(item) {
  if (!item) return '';
  const parts = [`${listNameText(item)} ${item.digits || ''}`.trim()];

  if (item.error) {
    parts.push(item.error);
    return parts.join('\n');
  }

  parts.push(`价 ${listFmtPrice(item.price)}  ${listFmtPct(item.changePct)}`);

  const pos = item.position;
  if (pos && Number.isFinite(pos.profitPct)) {
    if (pos.hasAmount) {
      parts.push(`成本 ${listFmtPrice(pos.cost)} × ${pos.shares}`);
      parts.push(`盈亏 ${listFmtMoney(pos.profit)} (${listFmtPct(pos.profitPct)})`);
    } else {
      parts.push(`成本 ${listFmtPrice(pos.cost)}  持仓 ${listFmtPct(pos.profitPct)}`);
    }
  }
  return parts.join('\n');
}

/** 金额：带符号，万/亿分档。只在 title 里用，不进 DOM 布局 */
function listFmtMoney(v) {
  if (!Number.isFinite(v)) return '--';
  const sign = v > 0 ? '+' : v < 0 ? '-' : '';
  const abs = Math.abs(v);
  if (abs >= 1e8) return `${sign}${(abs / 1e8).toFixed(2)}亿`;
  if (abs >= 1e6) return `${sign}${(abs / 1e4).toFixed(1)}万`;
  return `${sign}${abs.toFixed(2)}`;
}

/**
 * 列表底部的持仓汇总行。
 *
 * 与关注列表下拉里的 renderWatchSummary 是同一份数据（summarizePositions 的结果），
 * 但那边在下拉面板里、这边在列表模式里，两处 DOM 结构不同，没有复用 ——
 * 那个函数直接读 state.watchlist 算「只填成本价」的条数，是有状态的。
 *
 * @param {HTMLElement} container 会被清空
 * @param {object|null} summary 无持仓时为 null，此时整行不出现
 */
function renderListSummary(container, summary) {
  const doc = container.ownerDocument;
  container.textContent = '';
  if (!summary) {
    container.className = 'list-summary hidden';
    return;
  }
  container.className = 'list-summary';

  const label = doc.createElement('span');
  label.className = 'list-summary-label';
  label.textContent = `持仓 (${summary.counted})`;
  container.appendChild(label);

  const profit = doc.createElement('span');
  profit.className = `list-summary-profit ${listDirClass(summary.profit)}`;
  profit.textContent = listFmtMoney(summary.profit);
  container.appendChild(profit);

  const pct = doc.createElement('span');
  pct.className = `list-summary-pct ${listDirClass(summary.profit)}`;
  pct.textContent = listFmtPct(summary.profitPct);
  container.appendChild(pct);

  const tips = [
    `总成本 ${listFmtMoney(summary.costValue)}`,
    `总市值 ${listFmtMoney(summary.marketValue)}`,
    `盈亏 ${listFmtMoney(summary.profit)} (${listFmtPct(summary.profitPct)})`,
  ];
  if (summary.todayProfit != null) tips.push(`当日盈亏 ${listFmtMoney(summary.todayProfit)}`);
  container.title = tips.join('\n');
}

/** 见文件头注释：导出对象名必须全局唯一 */
const LIST_API = {
  renderList,
  listRow,
  listRowTitle,
  listNameText,
  renderListSummary,
  listFmtPrice,
  listFmtPct,
  listFmtMoney,
  listDirClass,
};

if (typeof module !== 'undefined' && module.exports) module.exports = LIST_API;
if (typeof window !== 'undefined') window.StockListView = LIST_API;
