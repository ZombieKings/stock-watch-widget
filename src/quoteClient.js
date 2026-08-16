'use strict';

/**
 * 腾讯行情客户端：实时快照 + 当日分时。
 *
 * 三个接口都无需鉴权：
 *   实时    http://qt.gtimg.cn/q=sh600519,sz000858   （GBK，~ 分隔的定长字段）
 *   分时    https://web.ifzq.gtimg.cn/appstock/app/minute/query?code=sh600519
 *   多日分时 https://web.ifzq.gtimg.cn/appstock/app/day/query?code=sh600519
 */

const { fetchText, fetchJson } = require('./http');

const QUOTE_URL = 'http://qt.gtimg.cn/q=';
const MINUTE_URL = 'https://web.ifzq.gtimg.cn/appstock/app/minute/query?code=';
const MULTI_DAY_MINUTE_URL = 'https://web.ifzq.gtimg.cn/appstock/app/day/query?code=';

/** 单次请求最多带多少只股票——腾讯官方前端按 ~25 只一批，沿用该保守值 */
const BATCH_SIZE = 25;

/** 腾讯行情字段下标（已对实盘数据逐个核对） */
const F = {
  name: 1,
  code: 2,
  price: 3,
  prevClose: 4,
  open: 5,
  time: 30,
  change: 31,
  changePct: 32,
  high: 33,
  low: 34,
  volume: 36, // 成交量（手）
  amount: 37, // 成交额（万元）
  turnover: 38, // 换手率 %
  pe: 39, // 市盈率 TTM
  // 43 是**振幅**不是量比：已对 8 只标的核对 (今高-今低)/昨收*100 恒等于该段。
  // 真正的量比在 49。曾经把 43 当量比用，UI 上「比」显示的其实是振幅。
  amplitude: 43, // 振幅 %
  floatMarketCap: 44, // 流通市值（亿元）
  totalMarketCap: 45, // 总市值（亿元）
  pb: 46,
  limitUp: 47,
  limitDown: 48,
  volumeRatio: 49, // 量比（已用 5 日均量独立验算，6 只标的吻合）
  avgPrice: 51,
  high52w: 67,
  low52w: 68,
  // —— 场内基金专有 ——
  // 77 溢价率 %；78 IOPV 实时估算净值（仅 ETF 给）；81 T-1 单位净值（LOF 走这个）
  // 规则 nav = iopv ?? navT1，(price-nav)/nav*100 与 77 在 10 只基金上全部吻合
  premiumPct: 77,
  iopv: 78,
  navT1: 81,
  currency: 82,
};

/** 字符串转数字；空串/非数字返回 null，避免 UI 出现 NaN */
function num(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * 解析一行 `v_sh600519="..."` 为行情对象。
 * 字段数不足（停牌新股或代码不存在）时返回 null。
 */
function parseQuoteLine(line) {
  const eq = line.indexOf('=');
  if (eq < 0) return null;

  const symbol = line.slice(0, eq).replace(/^v_/, '').trim();
  const quoted = line.slice(eq + 1).match(/"([^"]*)"/);
  if (!quoted) return null;

  const f = quoted[1].split('~');
  // 正常 A 股返回 88 段；少于 50 段说明该代码无数据
  if (f.length < 50) return { symbol, ok: false, error: '无行情数据（代码可能不存在或已停牌）' };

  return {
    symbol,
    ok: true,
    name: (f[F.name] || '').trim(),
    code: (f[F.code] || '').trim(),
    price: num(f[F.price]),
    prevClose: num(f[F.prevClose]),
    open: num(f[F.open]),
    high: num(f[F.high]),
    low: num(f[F.low]),
    change: num(f[F.change]),
    changePct: num(f[F.changePct]),
    volume: num(f[F.volume]),
    amount: num(f[F.amount]),
    turnover: num(f[F.turnover]),
    pe: num(f[F.pe]),
    pb: num(f[F.pb]),
    volumeRatio: num(f[F.volumeRatio]),
    amplitude: num(f[F.amplitude]),
    floatMarketCap: num(f[F.floatMarketCap]),
    totalMarketCap: num(f[F.totalMarketCap]),
    limitUp: num(f[F.limitUp]),
    limitDown: num(f[F.limitDown]),
    avgPrice: num(f[F.avgPrice]),
    high52w: num(f[F.high52w]),
    low52w: num(f[F.low52w]),
    currency: (f[F.currency] || 'CNY').trim(),
    quoteTime: (f[F.time] || '').trim(),
    ...fundFields(f),
  };
}

/**
 * 场内基金的净值与溢价率。
 *
 * ETF 盘中给 IOPV（实时估算净值），LOF 只给 T-1 单位净值 —— 两者都放在
 * `nav` 里，用 `navRealtime` 区分，免得 UI 把「昨日净值」当成实时值展示。
 * 股票与指数这三段皆为空，返回的字段全是 null，渲染层据此整块隐藏。
 *
 * 溢价率直接采信接口的 77 段，不自己算：已核对 (price-nav)/nav*100 与其
 * 在 10 只基金上一致，接口值省去我们处理停牌/无量等边角。
 */
function fundFields(f) {
  const iopv = num(f[F.iopv]);
  const navT1 = num(f[F.navT1]);
  const nav = iopv != null ? iopv : navT1;
  return {
    nav,
    /** true = 盘中实时估算(IOPV)，false = T-1 净值。nav 为 null 时无意义 */
    navRealtime: iopv != null,
    premiumPct: num(f[F.premiumPct]),
  };
}

