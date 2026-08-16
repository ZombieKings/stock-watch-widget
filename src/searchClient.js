'use strict';

/**
 * 股票搜索（代码/简称/拼音均可）——新浪 suggest 接口。
 *
 *   https://suggest3.sinajs.cn/suggest/type=11,12&key=茅台
 *
 * 返回 GBK 文本，形如：
 *   var suggestvalue="工商银行,11,601398,sh601398,工商银行,,工商银行,99,1,ESG,,;农业银行,11,...";
 *
 * 逗号分隔的字段里，我们用到：
 *   [1] 类型码（11=A股, 后续位为指数/基金等）
 *   [2] 6 位代码
 *   [3] 带交易所前缀的完整代码
 *   [4] 中文名称
 */

const { fetchText } = require('./http');
const { normalizeCode, exchangeLabel, kindLabel } = require('./stockCode');

const SUGGEST_URL = 'https://suggest3.sinajs.cn/suggest/';

/** A 股 */
const A_SHARE_TYPE = '11';

/**
 * 场内基金（ETF / LOF）。
 *
 * 必须显式请求：type=11 搜 510300 返回 **0 条**，ETF 完全不在 A 股类型里。
 * 同一支基金新浪会给两条——type=22/201 的 `full` 是 `of510300`（场外份额口径），
 * type=203 的 `full` 是 `sh510300`（场内代码，腾讯行情要的正是这个），故只取 203。
 */
const FUND_TYPE = '203';

/** 两类一起请求：`type=11,203` 实测能同时返回股票与场内基金 */
const SEARCH_TYPES = `${A_SHARE_TYPE},${FUND_TYPE}`;

const ACCEPTED_TYPES = new Set([A_SHARE_TYPE, FUND_TYPE]);

/**
 * 解析 suggest 响应。
 *
 * 指数不再靠代码段硬编码剔除——normalizeCode 的 classifyCode 已经能识别
 * （且它连交易所一起判，不会把 sz000001 平安银行误当成指数）。
 *
 * @returns {Array<{ code, digits, name, exchange, exchangeLabel, kind, kindLabel, isFund }>}
 */
function parseSuggest(text) {
  const raw = String(text == null ? '' : text);
  const m = raw.match(/var\s+suggestvalue\s*=\s*"([\s\S]*?)"\s*;?/);
  if (!m || !m[1]) return [];

  const out = [];
  const seen = new Set();

  for (const entry of m[1].split(';')) {
    const parts = entry.split(',');
    if (parts.length < 5) continue;

    const type = (parts[1] || '').trim();
    const digits = (parts[2] || '').trim();
    const fullCode = (parts[3] || '').trim().toLowerCase();
    const name = (parts[4] || '').trim();

    if (!ACCEPTED_TYPES.has(type)) continue;
    // type=22/201 的 full 形如 `of510300`，不带交易所前缀，这一条同时挡住它们
    if (!/^\d{6}$/.test(digits) || !/^(sh|sz|bj)\d{6}$/.test(fullCode)) continue;
    // 搜代码时新浪会把名称位填成代码本身（如 "sz000858"），此时名称无意义
    if (!name || /^(sh|sz|bj)?\d{6}$/i.test(name)) continue;
    if (seen.has(fullCode)) continue;

    const norm = normalizeCode(fullCode);
    if (!norm.ok) continue;
    // 指数不可交易，拿它当关注标的后续每个接口都会空转
    if (norm.kind === 'index') continue;

    seen.add(fullCode);
    out.push({
      code: norm.code,
      digits: norm.digits,
      name,
      exchange: norm.exchange,
      exchangeLabel: exchangeLabel(norm.exchange),
      kind: norm.kind,
      kindLabel: kindLabel(norm.kind),
      isFund: norm.isFund,
    });
  }
  return out;
}

/**
 * 搜索股票与场内基金（ETF / LOF）。
 * @param {string} keyword 代码、中文简称或拼音首字母
 * @param {{ limit?: number, fetchImpl?: Function }} [opts]
 */
async function searchStocks(keyword, opts = {}) {
  const { limit = 12 } = opts;
  const key = String(keyword == null ? '' : keyword).trim();
  if (!key) return [];

  const url = `${SUGGEST_URL}type=${SEARCH_TYPES}&key=${encodeURIComponent(key)}`;
  const text = await fetchText(url, {
    ...opts,
    encoding: 'gbk',
    headers: { Referer: 'https://finance.sina.com.cn/', ...(opts.headers || {}) },
  });
  return parseSuggest(text).slice(0, limit);
}

module.exports = {
  searchStocks,
  parseSuggest,
  SUGGEST_URL,
  SEARCH_TYPES,
  A_SHARE_TYPE,
  FUND_TYPE,
};
