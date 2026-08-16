'use strict';

/**
 * 技术指标计算。全部是纯函数：传入 bars 数组，返回与之等长的结果数组，
 * 数据不足的位置为 null —— 与 klineClient.movingAverage 的约定一致，
 * 渲染层不必再对齐下标。
 *
 * 参数取值follow 通达信/同花顺默认，便于与其他软件对照：
 *   MACD(12, 26, 9)   RSI(6, 12, 24)   KDJ(9, 3, 3)   BOLL(20, 2)
 *
 * 两处与「教科书写法」不同、但与国内行情软件一致的选择：
 *   1. EMA 用首个收盘价作种子递推，不做 SMA 预热。前若干根偏离真值，
 *      靠调用方多取预热根数消化（见 MACD_WARMUP）。
 *   2. BOLL 用**总体**标准差（除以 n），不是样本标准差（除以 n-1）。
 *      通达信如此，改成 n-1 会让轨道略宽，与用户在别处看到的不一致。
 */

/** MACD 需要的预热根数：慢线 26 + 信号 9，再留一倍余量让 EMA 收敛 */
const MACD_WARMUP = 60;

/** 各指标默认参数 */
const DEFAULTS = {
  macd: { fast: 12, slow: 26, signal: 9 },
  rsi: [6, 12, 24],
  kdj: { n: 9, k: 3, d: 3 },
  boll: { n: 20, k: 2 },
};

/** 取收盘价数组；非数字位置为 NaN，各算法自行短路 */
function closes(bars) {
  return (Array.isArray(bars) ? bars : []).map((b) => Number(b && b.close));
}

function filled(len) {
  return new Array(Math.max(0, len)).fill(null);
}

/**
 * 指数移动平均。以 values[0] 为种子递推：ema[i] = ema[i-1] + α(v[i] - ema[i-1])。
 *
 * 遇到非数字就地停止：该位置及其后全为 null，**之前算出的值保留**。
 * 递推一旦断链就无法续上（不像 MA 能跳过坏点重新累加），但已算出的
 * 前段仍然正确，丢掉整条线反而更糟。与 movingAverage 的取舍一致。
 */
function ema(values, period) {
  const n = Math.round(Number(period));
  const out = filled(values.length);
  if (!Number.isFinite(n) || n <= 0) return out;

  const alpha = 2 / (n + 1);
  let prev = null;
  for (let i = 0; i < values.length; i += 1) {
    const v = values[i];
    if (!Number.isFinite(v)) return out;
    prev = prev == null ? v : prev + alpha * (v - prev);
    out[i] = prev;
  }
  return out;
}

/**
 * MACD。返回 { dif, dea, macd }，三者等长。
 * dif = EMA(fast) - EMA(slow)；dea = EMA(dif, signal)；macd = 2 × (dif - dea)。
 * 柱子乘 2 是国内习惯（放大视觉幅度），与通达信一致。
 */
function macd(bars, params = {}) {
  const { fast, slow, signal } = { ...DEFAULTS.macd, ...params };
  const cs = closes(bars);
  const fastLine = ema(cs, fast);
  const slowLine = ema(cs, slow);

  const dif = cs.map((_, i) =>
    fastLine[i] != null && slowLine[i] != null ? fastLine[i] - slowLine[i] : null
  );

  // dea 是 dif 的 EMA，但 dif 前段可能有 null，用 0 占位会把线拽向 0；
  // 这里只对连续有值的尾段做 EMA，再按原下标放回去
  const firstIdx = dif.findIndex((v) => v != null);
  const dea = filled(cs.length);
  if (firstIdx >= 0) {
    const tail = dif.slice(firstIdx);
    const smoothed = ema(tail, signal);
    for (let i = 0; i < smoothed.length; i += 1) dea[firstIdx + i] = smoothed[i];
  }

  const hist = cs.map((_, i) => (dif[i] != null && dea[i] != null ? 2 * (dif[i] - dea[i]) : null));
  return { dif, dea, macd: hist };
}

/**
 * RSI，Wilder 平滑。
 * 前 period 根用简单平均做种子，之后 avg = (avg×(n-1) + 当期) / n。
 * 全程无跌幅时返回 100（不是除零 NaN）。
 */
