'use strict';

/**
 * 财务主要指标客户端（东方财富 F10）。
 *
 *   https://datacenter.eastmoney.com/securities/api/data/v1/get
 *   reportName=RPT_F10_FINANCE_MAINFINADATA&filter=(SECUCODE="600519.SH")
 *
 * 注意域名与 marginClient 用的 datacenter-web 不是同一套，source 也不同
 * （这里要 HSF10/PC，给 WEB/WEB 拿不到数据）。
 *
 * 已实测：
 *   1. 按报告期倒序给，REPORT_TYPE 是中文（'一季报'/'中报'/'三季报'/'年报'）
 *   2. ETF 与指数返回 code 9201「返回数据为空」—— 它们没有财务报表，
 *      调用方应据 kind 直接跳过，不必发这个请求
 *   3. 银行/保险专有字段（TOTALDEPOSITS、SOLVENCY_AR 等）对一般企业为 null，
 *      本模块不解析它们：悬浮窗只要通用指标
 *   4. EPSKCJB（扣非 EPS）与 ROEKCJQ 常为 null，即使是茅台这种大盘股，
 *      所以扣非只取 KCFJCXSYJLR（扣非净利润）
 *
 * 字段名对照：
 *   EPSJB 基本每股收益   BPS 每股净资产   MGJYXJJE 每股经营现金流
 *   ROEJQ 净资产收益率(加权)%   XSMLL 销售毛利率%   XSJLL 销售净利率%
 *   TOTALOPERATEREVE 营业总收入   PARENTNETPROFIT 归母净利润
 *   KCFJCXSYJLR 扣非净利润
 *   TOTALOPERATEREVETZ 营收同比增长%   PARENTNETPROFITTZ 净利润同比增长%
 *   ZCFZL 资产负债率%   REPORT_DATE 报告期   NOTICE_DATE 公告日
 */

const { toSecucode, num, dateOnly, fetchReport, eqFilter, DATACENTER_F10 } = require('./eastmoney');

const REPORT_NAME = 'RPT_F10_FINANCE_MAINFINADATA';

/** 默认取几期。4 期够看「最近一年四个季度」的趋势 */
const DEFAULT_PERIODS = 4;

const MAX_PERIODS = 20;

/**
 * 解析一期报表。
 * @returns {object|null} 报告期缺失时返回 null
 */
function parseFinanceRow(row) {
  if (!row || typeof row !== 'object') return null;
  const reportDate = dateOnly(row.REPORT_DATE);
  if (!reportDate) return null;

  return {
    reportDate,
    /** 形如 '2026一季报'，接口直接给中文，UI 原样展示 */
    reportName: String(row.REPORT_DATE_NAME || '').trim(),
    reportType: String(row.REPORT_TYPE || '').trim(),
    noticeDate: dateOnly(row.NOTICE_DATE),
    /** 基本每股收益（元） */
    eps: num(row.EPSJB),
    /** 每股净资产（元） */
    bps: num(row.BPS),
    /** 每股经营现金流（元） */
    cashPerShare: num(row.MGJYXJJE),
    /** 净资产收益率-加权（%） */
    roe: num(row.ROEJQ),
    /** 销售毛利率（%） */
    grossMargin: num(row.XSMLL),
    /** 销售净利率（%） */
    netMargin: num(row.XSJLL),
    /** 营业总收入（元） */
    revenue: num(row.TOTALOPERATEREVE),
    /** 归母净利润（元） */
    netProfit: num(row.PARENTNETPROFIT),
    /** 扣非净利润（元） */
    netProfitExcl: num(row.KCFJCXSYJLR),
    /** 营收同比增长（%） */
    revenueYoy: num(row.TOTALOPERATEREVETZ),
    /** 归母净利润同比增长（%） */
    netProfitYoy: num(row.PARENTNETPROFITTZ),
    /** 资产负债率（%） */
    debtRatio: num(row.ZCFZL),
    currency: String(row.CURRENCY || 'CNY').trim(),
  };
}

/**
 * 拉财务主要指标。
 *
 * @param {string} code 形如 'sh600519'
 * @param {{ periods?: number }} [params]
 * @returns {Promise<{ code, periods: object[], latest: object|null }>}
 *          periods 按报告期**倒序**（最新在前）—— 与 marginClient 的升序相反，
 *          因为财务是「看最近一期，往前对照」，倒序更贴近阅读顺序
 */
async function fetchFinance(code, params = {}, opts = {}) {
  const secucode = toSecucode(code);
  if (!secucode) throw new Error(`无法识别的代码：${code}`);

  const wanted = Math.round(Number(params.periods));
  const periods =
    Number.isFinite(wanted) && wanted > 0 ? Math.min(MAX_PERIODS, wanted) : DEFAULT_PERIODS;

  const { rows } = await fetchReport(
    DATACENTER_F10,
    {
      reportName: REPORT_NAME,
      columns: 'ALL',
      filter: eqFilter('SECUCODE', secucode),
      pageSize: String(periods),
      pageNumber: '1',
      sortColumns: 'REPORT_DATE',
      sortTypes: '-1',
      // F10 域要求这两个值，给 WEB/WEB 拿不到数据
      source: 'HSF10',
      client: 'PC',
    },
    opts
  );

  return buildFinance(rows, code);
}

/** 报表行 → 渲染层形状。抽出来单测 */
function buildFinance(rows, code = '') {
  const list = (Array.isArray(rows) ? rows : []).map(parseFinanceRow).filter((d) => d != null);
  // 保证倒序：不假定接口一定按 sortTypes 给
  list.sort((a, b) => (a.reportDate < b.reportDate ? 1 : a.reportDate > b.reportDate ? -1 : 0));

  return {
    code,
    periods: list,
    latest: list.length > 0 ? list[0] : null,
  };
}

module.exports = {
  fetchFinance,
  parseFinanceRow,
  buildFinance,
  REPORT_NAME,
  DEFAULT_PERIODS,
  MAX_PERIODS,
};
