'use strict';

/**
 * 资金流向（东方财富）。
 *
 *   https://push2his.eastmoney.com/api/qt/stock/fflow/daykline/get?secid=1.600519&lmt=5
 *
 * 域名与路径都不能改，实测四种组合只有这一种给全量历史：
 *   push2his + daykline  → 10 天 × 15 段  ✓ 本模块用这个
 *   push2his + kline     → 10 天 × 6 段   （缺占比与收盘价）
 *   push2   + daykline   → 1 天  × 15 段
 *   push2   + kline      → 1 天  × 6 段   （lmt 给多少都只回 1 天）
 * 用 push2 域名时 lmt 被忽略，且 fields2 少给几段就直接返回 0 条。
 *
 * klines 每行逗号分隔，字段序已对实盘核对：
 *   [0] 日期  [1] 主力净额  [2] 小单净额  [3] 中单净额  [4] 大单净额  [5] 超大单净额
 *   [6] 主力净占比  [7] 小单占比  [8] 中单占比  [9] 大单占比  [10] 超大单占比
 *   [11] 收盘价  [12] 涨跌幅  [13][14] 恒为 0.00，用途不明，不解析
 * 金额单位是元。已验证「主力净额 = 大单净额 + 超大单净额」在多只标的上成立，
 * 也验证过 ETF 同样返回数据（不像公告接口要区分 A/FUND）。
 *
 * 口径提醒：这是**按单笔委托金额**划分的统计口径，不是真实的机构/散户身份，
 * 「主力」只是大额单的代称。UI 措辞需避免暗示这是机构行为。
 */

// secid 转换与 num 由 eastmoney 公共层提供（多个东财客户端共用，避免各写一份）
const { toSecid, num, PUSH2HIS_HOST, fetchWithHostFallback } = require('./eastmoney');

const FLOW_PATH = '/api/qt/stock/fflow/daykline/get';

const FLOW_URL = `https://${PUSH2HIS_HOST}${FLOW_PATH}`;

/** 默认取多少天。5 天够看趋势，再多会让 UI 挤不下 */
const DEFAULT_DAYS = 5;

/**
 * 解析单行 kline。字段不足时返回 null（调用方过滤掉）。
 * @param {string} line
 */
function parseFlowLine(line) {
  const f = String(line || '').split(',');
  if (f.length < 6) return null;

  const date = (f[0] || '').trim();
  if (!date) return null;

  return {
    date,
    /** 主力净流入（元）。正数为净买入 */
    main: num(f[1]),
    small: num(f[2]),
    medium: num(f[3]),
    large: num(f[4]),
    huge: num(f[5]),
    /** 各档净占比（%），接口未给时为 null */
    mainPct: num(f[6]),
    smallPct: num(f[7]),
    mediumPct: num(f[8]),
    largePct: num(f[9]),
    hugePct: num(f[10]),
    close: num(f[11]),
    changePct: num(f[12]),
  };
}

/**
 * 拉资金流向。
 * @param {string} code 形如 'sh600519'
 * @param {{ days?: number }} [params]
 * @returns {Promise<{ code: string, name: string, days: object[] }>}
 *          days 按日期升序，末项为最近一日；接口无数据时为 []
 */
async function fetchFlow(code, params = {}, opts = {}) {
  const secid = toSecid(code);
  if (!secid) throw new Error(`无法识别的代码：${code}`);

  const wanted = Math.round(Number(params.days));
  const days = Number.isFinite(wanted) && wanted > 0 ? Math.min(60, wanted) : DEFAULT_DAYS;

  // fields2 必须列全 f51~f65：少给几段接口会返回 0 条 klines（实测）
  const query = new URLSearchParams({
    secid,
    lmt: String(days),
    fields1: 'f1,f2,f3,f7',
    fields2: 'f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61,f62,f63,f64,f65',
  });

  const json = await fetchWithHostFallback([PUSH2HIS_HOST], `${FLOW_PATH}?${query.toString()}`, opts);

  return parseFlowResponse(json, code);
}

/**
 * 解析接口响应。抽出来单测，避免为了测字段序去发真实请求。
 * data 为 null 是常态（新股、停牌、指数），返回空 days 而不抛错。
 */
function parseFlowResponse(json, code = '') {
  const data = json && json.data;
  if (!data || !Array.isArray(data.klines)) {
    return { code, name: '', days: [] };
  }
  const days = data.klines.map(parseFlowLine).filter((d) => d != null);
  return {
    code,
    name: String(data.name || '').trim(),
    days,
  };
}

/**
 * 最近一日的资金流，附带自洽性校验结果。
 * 渲染层只需要「今天怎么样」，不必自己找末项。
 * @returns {object|null} days 为空时返回 null
 */
function latestFlow(flow) {
  const days = (flow && flow.days) || [];
  if (days.length === 0) return null;
  const last = days[days.length - 1];

  // 主力 = 大单 + 超大单。接口偶发缺字段时该校验为 null，UI 不必据此隐藏，
  // 只是留个标记便于排查口径变化。
  let consistent = null;
  if (last.main != null && last.large != null && last.huge != null) {
    consistent = Math.abs(last.main - (last.large + last.huge)) < Math.max(1, Math.abs(last.main) * 1e-6);
  }
  return { ...last, consistent };
}

module.exports = {
  fetchFlow,
  parseFlowLine,
  parseFlowResponse,
  latestFlow,
  // 转发 eastmoney 的 toSecid：已有单测与调用方按 flowClient.toSecid 引用
  toSecid,
  FLOW_URL,
  FLOW_PATH,
  DEFAULT_DAYS,
};
