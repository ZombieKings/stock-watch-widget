'use strict';

/**
 * 交易流水与已实现盈亏（加权平均成本法）。
 *
 * 纯函数，不碰文件也不发请求 —— 落盘在 tradeStore.js。坑集中在四处：
 *
 *   1. **卖出不改变加权平均成本**。写成「卖出后重算平均」就变成了移动加权，
 *      同一串流水会算出不同的已实现盈亏。这是本文件最容易写错的一条。
 *   2. 清仓后再买入要从新买入价重算，不受历史成本影响 —— 否则「割肉后抄底」
 *      会把旧成本带进新仓位。
 *   3. 已实现盈亏按**卖出**日期归月：买入不产生盈亏，按买入日归月会把
 *      去年买、今年卖的收益记到去年。
 *   4. 浮点误差：1620.5 × 100 在 JS 里不是整数，累加几十笔后金额会漂。
 *      与 position.js 同一个解法，复用它的 round2。
 *
 * 口径说明：**不含手续费、印花税、过户费**。加进来要引入「不同券商不同费率」
 * 「费率随时间变」一串问题，超出轻量版的边界；界面上明确标注，
 * 用户拿它和券商 App 对不上是预期行为。
 */

const { round2, parseCost, parseShares } = require('./position');

/** 买卖方向 */
const SIDES = ['buy', 'sell'];

/**
 * 单价保留 4 位小数，与 position.parseCost 的精度一致。
 *
 * 不能用 round2 收口加权平均成本：基金净值本来就是 4 位小数（1.2345），
 * 舍到 2 位会把它变成 1.23，误差 0.4% —— 在盈亏计算里这不是舍入噪声而是错。
 * 金额（成本额、已实现盈亏）仍用 round2，那是「元」的精度。
 */
function round4(v) {
  return Math.round((v + Number.EPSILON) * 1e4) / 1e4;
}

/**
 * 单只股票最多存多少笔流水。
 *
 * 500 笔下全量回放的成本可以忽略（O(n)），且 trades.json 也就几十 KB。
 * 放开上限的话 get-detail 每次调用都回放一遍会成为盘中每 3 秒的固定开销 ——
 * 那时该在 tradeStore 里加 memo，而不是把上限提高。
 */
const MAX_TRADES = 500;

/**
 * 日期是否是真实存在的一天。
 *
 * 只验格式不够：'2026-02-30' 符合 YYYY-MM-DD 但不存在，Date 会把它
 * 静默滚到 3 月 2 日，于是流水的排序与月度归集都会错位。
 */
function isValidDateKey(raw) {
  const s = String(raw == null ? '' : raw).trim();
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return false;
  const [, y, mo, d] = m.map(Number);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return false;
  // 用 UTC 构造避免本地时区把日期推前一天
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

/** 从 'YYYY-MM-DD' 取 'YYYY-MM'。跨年月份键不会冲突（含年份） */
function monthKey(date) {
  return String(date || '').slice(0, 7);
}

/**
 * 规范化单笔流水。任何一项不合法就整条丢弃 —— 半条流水会让回放静默算错，
 * 不如当它不存在（tradeStore 会把丢弃计数报给界面）。
 *
 * @param {object} raw
 * @returns {{id, date, side, price, shares}|null}
 */
function normalizeTrade(raw) {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (!isValidDateKey(raw.date)) return null;

  const side = String(raw.side || '').trim();
  if (!SIDES.includes(side)) return null;

  // 价格与数量复用持仓那套校验：0 与负数一律拒绝。
  // 0 价流水（送股、转增）本轻量版不支持——它需要单独的方向类型，
  // 硬塞成 0 价买入会把加权平均成本算成 0
  const price = parseCost(raw.price);
  if (price == null) return null;
  const shares = parseShares(raw.shares);
  if (shares == null) return null;

  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : '',
    date: String(raw.date).trim(),
    side,
    price,
    shares,
  };
}

/**
 * 规范化某只股票的流水数组：逐笔校验、按日期升序、截到上限。
 *
 * 排序必须**稳定**：同一天可能有多笔（早上买、下午卖），输入顺序就是发生顺序，
 * 打乱会让「当天先买后卖」变成「先卖后买」，回放出 oversold。
 * Array.prototype.sort 在 V8 里已保证稳定，这里靠它。
 *
 * 截断从**末尾**截（保留最早的）：加权平均成本依赖完整历史，砍掉早期买入
 * 会让成本凭空变化。超限时新流水加不进去，比静默算错好。
 */
function normalizeTrades(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const out = [];
  for (const item of list) {
    const t = normalizeTrade(item);
    if (t) out.push(t);
  }
  out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return out.slice(0, MAX_TRADES);
}

/**
 * 规范化整个账本 { [code]: Trade[] }。
 *
 * 代码键由调用方（tradeStore）用 normalizeCode 校验后传入 —— 本模块不认识
 * 股票代码格式，保持纯粹。空数组的键会被删掉，否则「加了又删」会让文件
 * 随操作单调膨胀。
 */
function normalizeTradeBook(raw) {
  const src = raw != null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const out = {};
  for (const [code, list] of Object.entries(src)) {
    const norm = normalizeTrades(list);
    if (norm.length > 0) out[code] = norm;
  }
  return out;
}