function rsi(bars, period) {
  const n = Math.round(Number(period));
  const cs = closes(bars);
  const out = filled(cs.length);
  if (!Number.isFinite(n) || n <= 0 || cs.length <= n) return out;

  let gainSum = 0;
  let lossSum = 0;
  for (let i = 1; i <= n; i += 1) {
    if (!Number.isFinite(cs[i]) || !Number.isFinite(cs[i - 1])) return out;
    const diff = cs[i] - cs[i - 1];
    if (diff >= 0) gainSum += diff;
    else lossSum -= diff;
  }
  let avgGain = gainSum / n;
  let avgLoss = lossSum / n;
  out[n] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);

  for (let i = n + 1; i < cs.length; i += 1) {
    if (!Number.isFinite(cs[i]) || !Number.isFinite(cs[i - 1])) break;
    const diff = cs[i] - cs[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (n - 1) + gain) / n;
    avgLoss = (avgLoss * (n - 1) + loss) / n;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

/**
 * KDJ。RSV = (C - LLV(low,n)) / (HHV(high,n) - LLV(low,n)) × 100，
 * K = (2×前K + RSV)/3，D = (2×前D + K)/3，J = 3K - 2D。
 * K/D 种子取 50（通达信惯例）。最高等于最低时 RSV 记 50，避免除零。
 */
function kdj(bars, params = {}) {
  const { n, k: kf, d: df } = { ...DEFAULTS.kdj, ...params };
  const list = Array.isArray(bars) ? bars : [];
  const len = list.length;
  const out = { k: filled(len), d: filled(len), j: filled(len) };
  const period = Math.round(Number(n));
  if (!Number.isFinite(period) || period <= 0) return out;

  let prevK = 50;
  let prevD = 50;
  for (let i = 0; i < len; i += 1) {
    if (i < period - 1) continue;

    let hh = -Infinity;
    let ll = Infinity;
    let bad = false;
    for (let j = i - period + 1; j <= i; j += 1) {
      const h = Number(list[j] && list[j].high);
      const l = Number(list[j] && list[j].low);
      if (!Number.isFinite(h) || !Number.isFinite(l)) { bad = true; break; }
      if (h > hh) hh = h;
      if (l < ll) ll = l;
    }
    const close = Number(list[i] && list[i].close);
    if (bad || !Number.isFinite(close)) break;

    const rsv = hh === ll ? 50 : ((close - ll) / (hh - ll)) * 100;
    prevK = ((kf - 1) * prevK + rsv) / kf;
    prevD = ((df - 1) * prevD + prevK) / df;
    out.k[i] = prevK;
    out.d[i] = prevD;
    out.j[i] = 3 * prevK - 2 * prevD;
  }
  return out;
}

/**
 * 布林带。mid = MA(n)，up/low = mid ± k × 总体标准差。
 * 每根重算标准差（O(n×period)）：period 只有 20、bars 上限几百根，
 * 换成增量算法省下的时间不值得多担一份数值误差累积的风险。
 */
function boll(bars, params = {}) {
  const { n, k } = { ...DEFAULTS.boll, ...params };
  const cs = closes(bars);
  const len = cs.length;
  const out = { mid: filled(len), up: filled(len), low: filled(len) };
  const period = Math.round(Number(n));
  if (!Number.isFinite(period) || period <= 0) return out;

  for (let i = period - 1; i < len; i += 1) {
    let sum = 0;
    let bad = false;
    for (let j = i - period + 1; j <= i; j += 1) {
      if (!Number.isFinite(cs[j])) { bad = true; break; }
      sum += cs[j];
    }
    if (bad) break;

    const mean = sum / period;
    let sq = 0;
    for (let j = i - period + 1; j <= i; j += 1) sq += (cs[j] - mean) ** 2;
    const sd = Math.sqrt(sq / period);

    out.mid[i] = mean;
    out.up[i] = mean + k * sd;
    out.low[i] = mean - k * sd;
  }
  return out;
}

/**
 * 一次算齐四组指标，供编排层调用。
 * @param {object[]} bars 需已按时间升序，且含 high/low/close
 * @returns {{ macd, rsi, kdj, boll, periods }}
 */
function computeAll(bars, params = {}) {
  const rsiPeriods = Array.isArray(params.rsiPeriods) ? params.rsiPeriods : DEFAULTS.rsi;
  const rsiOut = {};
  for (const p of rsiPeriods) rsiOut[`rsi${p}`] = rsi(bars, p);

  return {
    macd: macd(bars, params.macd),
    rsi: rsiOut,
    kdj: kdj(bars, params.kdj),
    boll: boll(bars, params.boll),
    periods: {
      macd: { ...DEFAULTS.macd, ...(params.macd || {}) },
      rsi: rsiPeriods,
      kdj: { ...DEFAULTS.kdj, ...(params.kdj || {}) },
      boll: { ...DEFAULTS.boll, ...(params.boll || {}) },
    },
  };
}

module.exports = { ema, macd, rsi, kdj, boll, computeAll, MACD_WARMUP, DEFAULTS };