/** 把数组切成每 size 个一批 */
function chunk(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/**
 * 批量拉实时行情。
 * @param {string[]} codes 形如 ['sh600519', 'sz000858']
 * @returns {Promise<Map<string, object>>} symbol → 行情对象
 */
async function fetchQuotes(codes, opts = {}) {
  const list = Array.isArray(codes) ? codes.filter(Boolean) : [];
  const result = new Map();
  if (list.length === 0) return result;

  for (const batch of chunk(list, BATCH_SIZE)) {
    const text = await fetchText(`${QUOTE_URL}${batch.join(',')}`, { ...opts, encoding: 'gbk' });
    for (const line of text.split(';')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const parsed = parseQuoteLine(trimmed);
      if (parsed) result.set(parsed.symbol, parsed);
    }
  }
  return result;
}

/**
 * 解析分时数据行 `0930 1310.00 177 23187000.00`。
 * 注意：量与额都是**当日累计值**，逐分钟增量需相邻相减。
 */
function parseMinuteLines(lines, prevClose) {
  const points = [];
  let prevCumVolume = 0;

  for (const raw of Array.isArray(lines) ? lines : []) {
    const parts = String(raw).trim().split(/\s+/);
    if (parts.length < 3) continue;

    const hhmm = parts[0];
    if (!/^\d{4}$/.test(hhmm)) continue;

    const price = num(parts[1]);
    const cumVolume = num(parts[2]) || 0;
    const cumAmount = num(parts[3]);
    if (price == null) continue;

    // 均价 = 累计成交额 / 累计成交股数（1 手 = 100 股）
    const avgPrice = cumAmount != null && cumVolume > 0 ? cumAmount / (cumVolume * 100) : null;

    points.push({
      time: `${hhmm.slice(0, 2)}:${hhmm.slice(2)}`,
      price,
      avgPrice,
      volume: Math.max(0, cumVolume - prevCumVolume), // 本分钟增量
      cumVolume,
      cumAmount,
      changePct: prevClose ? ((price - prevClose) / prevClose) * 100 : null,
    });
    prevCumVolume = cumVolume;
  }
  return points;
}

/**
 * 拉单只股票的当日分时。
 * @returns {Promise<{ date: string, prevClose: number|null, points: object[] }>}
 */
async function fetchMinuteLine(code, opts = {}) {
  const json = await fetchJson(`${MINUTE_URL}${encodeURIComponent(code)}`, opts);
  const node = json && json.data && json.data[code];
  if (!node || !node.data) {
    return { date: '', prevClose: null, points: [] };
  }

  // 昨收藏在同响应的 qt 快照里（第 5 段），分时图基准线要用它
  let prevClose = null;
  const qtRow = node.qt && node.qt[code];
  if (Array.isArray(qtRow)) prevClose = num(qtRow[F.prevClose]);

  return {
    date: String(node.data.date || ''),
    prevClose,
    points: parseMinuteLines(node.data.data, prevClose),
  };
}

/**
 * 是否属于连续竞价时段（09:30-11:30 / 13:00-15:00）。
 *
 * 多日分时接口每天会多给 25 个 15:06-15:30 的**盘后固定价交易**点：价格恒等于收盘价、
 * 累计量几乎不动。留着会在每天末尾拖出一条平线，必须滤掉。
 * @param {string} hhmm 形如 '0930'
 */
function isIntradayTime(hhmm) {
  if (!/^\d{4}$/.test(String(hhmm || ''))) return false;
  const n = Number(hhmm);
  return (n >= 930 && n <= 1130) || (n >= 1300 && n <= 1500);
}

/** 'YYYYMMDD' → 'YYYY-MM-DD'；已带分隔符或格式不符时原样返回 */
function dashDate(raw) {
  const s = String(raw || '').trim();
  if (!/^\d{8}$/.test(s)) return s;
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6)}`;
}

/**
 * 解析多日分时。
 *
 * 接口给的日期是**倒序**（今天在 [0]），这里反转成升序，画图时才不用再倒。
 * 累计量每天从 0 重算，所以必须按天分别调 parseMinuteLines——整片一起算的话，
 * 每天第一个点的增量会变成一个巨大的负数。
 *
 * @param {Array} rawDays data[code].data，每项形如 { date, data: [...], prec }
 * @returns {Array<{ date: string, prevClose: number|null, points: object[] }>} 按日期升序
 */
function parseMultiDayMinute(rawDays) {
  const list = Array.isArray(rawDays) ? rawDays : [];
  const days = [];

  for (const day of list) {
    if (!day || !Array.isArray(day.data)) continue;
    const prevClose = num(day.prec);
    const intraday = day.data.filter((row) => isIntradayTime(String(row).trim().split(/\s+/)[0]));
    const points = parseMinuteLines(intraday, prevClose);
    if (points.length === 0) continue;
    days.push({ date: dashDate(day.date), prevClose, points });
  }

  // 接口倒序 → 升序。不假定它一定倒序，按日期排更稳
  days.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return days;
}

/**
 * 拉单只股票的多日分时（接口固定给 5 个交易日）。
 * @returns {Promise<{ days: Array<{ date, prevClose, points }> }>}
 */
async function fetchMultiDayMinute(code, opts = {}) {
  const json = await fetchJson(`${MULTI_DAY_MINUTE_URL}${encodeURIComponent(code)}`, opts);
  const node = json && json.data && json.data[code];
  // 代码不存在时 data 为空或 data.data 不是数组，按「无数据」处理而不是抛错
  if (!node || !Array.isArray(node.data)) return { days: [] };
  return { days: parseMultiDayMinute(node.data) };
}

module.exports = {
  fetchQuotes,
  fetchMinuteLine,
  fetchMultiDayMinute,
  parseQuoteLine,
  parseMinuteLines,
  parseMultiDayMinute,
  isIntradayTime,
  dashDate,
  F,
  BATCH_SIZE,
  QUOTE_URL,
  MINUTE_URL,
  MULTI_DAY_MINUTE_URL,
};