/**
 * 回放流水，算出期末持仓、加权平均成本与已实现盈亏。
 *
 * 加权平均成本法：
 *   买入 → avgCost = (原持仓成本额 + 本次买入额) / (原持仓 + 本次数量)
 *   卖出 → realized += (卖出价 - avgCost) × 卖出数量，**avgCost 不变**
 *
 * @param {Array} trades 已规范化的流水（未规范化的会在这里再过一遍）
 * @returns {{
 *   shares: number, avgCost: number|null, realized: number,
 *   realizedByMonth: object, oversold: boolean, lots: Array
 * }}
 */
function replayTrades(trades) {
  const list = normalizeTrades(trades);

  let shares = 0;
  /** 当前持仓的总成本额。avgCost 由它除以 shares 得出，避免反复乘除累积误差 */
  let costValue = 0;
  let realized = 0;
  const realizedByMonth = {};
  let oversold = false;
  const lots = [];

  for (const t of list) {
    let lotRealized = 0;

    if (t.side === 'buy') {
      // 成本额用 4 位而非 2 位：它是 avgCost 的被除数，先舍到分再相除会把
      // 基金那种 4 位净价的精度提前丢掉（1.2345 × 1234.56 舍到分再除会偏）
      costValue = round4(costValue + t.price * t.shares);
      shares = round2(shares + t.shares);
    } else {
      // 卖出超过持仓：数据有误（漏记买入、或记错数量）。
      // 按「最多卖掉手上全部」处理并置位，绝不产出负持仓 ——
      // 负持仓会让 avgCost 变成负数，后面每一笔都跟着错
      const sellable = Math.min(t.shares, shares);
      if (t.shares > shares) oversold = true;

      if (sellable > 0) {
        const avg = shares > 0 ? costValue / shares : 0;
        lotRealized = round2((t.price - avg) * sellable);
        realized = round2(realized + lotRealized);
        const mk = monthKey(t.date);
        realizedByMonth[mk] = round2((realizedByMonth[mk] || 0) + lotRealized);

        // 卖出**不改变** avgCost：按比例扣减成本额与持仓，两者的商保持不变。
        // 这是加权平均法的核心，写成「卖出后重算平均」就变成移动加权了
        costValue = round4(costValue - avg * sellable);
        shares = round2(shares - sellable);
      }
      // 清仓后成本额归零：浮点减法可能留下 0.01 的残值，
      // 带着它再买入会让新的 avgCost 偏高
      if (shares <= 0) {
        shares = 0;
        costValue = 0;
      }
    }

    lots.push({
      ...t,
      /** 本笔产生的已实现盈亏。买入恒为 0 */
      realized: lotRealized,
      /** 本笔之后的持仓与成本，界面「什么时候加的仓」靠它显示演变过程 */
      sharesAfter: shares,
      avgCostAfter: shares > 0 ? round4(costValue / shares) : null,
    });
  }

  return {
    shares,
    // 无持仓时为 null 而非 0：0 会让 computePosition 算出「亏损 100%」，
    // null 才让它整块返回 null，界面隐藏浮动盈亏
    avgCost: shares > 0 ? round4(costValue / shares) : null,
    realized,
    realizedByMonth,
    oversold,
    lots,
  };
}

/**
 * 按区间取已实现盈亏。
 *
 * @param {object} summary replayTrades 的结果
 * @param {'month'|'all'} range
 * @param {string} [today] 'YYYY-MM-DD'，默认当天。传入以便单测不依赖真实时钟
 */
function realizedInRange(summary, range, today) {
  if (!summary) return 0;
  if (range !== 'month') return summary.realized || 0;
  const key = monthKey(today || localToday());
  return (summary.realizedByMonth || {})[key] || 0;
}

/** 本地当天 'YYYY-MM-DD'。不用 toISOString，避免 UTC 偏移串日 */
function localToday(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * 从流水推导出持仓，形状与 watchlist 条目的 cost/shares 一致。
 *
 * 输出可直接喂给 position.computePosition —— main.js 的 effectiveHolding
 * 靠这个契约把「流水推导的持仓」无缝替换掉「用户手填的持仓」。
 *
 * 已清仓时 cost 为 null，computePosition 会返回 null，界面隐藏浮动盈亏 ——
 * 这是对的：已清仓的股票没有浮动盈亏，它的收益全在「已实现」那一栏。
 *
 * @returns {{ cost: number|null, shares: number|null }}
 */
function derivePosition(trades) {
  const s = replayTrades(trades);
  return {
    cost: s.avgCost,
    // shares 为 0 时给 null 而非 0：parseShares 把 0 当「未设置」，
    // 保持同一套语义，免得下游要判两种「没有持仓」
    shares: s.shares > 0 ? s.shares : null,
  };
}

module.exports = {
  SIDES,
  MAX_TRADES,
  round4,
  isValidDateKey,
  monthKey,
  localToday,
  normalizeTrade,
  normalizeTrades,
  normalizeTradeBook,
  replayTrades,
  realizedInRange,
  derivePosition,
};
