'use strict';

/**
 * 腾讯 K 线客户端：日/周/月 K。
 *
 *   https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=sh600519,day,,,80,qfq
 *   参数依次是：code, period, 起始日, 结束日, 根数, 复权方式
 *
 * 已对实盘响应逐项核对的几个关键点：
 *   1. 每根的字段序是 [日期, 开, **收**, 高, 低, 量]——收在高低之前，不是 OHLC
 *   2. 数组键名随复权方式变化：qfq→'qfqday'，hfq→'hfqday'，不复权→'day'
 *   3. 除权日那根会多出第 7 段，内容是**分红对象**（{fh_sh, cqr, ...}）而非数字，
 *      按下标取数会拿到对象，必须忽略
 *   4. 服务端最多给 641 根，请求 5000 直接返回 msg='param error'
 *   5. 请求 n 根实际返回 n+1 根——末根是当日（或本周/本月）未走完的动态数据
 *   6. 代码不存在时返回空数组而非报错，且键名回落成不带前缀的 'day'
 */

const { fetchJson } = require('./http');

const KLINE_URL = 'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=';

/** 服务端硬上限 641，留一根余量 */
const MAX_BARS = 640;

const PERIODS = ['day', 'week', 'month'];

/** 复权方式 → 响应键名前缀 */
const FQ_PREFIX = { qfq: 'qfq', hfq: 'hfq', none: '' };

function num(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * 解析一根 K 线。
 * @param {Array} row [日期, 开, 收, 高, 低, 量, 分红对象?]
 * @returns {object|null} 字段不全或日期非法时返回 null
 */
function parseBar(row) {
  if (!Array.isArray(row) || row.length < 6) return null;

  const date = String(row[0] || '').trim();
  // 日期必须是 YYYY-MM-DD，防止接口插入汇总行
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;

  const open = num(row[1]);
  const close = num(row[2]);
  const high = num(row[3]);
  const low = num(row[4]);
  const volume = num(row[5]);
  if (open == null || close == null || high == null || low == null) return null;

  const bar = { date, open, close, high, low, volume: volume == null ? 0 : volume };

  // 第 7 段是除权除息信息（对象），存在则说明这天除权，图上可标记
  const extra = row[6];
  if (extra && typeof extra === 'object' && !Array.isArray(extra)) {
    bar.dividend = {
      content: String(extra.FHcontent || '').trim(),
      exDate: String(extra.cqr || '').trim(),
    };
  }

  return bar;
}

/** 找出响应里装 K 线的那个数组键：优先精确匹配，其次任意以 period 结尾的键 */
function resolveBarsKey(node, period, fq) {
  if (!node) return '';
  const prefix = FQ_PREFIX[fq] != null ? FQ_PREFIX[fq] : 'qfq';
  const exact = `${prefix}${period}`;
  if (Array.isArray(node[exact])) return exact;
  // 无复权数据时接口会回落成不带前缀的键，这里兜住
  if (Array.isArray(node[period])) return period;
  const fallback = Object.keys(node).find((k) => k.endsWith(period) && Array.isArray(node[k]));
  return fallback || '';
}

/**
 * 计算 N 日均线。返回与 bars 等长的数组，不足 period 根的位置为 null。
 * 抽出来是为了能单测：均线错位是最容易埋进去又最难看出来的 bug。
 * @param {object[]} bars
 * @param {number} period
 * @returns {(number|null)[]}
 */
function movingAverage(bars, period) {
  const list = Array.isArray(bars) ? bars : [];
  const n = Math.round(Number(period));
  const out = new Array(list.length).fill(null);
  if (!Number.isFinite(n) || n <= 0) return out;

  let sum = 0;
  for (let i = 0; i < list.length; i += 1) {
    const close = Number(list[i] && list[i].close);
    if (!Number.isFinite(close)) return out.slice(0, i).concat(new Array(list.length - i).fill(null));
    sum += close;
    if (i >= n) sum -= Number(list[i - n].close);
    if (i >= n - 1) out[i] = sum / n;
  }
  return out;
}

/**
 * 拉 K 线。
 * @param {string} code 形如 'sh600519'
 * @param {{ period?: 'day'|'week'|'month', count?: number, fq?: 'qfq'|'hfq'|'none' }} [params]
 * @returns {Promise<{ period: string, fq: string, prevClose: number|null, bars: object[] }>}
 */
async function fetchKline(code, params = {}, opts = {}) {
  const period = PERIODS.includes(params.period) ? params.period : 'day';
  const fq = FQ_PREFIX[params.fq] != null ? params.fq : 'qfq';
  const wanted = Math.round(Number(params.count));
  const count = Math.min(MAX_BARS, Math.max(1, Number.isFinite(wanted) ? wanted : 80));

  const fqParam = FQ_PREFIX[fq];
  const url = `${KLINE_URL}${encodeURIComponent(code)},${period},,,${count},${fqParam}`;
  const json = await fetchJson(url, opts);

  // data 为 [] 表示参数被拒（如根数越界）
  if (!json || !json.data || Array.isArray(json.data)) {
    const msg = json && json.msg ? String(json.msg) : '';
    throw new Error(msg ? `K 线接口拒绝请求：${msg}` : 'K 线接口返回异常');
  }

  const node = json.data[code];
  const key = resolveBarsKey(node, period, fq);
  const rawBars = key ? node[key] : [];

  const bars = [];
  for (const row of rawBars) {
    const bar = parseBar(row);
    if (bar) bars.push(bar);
  }

  // prec 是首根之前的收盘价，用来给首根定色、算涨跌幅
  const prevClose = node ? num(node.prec) : null;

  return { code, period, fq, prevClose, bars };
}

module.exports = {
  fetchKline,
  parseBar,
  resolveBarsKey,
  movingAverage,
  KLINE_URL,
  MAX_BARS,
  PERIODS,
  FQ_PREFIX,
};
