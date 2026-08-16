'use strict';

/**
 * A 股交易时段判定与轮询节奏。
 *
 * 所有函数都接受可注入的 `now`（Date），方便测试；不传则用当前时间。
 * 注意：判定基于**本机本地时间**，默认假设用户机器在 UTC+8。
 *
 * 休市判定有三层，由粗到细：
 *   1. 周末 —— 本模块离线可判（isWeekend）
 *   2. 行情时间戳不是今天 —— 事后回落（isStaleForToday）。开盘前拿不到今天的
 *      数据时判不出来，且要先发一次请求
 *   3. 交易日历 —— 深交所官方接口（calendarClient），能提前知道法定节假日与调休。
 *      日历可能不可用（离线、接口变更），所以它只是**增强**：
 *      resolvePhase 在拿不到日历时回落到第 1、2 层，行为与接入前一致
 */

/** 各时段边界，单位：当日分钟数（0 = 00:00） */
const T = {
  auctionOpen: 9 * 60 + 15, // 09:15 集合竞价开始
  morningOpen: 9 * 60 + 30, // 09:30 早盘开
  morningClose: 11 * 60 + 30, // 11:30 早盘收
  afternoonOpen: 13 * 60, // 13:00 午盘开
  afternoonClose: 15 * 60, // 15:00 收盘
};

/** 轮询间隔（毫秒），按时段区分，避免收盘后还每 3 秒打接口 */
const POLL_MS = {
  trading: 3000, // 连续竞价中
  auction: 5000, // 集合竞价 / 午间休市
  preopen: 30000, // 开盘前
  closed: 300000, // 收盘后 / 周末
};

function minutesOfDay(date) {
  return date.getHours() * 60 + date.getMinutes();
}

/** 是否周末（周六=6, 周日=0） */
function isWeekend(now = new Date()) {
  const d = now.getDay();
  return d === 0 || d === 6;
}

/**
 * 当前所处时段。
 * @returns {'weekend'|'preopen'|'auction'|'trading'|'lunch'|'closed'}
 */
function marketPhase(now = new Date()) {
  if (isWeekend(now)) return 'weekend';

  const m = minutesOfDay(now);
  if (m < T.auctionOpen) return 'preopen';
  if (m < T.morningOpen) return 'auction';
  if (m < T.morningClose) return 'trading';
  if (m < T.afternoonOpen) return 'lunch';
  if (m < T.afternoonClose) return 'trading';
  return 'closed';
}

/** 是否处于「行情会变动」的时段（决定要不要高频轮询） */
function isTradingNow(now = new Date()) {
  return marketPhase(now) === 'trading';
}

/** 该时段建议的轮询间隔（毫秒） */
function pollIntervalMs(now = new Date()) {
  const phase = marketPhase(now);
  if (phase === 'trading') return POLL_MS.trading;
  if (phase === 'auction' || phase === 'lunch') return POLL_MS.auction;
  if (phase === 'preopen') return POLL_MS.preopen;
  return POLL_MS.closed; // weekend | closed
}

/** 时段中文标签，用于 UI 状态条 */
function phaseLabel(phase) {
  return {
    weekend: '休市',
    preopen: '未开盘',
    auction: '集合竞价',
    trading: '交易中',
    lunch: '午间休市',
    closed: '已收盘',
  }[phase] || '';
}

/** 本地日期键 YYYY-MM-DD（不使用 toISOString，避免 UTC 偏移串日） */
function localDateKey(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * 解析腾讯行情时间戳（形如 `20260806104333`）为 Date。
 * 解析失败返回 null。
 */
function parseQuoteTime(raw) {
  const s = String(raw == null ? '' : raw).trim();
  const m = s.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/);
  if (!m) return null;
  const [, y, mo, d, h, mi, sec] = m;
  const dt = new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(sec));
  return Number.isNaN(dt.getTime()) ? null : dt;
}

/**
 * 行情时间戳是否不属于今天——即「今天没开市」（法定节假日）的判据。
 * 交易所在休市日不推新数据，返回的仍是上一交易日收盘快照。
 */
function isStaleForToday(quoteTime, now = new Date()) {
  if (!quoteTime) return false; // 拿不到时间戳就不做判断，避免误报休市
  return localDateKey(quoteTime) !== localDateKey(now);
}

/**
 * 综合三层信息定出最终时段与标签。
 *
 * 把这段逻辑从 stockService.collectDetail 里提出来，是因为加了日历之后判定
 * 变成三个输入的组合，散在调用点很容易漏掉某个分支。
 *
 * 优先级：交易日历（权威，能提前知道调休） > 行情时间戳过期 > 周末+时段。
 *
 * @param {{ now?: Date, quoteTime?: Date|null, isTradingDay?: boolean|null }} input
 *        isTradingDay: 来自日历，null = 日历不可用（不参与判定）
 * @returns {{ phase: string, label: string, isHoliday: boolean, source: string }}
 *          source 标出结论由哪一层给出，便于排查
 */
function resolvePhase(input = {}) {
  const now = input.now instanceof Date ? input.now : new Date();
  const raw = marketPhase(now);
  const stale = isStaleForToday(input.quoteTime, now);
  const cal = input.isTradingDay;

  // 第 1 层已经说是周末，无需再问日历
  if (raw === 'weekend') {
    return { phase: 'weekend', label: phaseLabel('weekend'), isHoliday: false, source: 'weekend' };
  }

  // 日历明确说今天不开市 → 法定节假日。这是唯一能在**开盘前**就判出来的路径
  if (cal === false) {
    return { phase: 'closed', label: '休市', isHoliday: true, source: 'calendar' };
  }

  /**
   * 日历说今天开市，但行情时间戳不是今天。
   *
   * 开盘前（09:15 之前）本就没有今天的数据，此时 stale 为真是正常的，
   * 不能据此说休市 —— 否则每天早上都会显示「休市」。只有在**应该有数据**的
   * 时段（集合竞价之后）才把 stale 当异常看。
   */
  if (stale && raw !== 'preopen') {
    // 日历确认是交易日却拿不到今天的数据，更可能是数据源延迟而非休市，
    // 故保留原时段，只在 source 上留痕
    if (cal === true) {
      return { phase: raw, label: phaseLabel(raw), isHoliday: false, source: 'calendar-trading-stale' };
    }
    // 日历不可用时维持原有行为：按休市处理
    return { phase: 'closed', label: '休市', isHoliday: true, source: 'stale' };
  }

  return { phase: raw, label: phaseLabel(raw), isHoliday: false, source: 'clock' };
}

module.exports = {
  T,
  POLL_MS,
  isWeekend,
  marketPhase,
  isTradingNow,
  pollIntervalMs,
  phaseLabel,
  localDateKey,
  parseQuoteTime,
  isStaleForToday,
  resolvePhase,
};
