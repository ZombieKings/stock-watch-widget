'use strict';

/**
 * 龙虎榜客户端（东方财富数据中心）。
 *
 *   reportName=RPT_DAILYBILLBOARD_DETAILSNEW，filter=(SECUCODE="002913.SZ")
 *
 * 已实测：
 *   1. 必须用 SECUCODE 过滤。用 6 位 SECURITY_CODE 查 000001 会拿到深市平安银行，
 *      沪市指数会被张冠李戴（见 eastmoney.toSecucode 注释）
 *   2. 上榜记录可能非常稀疏：茅台最近一条是 2013 年。所以要按日期判断新鲜度，
 *      不能拿「有记录」当成「最近上榜」
 *   3. ETF 返回 code 9201「返回数据为空」——ETF 不上龙虎榜
 *   4. EXPLANATION 是上榜原因（如「日涨幅偏离值达到7%的前5只证券」），
 *      EXPLAIN 是营业部摘要（如「4家机构买入，成功率15.98%」），两者都有用
 *   5. D1/D2/D5/D10_CLOSE_ADJCHRATE 是上榜后 N 日涨跌幅，最新一条为 null
 *      （还没走完），历史记录才有值
 *
 * 字段名对照：
 *   BILLBOARD_BUY_AMT 龙虎榜买入额   BILLBOARD_SELL_AMT 卖出额
 *   BILLBOARD_NET_AMT 净买入额       BILLBOARD_DEAL_AMT 榜单成交总额
 *   ACCUM_AMOUNT 当日全市场成交额     DEAL_AMOUNT_RATIO 榜单成交占比%
 *   CHANGE_RATE 当日涨跌幅%          TURNOVERRATE 换手率%
 */

const { toSecucode, num, dateOnly, fetchReport, eqFilter, DATACENTER_WEB } = require('./eastmoney');

const REPORT_NAME = 'RPT_DAILYBILLBOARD_DETAILSNEW';

/** 默认取几条上榜记录 */
const DEFAULT_LIMIT = 5;

const MAX_LIMIT = 30;

/**
 * 「最近上榜」的天数阈值。
 *
 * 超过这个天数就只当历史记录看：龙虎榜的信息价值集中在刚上榜那几天，
 * 2013 年那条对今天的判断没有意义。UI 据此决定摘要里说不说话。
 */
const RECENT_DAYS = 30;

/**
 * 解析一条上榜记录。
 * @returns {object|null} 日期缺失时返回 null
 */
function parseLhbRow(row) {
  if (!row || typeof row !== 'object') return null;
  const date = dateOnly(row.TRADE_DATE);
  if (!date) return null;

  return {
    date,
    name: String(row.SECURITY_NAME_ABBR || '').trim(),
    /** 上榜原因，如「日涨幅偏离值达到7%的前5只证券」 */
    reason: String(row.EXPLANATION || '').trim(),
    /** 营业部摘要，如「4家机构买入，成功率15.98%」。可能为空 */
    seatNote: String(row.EXPLAIN || '').trim(),
    /** 龙虎榜买入额（元） */
    buyAmount: num(row.BILLBOARD_BUY_AMT),
    /** 龙虎榜卖出额（元） */
    sellAmount: num(row.BILLBOARD_SELL_AMT),
    /** 净买入额（元）。正数为净买入 */
    netAmount: num(row.BILLBOARD_NET_AMT),
    /** 榜单成交额占当日全市场成交额比例（%） */
    dealRatio: num(row.DEAL_AMOUNT_RATIO),
    /** 当日成交额（元） */
    totalAmount: num(row.ACCUM_AMOUNT),
    close: num(row.CLOSE_PRICE),
    changePct: num(row.CHANGE_RATE),
    turnover: num(row.TURNOVERRATE),
    /** 上榜后 1/5/10 日涨跌幅（%）。最新一条尚未走完，为 null */
    after1d: num(row.D1_CLOSE_ADJCHRATE),
    after5d: num(row.D5_CLOSE_ADJCHRATE),
    after10d: num(row.D10_CLOSE_ADJCHRATE),
  };
}

/**
 * 拉龙虎榜。
 *
 * @param {string} code 形如 'sh600519'
 * @param {{ limit?: number, now?: Date }} [params] now 可注入，便于测试新鲜度判定
 * @returns {Promise<{ code, items, latest, isRecent, daysSince }>}
 *          从未上榜时 items 为 []，不抛错
 */
async function fetchLhb(code, params = {}, opts = {}) {
  const secucode = toSecucode(code);
  if (!secucode) throw new Error(`无法识别的代码：${code}`);

  const wanted = Math.round(Number(params.limit));
  const limit = Number.isFinite(wanted) && wanted > 0 ? Math.min(MAX_LIMIT, wanted) : DEFAULT_LIMIT;

  const { rows, count } = await fetchReport(
    DATACENTER_WEB,
    {
      reportName: REPORT_NAME,
      columns: 'ALL',
      filter: eqFilter('SECUCODE', secucode),
      pageSize: String(limit),
      pageNumber: '1',
      sortColumns: 'TRADE_DATE',
      sortTypes: '-1',
    },
    opts
  );

  return buildLhb(rows, code, { now: params.now, total: count });
}

/**
 * 报表行 → 渲染层形状。抽出来单测。
 *
 * @param {object[]} rows
 * @param {{ now?: Date, total?: number }} [opts]
 */
function buildLhb(rows, code = '', opts = {}) {
  const list = (Array.isArray(rows) ? rows : []).map(parseLhbRow).filter((d) => d != null);
  // 倒序（最新在前）：不假定接口一定按 sortTypes 给
  list.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

  const latest = list.length > 0 ? list[0] : null;
  const now = opts.now instanceof Date ? opts.now : new Date();
  const daysSince = latest ? daysBetween(latest.date, now) : null;

  return {
    code,
    items: list,
    latest,
    /** 距最近一次上榜多少天。无记录时为 null */
    daysSince,
    /**
     * 最近一次上榜是否还算「近期」。
     * 用它而不是 items.length > 0 来决定摘要说不说话——茅台 2013 年上过榜，
     * 摘要里写「上榜」会误导。
     */
    isRecent: daysSince != null && daysSince <= RECENT_DAYS,
    /** 历史上榜总次数（接口给的 count，可能大于 items.length） */
    total: Number(opts.total) || list.length,
  };
}

/**
 * 'YYYY-MM-DD' 到 now 相差多少天（向下取整，同日为 0）。
 * 解析失败返回 null。
 */
function daysBetween(dateStr, now) {
  const m = String(dateStr || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  // 用本地时间构造，与 marketTime.localDateKey 同口径，避免 UTC 偏移串日
  const then = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const diff = Math.round((today - then) / 86400000);
  return Number.isFinite(diff) ? diff : null;
}

module.exports = {
  fetchLhb,
  parseLhbRow,
  buildLhb,
  daysBetween,
  REPORT_NAME,
  DEFAULT_LIMIT,
  MAX_LIMIT,
  RECENT_DAYS,
};
