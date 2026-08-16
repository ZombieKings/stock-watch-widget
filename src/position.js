'use strict';

/**
 * 持仓盈亏计算。
 *
 * 纯函数，不碰 DOM 也不发请求，便于单测——这里的坑集中在边界而非公式：
 *   1. 成本价为 0 时 (price-cost)/cost 得 Infinity，界面会显示「+Infinity%」
 *   2. 停牌/未开盘时 price 为 0 或 null，此时不该算出「亏损 100%」
 *   3. 数量留空 = 只记成本价，此时只有比例有意义，金额一律不给
 *   4. 浮点误差：1250 × 100 在 JS 里可能得 124999.99999999999，
 *      成本价与数量都可能带小数（基金份额），必须显式舍入
 */

/** 金额保留 2 位。成本×数量的浮点误差在这里收口 */
function round2(v) {
  return Math.round((v + Number.EPSILON) * 100) / 100;
}

/**
 * 成本价：正数才算有效。
 *
 * 0 和负数都不接受——0 会让盈亏率除零，负数没有现实含义。
 * 上限 1e7 是为了挡住误输入（把数量填进了成本价那格）。
 */
function parseCost(raw) {
  if (raw === '' || raw == null) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || n > 1e7) return null;
  // 保留 4 位小数：基金净值 4 位，港股/科创板也够用
  return Math.round(n * 1e4) / 1e4;
}

/**
 * 持仓数量：非负整数或小数（基金份额可以是小数）。
 *
 * 0 与留空同义——都表示「只记成本价，不算金额」。
 */
function parseShares(raw) {
  if (raw === '' || raw == null) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > 1e12) return null;
  if (n === 0) return null;
  return Math.round(n * 100) / 100;
}

/**
 * 算持仓盈亏。
 *
 * @param {object} p
 * @param {number|null} p.cost 成本价（每股/每份）
 * @param {number|null} p.shares 持仓数量，null = 只记成本价
 * @param {number|null} p.price 现价
 * @param {number|null} [p.change] 当日涨跌额，用于算当日盈亏
 * @returns {object|null} 无成本价或现价无效时返回 null（界面据此整块隐藏）
 */
function computePosition(p) {
  const cost = parseCost(p && p.cost);
  if (cost == null) return null;

  const price = Number(p && p.price);
  // 停牌、未开盘、接口异常都可能给 0 或非数字。
  // 这时算出来的「-100%」是假信息，宁可不显示
  if (!Number.isFinite(price) || price <= 0) return null;

  const shares = parseShares(p && p.shares);
  const diff = price - cost;

  const out = {
    cost,
    shares,
    /** 每股盈亏 */
    profitPerShare: round2(diff),
    /** 盈亏比例 %。cost > 0 已保证，不会除零 */
    profitPct: Math.round((diff / cost) * 1e4) / 100,
    /** 有数量才有金额 */
    hasAmount: shares != null,
    costValue: null,
    marketValue: null,
    profit: null,
    todayProfit: null,
  };

  if (shares != null) {
    out.costValue = round2(cost * shares);
    out.marketValue = round2(price * shares);
    // 用 marketValue - costValue 而非 diff*shares：两者数学上等价，
    // 但前者与界面上显示的两个金额自洽，不会出现「市值-成本≠盈亏」的观感
    out.profit = round2(out.marketValue - out.costValue);
    const change = Number(p && p.change);
    if (Number.isFinite(change)) out.todayProfit = round2(change * shares);
  }

  return out;
}

/**
 * 汇总多只持仓。
 *
 * 只统计**同时有成本价与数量**的条目——只填了成本价的算不出金额，
 * 计入会让总市值偏小、总盈亏率失真，不如明确排除并报告条数。
 *
 * @param {Array<{position?: object}>} items collectWatchlist 的结果
 */
function summarizePositions(items) {
  const list = Array.isArray(items) ? items : [];
  let costValue = 0;
  let marketValue = 0;
  let todayProfit = 0;
  let counted = 0;
  let hasToday = false;

  for (const it of list) {
    const pos = it && it.position;
    if (!pos || !pos.hasAmount) continue;
    costValue += pos.costValue;
    marketValue += pos.marketValue;
    if (pos.todayProfit != null) {
      todayProfit += pos.todayProfit;
      hasToday = true;
    }
    counted += 1;
  }

  if (counted === 0) return null;

  costValue = round2(costValue);
  marketValue = round2(marketValue);
  return {
    counted,
    costValue,
    marketValue,
    profit: round2(marketValue - costValue),
    // 总成本为 0 在这里不可能（parseCost 已排除 cost<=0，shares>0），
    // 但除法前仍兜一层，避免将来改动引入 NaN
    profitPct: costValue > 0 ? Math.round(((marketValue - costValue) / costValue) * 1e4) / 100 : null,
    todayProfit: hasToday ? round2(todayProfit) : null,
  };
}

module.exports = {
  round2,
  parseCost,
  parseShares,
  computePosition,
  summarizePositions,
};
