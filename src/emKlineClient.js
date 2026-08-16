'use strict';

/**
 * 东方财富分钟 K 线客户端（本项目只用 60 分钟）。
 *
 *   https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=1.600519&klt=60&fqt=1&lmt=200
 *
 * 补的是腾讯那路的空白：腾讯只给当日分时与 5 日分时，日 K 以下没有中间档。
 *
 * 已对实盘响应逐项核对：
 *   1. klines 每行逗号分隔，字段序是
 *      [时间, 开, **收**, 高, 低, 量(手), 额(元), 振幅%, 涨跌幅%, 涨跌额, 换手率%]
 *      —— 与腾讯一样是「收在高低之前」，不是 OHLC
 *   2. 时间形如 '2026-08-06 10:30'，标的是该 K 线的**结束**时刻
 *   3. 一个交易日恰好 4 根：10:30 / 11:30 / 14:00 / 15:00。
 *      即 09:30-10:30、10:30-11:30、13:00-14:00、14:00-15:00 四段，
 *      午休不产生额外根，也没有腾讯多日分时那种 15:06-15:30 盘后点要滤
 *   4. lmt 服务端硬顶约 126 根（≈31 个交易日）：给 200/640/1000/5000 都只回 126 根，
 *      最早那根固定停在同一时刻。所以「多取预热根数」这条路在这里走不通，
 *      MA20 需要 20 根、MACD 需要 60 根，126 根够用但不能再假设能取更多
 *   5. 不存在的代码返回 rc=100 且 data=null，不报错
 *   6. ETF 与指数同样返回数据（已用 510300、上证指数核对），无需按类型分流
 *   7. preKPrice 是首根之前的收盘价，作用同腾讯的 prec
 */

const { toSecid, num, PUSH2HIS_HOST, fetchWithHostFallback } = require('./eastmoney');

const KLINE_PATH = '/api/qt/stock/kline/get';

/** klt=60 即 60 分钟。项目只用这一档，不做成参数以免误传出别的周期 */
const KLT_60MIN = 60;

/** fqt=1 前复权。指标与均线必须用复权价，否则除权日会算出假的金叉死叉 */
const FQT_QFQ = 1;

/**
 * 服务端实际能给的最大根数。
 * 实测请求 200/400/640/1000/5000 全部只回 126 根，故按 126 封顶，
 * 多要毫无意义还会让人误以为拿到了更长的历史。
 */
const MAX_BARS = 126;

/** 一个交易日 4 根 60 分钟 K（10:30/11:30/14:00/15:00） */
const BARS_PER_DAY = 4;

/**
 * 解析一行 kline。
 * @param {string} line
 * @returns {object|null} 字段不足或时间格式不符时返回 null
 */
function parseBar(line) {
  const f = String(line == null ? '' : line).split(',');
  if (f.length < 6) return null;

  const date = (f[0] || '').trim();
  // 必须是 'YYYY-MM-DD HH:MM'，防止接口插入汇总行
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(date)) return null;

  const open = num(f[1]);
  const close = num(f[2]);
  const high = num(f[3]);
  const low = num(f[4]);
  if (open == null || close == null || high == null || low == null) return null;

  const volume = num(f[5]);
  return {
    /**
     * 与腾讯 K 线保持同名 `date`，值形如 '2026-08-06 10:30'。
     *
     * 叫 date 而不是 datetime 是为了让 candle.js / stockService 的均线与
     * 悬停逻辑不加分支就能复用 —— 渲染层只在打标签时才需要区分（见 tickLabel）。
     */
    date,
    open,
    close,
    high,
    low,
    volume: volume == null ? 0 : volume,
    amount: num(f[6]),
    amplitude: num(f[7]),
    changePct: num(f[8]),
    change: num(f[9]),
    turnover: num(f[10]),
  };
}

/**
 * 拉 60 分钟 K 线。
 *
 * @param {string} code 形如 'sh600519'
 * @param {{ count?: number }} [params] 要多少根，上限 MAX_BARS
 * @returns {Promise<{ code: string, period: string, fq: string,
 *                     prevClose: number|null, bars: object[] }>}
 *          代码不存在或无数据时 bars 为 []，不抛错 —— 与 klineClient 的约定一致
 */
async function fetchKline60(code, params = {}, opts = {}) {
  const secid = toSecid(code);
  if (!secid) throw new Error(`无法识别的代码：${code}`);

  const wanted = Math.round(Number(params.count));
  const count = Math.min(MAX_BARS, Number.isFinite(wanted) && wanted > 0 ? wanted : MAX_BARS);

  const query = new URLSearchParams({
    secid,
    klt: String(KLT_60MIN),
    fqt: String(FQT_QFQ),
    lmt: String(count),
    // end 给一个远期日期表示「取到最新」，接口要求必填
    end: '20500101',
    fields1: 'f1,f2,f3,f4,f5,f6',
    fields2: 'f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61',
  });

  const json = await fetchWithHostFallback([PUSH2HIS_HOST], `${KLINE_PATH}?${query.toString()}`, opts);
  return parseKlineResponse(json, code);
}

/**
 * 解析接口响应。抽出来单测，免得为了测字段序去发真实请求。
 * data 为 null 是常态（代码不存在、新股未上市），返回空 bars 而不抛错。
 */
function parseKlineResponse(json, code = '') {
  const data = json && json.data;
  if (!data || !Array.isArray(data.klines)) {
    return { code, period: '60min', fq: 'qfq', name: '', prevClose: null, bars: [] };
  }

  const bars = [];
  for (const line of data.klines) {
    const bar = parseBar(line);
    if (bar) bars.push(bar);
  }

  return {
    code,
    period: '60min',
    fq: 'qfq',
    name: String(data.name || '').trim(),
    prevClose: num(data.preKPrice),
    bars,
  };
}

module.exports = {
  fetchKline60,
  parseBar,
  parseKlineResponse,
  KLINE_PATH,
  KLT_60MIN,
  MAX_BARS,
  BARS_PER_DAY,
};
