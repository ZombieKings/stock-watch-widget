'use strict';

/**
 * 融资融券客户端（东方财富数据中心）。
 *
 *   reportName=RPTA_WEB_RZRQ_GGMX，filter=(SECUCODE="600519.SH")
 *
 * 与资金流向是互补口径，不是重复：资金流向按**单笔委托金额**分档统计当日买卖，
 * 融资融券是**杠杆资金余额**的逐日变化，反映的是持续性而非当日强弱。
 *
 * 已实测的要点：
 *   1. 报表名必须是 `RPTA_WEB_RZRQ_GGMX`。网上常见的 `RPT_MARGIN_DAILYDETAIL`
 *      已失效，返回 code 9501「报表配置不存在」
 *   2. 必须用 SECUCODE 过滤而非 6 位 SCODE：`SCODE="000001"` 会命中深市平安银行，
 *      沪市指数 000001 拿到的会是平安银行的两融数据
 *   3. ETF 也是两融标的（510300 有数据），但 SZ（流通市值）与 RZYEZB（余额占比）为 null
 *   4. 非两融标的返回 code 9201「返回数据为空」，eastmoney.fetchReport 会转成空数组
 *   5. 数据是 T-1 的：盘中查到的最新一条是上一交易日收盘后统计的
 *
 * 字段名对照（东财原名 → 含义）：
 *   RZYE 融资余额(元)  RQYE 融券余额(元)  RZRQYE 两融余额合计
 *   RZMRE 融资买入额   RZCHE 融资偿还额   RZJME 融资净买入(买入-偿还)
 *   RQYL 融券余量(股)  RQMCL 融券卖出量   RQCHL 融券偿还量
 *   RZYEZB 融资余额占流通市值%   SPJ 收盘价   ZDF 涨跌幅%
 *   带 3D/5D/10D 后缀的是近 N 日累计
 */

const { toSecucode, num, dateOnly, fetchReport, eqFilter, DATACENTER_WEB } = require('./eastmoney');

const REPORT_NAME = 'RPTA_WEB_RZRQ_GGMX';

/** 默认取多少天。与资金流的 5 天对齐，UI 上两块并排看得顺 */
const DEFAULT_DAYS = 5;

/** 上限：再多迷你柱也画不下，且请求会变慢 */
const MAX_DAYS = 60;

/**
 * 解析一行报表。
 * @returns {object|null} 日期缺失时返回 null
 */
function parseMarginRow(row) {
  if (!row || typeof row !== 'object') return null;
  const date = dateOnly(row.DATE);
  if (!date) return null;

  return {
    date,
    name: String(row.SECNAME || '').trim(),
    /** 融资余额（元）—— 看多方向的杠杆存量 */
    finBalance: num(row.RZYE),
    /** 融券余额（元）—— 看空方向 */
    shortBalance: num(row.RQYE),
    /** 两融余额合计（元） */
    totalBalance: num(row.RZRQYE),
    /** 融资买入额（元） */
    finBuy: num(row.RZMRE),
    /** 融资偿还额（元） */
    finRepay: num(row.RZCHE),
    /**
     * 融资净买入（元）= 买入 - 偿还。接口直接给 RZJME，
     * 不自己减：已核对两者一致，用接口值免去处理缺字段的边角
     */
    finNet: num(row.RZJME),
    /** 融券余量（股） */
    shortVolume: num(row.RQYL),
    /** 融资余额占流通市值（%）。ETF 为 null */
    finBalanceRatio: num(row.RZYEZB),
    /** 近 5 日融资净买入累计（元） */
    finNet5d: num(row.RZJME5D),
    close: num(row.SPJ),
    changePct: num(row.ZDF),
  };
}

/**
 * 拉融资融券。
 *
 * @param {string} code 形如 'sh600519'
 * @param {{ days?: number }} [params]
 * @returns {Promise<{ code, name, days, latest, finNetSum, fetchedAt? }>}
 *          days 按日期**升序**（末项最新），与 flowClient 一致，方便渲染层共用画柱逻辑。
 *          非两融标的返回空 days，不抛错
 */
async function fetchMargin(code, params = {}, opts = {}) {
  const secucode = toSecucode(code);
  if (!secucode) throw new Error(`无法识别的代码：${code}`);

  const wanted = Math.round(Number(params.days));
  const days = Number.isFinite(wanted) && wanted > 0 ? Math.min(MAX_DAYS, wanted) : DEFAULT_DAYS;

  const { rows } = await fetchReport(
    DATACENTER_WEB,
    {
      reportName: REPORT_NAME,
      columns: 'ALL',
      filter: eqFilter('SECUCODE', secucode),
      pageSize: String(days),
      pageNumber: '1',
      // 接口按日期倒序给（最新在前），解析后再反转成升序
      sortColumns: 'DATE',
      sortTypes: '-1',
    },
    opts
  );

  return buildMargin(rows, code);
}

/**
 * 报表行 → 渲染层直接可用的形状。抽出来单测。
 * @param {object[]} rows fetchReport 的 rows
 */
function buildMargin(rows, code = '') {
  const list = (Array.isArray(rows) ? rows : []).map(parseMarginRow).filter((d) => d != null);

  // 接口倒序 → 升序。不假定它一定倒序，按日期排更稳（与 quoteClient 多日分时同思路）
  list.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  const latest = list.length > 0 ? list[list.length - 1] : null;

  return {
    code,
    name: latest ? latest.name : '',
    days: list,
    latest,
    /** 区间内融资净买入累计（元）。null 跳过而不当 0，免得缺数据被算成「没变化」 */
    finNetSum: list.reduce((s, x) => (x.finNet == null ? s : s + x.finNet), 0),
  };
}

module.exports = {
  fetchMargin,
  parseMarginRow,
  buildMargin,
  REPORT_NAME,
  DEFAULT_DAYS,
  MAX_DAYS,
};
