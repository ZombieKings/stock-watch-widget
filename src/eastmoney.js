'use strict';

/**
 * 东方财富公共层：代码转换 + 数据中心报表请求。
 *
 * 项目里有五处走东财（资金流、公告、60 分钟 K 线、融资融券、财务、研报、龙虎榜），
 * 各自重写一遍 secid 转换与报表拆包很容易走偏，统一放这里。
 *
 * —— 关于域名 ——
 * `push2.eastmoney.com`（实时推送域）在开发机所在网络会被 TCP 重置：Node fetch 报
 * UND_ERR_SOCKET，node:https 报 ECONNRESET，12/12 全失败；curl 偶尔能通。
 * 已排除 IPv6 与 DNS 因素（强制 ipv4first 无效，解析到的是 IPv4）。
 * 实测同族镜像里 `48.push2` 与 `push2delay` 稳定可用（12/12），`82.push2`、`7.push2`
 * 同样被重置。故实时类接口走 PUSH2_HOSTS 逐个回退，不直接用主域名。
 * 历史类的 `push2his` 一直正常，单独一个常量。
 */

const { fetchJson } = require('./http');

/** 实时推送域，按可用性排序，逐个尝试。见文件头注释 */
const PUSH2_HOSTS = ['48.push2.eastmoney.com', 'push2delay.eastmoney.com', 'push2.eastmoney.com'];

/** 历史行情域（K 线、资金流日线）。本机一直可用，无需回退 */
const PUSH2HIS_HOST = 'push2his.eastmoney.com';

/** 数据中心报表域：融资融券、龙虎榜等 */
const DATACENTER_WEB = 'https://datacenter-web.eastmoney.com/api/data/v1/get';

/** F10 报表域：财务主要指标走这个，与上面不是同一套 */
const DATACENTER_F10 = 'https://datacenter.eastmoney.com/securities/api/data/v1/get';

/** 东财接口普遍校验 Referer，缺失会被拒 */
const EM_REFERER = { Referer: 'https://data.eastmoney.com/' };

/**
 * code → 东财 secid。沪市前缀 1，深市前缀 0。
 *
 * 北交所东财也用 0，但本项目 stockCode 目前不产出 bj 代码，故不特殊处理。
 * @param {string} code 形如 'sh600519'
 * @returns {string} 形如 '1.600519'，无法识别时返回空串
 */
function toSecid(code) {
  const m = /^(sh|sz)(\d{6})$/i.exec(String(code || '').trim());
  if (!m) return '';
  return `${m[1].toLowerCase() === 'sh' ? 1 : 0}.${m[2]}`;
}

/**
 * code → 数据中心的 SECUCODE，形如 '600519.SH'。
 *
 * 必须用它而不是 6 位数字过滤：`000001` 在深市是平安银行、在沪市是上证指数，
 * 用 SECURITY_CODE='000001' 查龙虎榜会拿到平安银行的记录当成指数的。
 * 已实测各报表都支持 SECUCODE 精确过滤，且错配交易所时返回 code 9201「返回数据为空」
 * 而不是串数据。
 * @returns {string} 无法识别时返回空串
 */
function toSecucode(code) {
  const m = /^(sh|sz)(\d{6})$/i.exec(String(code || '').trim());
  if (!m) return '';
  return `${m[2]}.${m[1].toUpperCase()}`;
}

/** 字符串/数字 → number；空、'-'、非数字均为 null，避免 UI 出现 NaN */
function num(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s || s === '-') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * 东财日期字段形如 `2026-08-07 00:00:00`，截出 'YYYY-MM-DD'。
 * 已是纯日期或格式不符时原样返回。
 */
function dateOnly(raw) {
  const s = String(raw == null ? '' : raw).trim();
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : s;
}

/**
 * 带域名回退的 JSON 请求。
 *
 * 逐个尝试 hosts，全部失败时抛最后一个错误。只在**连接层**失败时才换域名——
 * 拿到 HTTP 响应就认为该域名可用，即使业务上返回空数据（换域名也不会变）。
 *
 * @param {string[]} hosts 域名列表
 * @param {string} pathAndQuery 形如 '/api/qt/stock/kline/get?secid=...'
 */
async function fetchWithHostFallback(hosts, pathAndQuery, opts = {}) {
  let lastErr = null;
  for (const host of hosts) {
    try {
      return await fetchJson(`https://${host}${pathAndQuery}`, {
        ...opts,
        headers: { ...EM_REFERER, ...(opts.headers || {}) },
      });
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error('东财接口请求失败');
}

/**
 * 请求数据中心报表。
 *
 * 响应形如 `{ result: { data: [...], pages, count }, success }`。
 * 无数据时 success=false、message='返回数据为空'、code=9201 —— 这是**常态**
 * （未上过龙虎榜、非两融标的、ETF 没有财务数据都会走到这里），返回空数组而不抛错。
 * 其它 message（如报表名写错的 9501「报表配置不存在」）要抛出来，否则接口改名了
 * 会静默变成「暂无数据」，排查时毫无线索。
 *
 * @param {string} baseUrl DATACENTER_WEB 或 DATACENTER_F10
 * @param {object} params 查询参数；filter 由调用方拼好
 * @returns {Promise<{ rows: object[], pages: number, count: number }>}
 */
async function fetchReport(baseUrl, params, opts = {}) {
  const query = new URLSearchParams({ source: 'WEB', client: 'WEB', ...params });
  const json = await fetchJson(`${baseUrl}?${query.toString()}`, {
    ...opts,
    headers: { ...EM_REFERER, ...(opts.headers || {}) },
  });

  const result = json && json.result;
  if (!result || !Array.isArray(result.data)) {
    const msg = String((json && json.message) || '').trim();
    // 9201 = 该标的确实没有这类数据，属正常情况
    if (json && json.code === 9201) return { rows: [], pages: 0, count: 0 };
    if (msg && msg !== '返回数据为空') {
      throw new Error(`东财报表返回异常：${msg}`);
    }
    return { rows: [], pages: 0, count: 0 };
  }

  return {
    rows: result.data,
    pages: Number(result.pages) || 0,
    count: Number(result.count) || result.data.length,
  };
}

/**
 * 拼 filter 表达式：`(SECUCODE="600519.SH")`。
 * 值里的引号会被剥掉，避免拼出畸形表达式。
 */
function eqFilter(field, value) {
  const safe = String(value == null ? '' : value).replace(/["()]/g, '');
  return `(${field}="${safe}")`;
}

module.exports = {
  toSecid,
  toSecucode,
  num,
  dateOnly,
  fetchWithHostFallback,
  fetchReport,
  eqFilter,
  PUSH2_HOSTS,
  PUSH2HIS_HOST,
  DATACENTER_WEB,
  DATACENTER_F10,
  EM_REFERER,
};
