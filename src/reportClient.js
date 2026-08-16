'use strict';

/**
 * 机构研报评级客户端（东方财富）。
 *
 *   https://reportapi.eastmoney.com/report/list?qType=0&code=600519&pageSize=10
 *
 * 这是独立的 reportapi 域，不走数据中心那套 reportName/filter 协议，
 * 所以本模块不用 eastmoney.fetchReport。
 *
 * 已实测：
 *   1. 响应顶层就是 { hits, size, data: [...] }，没有 result 包装
 *   2. code 只接受 6 位数字，且**没有沪深歧义问题**：接口自己按证券库匹配，
 *      code=000001 返回的是深市平安银行（market='SHENZHEN'），不会串到沪市指数。
 *      仍返回 market 字段，可用它与本地交易所比对
 *   3. ETF（510300）与不存在的代码都返回 hits=0、data=[]，不报错
 *   4. 评级字段有两套：emRatingName（东财统一口径，如「买入」）与
 *      sRatingName（券商原文口径）。取前者，跨机构可比
 *   5. ratingChange 是评级变动，数值含义未公开，不解析
 *   6. predictThisYearEps / Pe 等预测值是**字符串**，可能是空串，须走 num()
 *   7. 详情页 https://data.eastmoney.com/report/zw_stock.jshtml?infocode=<infoCode>
 *      已验证可达且含标题
 *   8. author 是 ['11000214820.蔡雪昱', ...] 形式，researcher 字段已是逗号分隔的
 *      纯姓名，直接用后者
 */

const { fetchJson } = require('./http');
const { num, dateOnly } = require('./eastmoney');

const REPORT_LIST_URL = 'https://reportapi.eastmoney.com/report/list';

/** 详情页，用 infoCode 拼 */
const REPORT_DETAIL_URL = 'https://data.eastmoney.com/report/zw_stock.jshtml?infocode=';

/** 默认取几篇。研报区与新闻页平级，10 篇够翻 */
const DEFAULT_LIMIT = 10;

const MAX_LIMIT = 50;

/** 往前查多少年。研报按发布时间倒序，两年窗口足够覆盖最新的一批 */
const YEARS_BACK = 2;

/** YYYY-MM-DD */
function ymd(date) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
}

/**
 * 解析一篇研报。
 * @returns {object|null} 标题缺失时返回 null
 */
function parseReportItem(it) {
  if (!it || typeof it !== 'object') return null;
  const title = String(it.title || '').trim();
  if (!title) return null;

  const infoCode = String(it.infoCode || '').trim();

  return {
    title,
    /** 机构简称，如「中邮证券」。全称在 orgName，UI 空间有限用简称 */
    org: String(it.orgSName || it.orgName || '').trim(),
    /** 研究员，逗号分隔。researcher 已是纯姓名，不用解析 author 数组 */
    researcher: String(it.researcher || '').trim(),
    date: dateOnly(it.publishDate),
    /** 东财统一评级口径，如「买入」「增持」。跨机构可比 */
    rating: String(it.emRatingName || '').trim(),
    /** 券商原文评级，措辞各家不同 */
    ratingRaw: String(it.sRatingName || '').trim(),
    /** 所属行业（东财细分），如「白酒Ⅱ」 */
    industry: String(it.indvInduName || '').trim(),
    /** 今年 / 明年 / 后年的 EPS 与 PE 预测。接口给字符串，可能为空 */
    epsThisYear: num(it.predictThisYearEps),
    peThisYear: num(it.predictThisYearPe),
    epsNextYear: num(it.predictNextYearEps),
    peNextYear: num(it.predictNextYearPe),
    /** 研报页数，可判断是深度报告还是点评 */
    pages: num(it.attachPages),
    url: infoCode ? `${REPORT_DETAIL_URL}${encodeURIComponent(infoCode)}` : '',
  };
}

/**
 * 拉个股研报。
 *
 * @param {string} digits 6 位纯数字代码。接口只吃这个，不要传 sh600519
 * @param {{ limit?: number, now?: Date }} [params] now 可注入，便于测试
 * @returns {Promise<{ digits, items: object[], total: number, summary: object }>}
 *          无研报（ETF、冷门股）时 items 为 []，不抛错
 */
async function fetchReports(digits, params = {}, opts = {}) {
  const code = String(digits || '').trim();
  if (!/^\d{6}$/.test(code)) throw new Error(`研报接口需要 6 位代码，收到：${digits}`);

  const wanted = Math.round(Number(params.limit));
  const limit = Number.isFinite(wanted) && wanted > 0 ? Math.min(MAX_LIMIT, wanted) : DEFAULT_LIMIT;

  const now = params.now instanceof Date ? params.now : new Date();
  const begin = new Date(now.getFullYear() - YEARS_BACK, now.getMonth(), now.getDate());

  const query = new URLSearchParams({
    industryCode: '*',
    pageSize: String(limit),
    pageNo: '1',
    qType: '0', // 0 = 个股研报
    code,
    beginTime: ymd(begin),
    endTime: ymd(now),
  });

  const json = await fetchJson(`${REPORT_LIST_URL}?${query.toString()}`, opts);
  return buildReports(json, code);
}

/** 响应 → 渲染层形状。抽出来单测 */
function buildReports(json, digits = '') {
  const raw = json && Array.isArray(json.data) ? json.data : [];
  const items = raw.map(parseReportItem).filter((x) => x != null);

  return {
    digits,
    items,
    /** 命中总数（可能远大于 items.length，用于「共 N 篇」文案） */
    total: Number(json && json.hits) || items.length,
    summary: summarizeRatings(items),
  };
}

/**
 * 评级分布汇总。
 *
 * 只做计数不做加权打分：各家评级口径不完全可比，算出一个「平均分」会显得
 * 比实际更精确。UI 展示「买入 7 / 增持 2」这种原始分布，让用户自己判断。
 *
 * @returns {{ counts: Array<[string, number]>, top: string, total: number }}
 *          counts 按出现次数降序
 */
function summarizeRatings(items) {
  const map = new Map();
  for (const it of items) {
    if (!it.rating) continue;
    map.set(it.rating, (map.get(it.rating) || 0) + 1);
  }
  const counts = [...map.entries()].sort((a, b) => b[1] - a[1]);
  return {
    counts,
    /** 出现最多的评级，UI 在收起态显示这一个 */
    top: counts.length > 0 ? counts[0][0] : '',
    total: items.filter((it) => it.rating).length,
  };
}

module.exports = {
  fetchReports,
  parseReportItem,
  buildReports,
  summarizeRatings,
  REPORT_LIST_URL,
  REPORT_DETAIL_URL,
  DEFAULT_LIMIT,
  MAX_LIMIT,
};
