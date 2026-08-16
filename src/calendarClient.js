'use strict';

/**
 * 交易日历（深圳证券交易所官方）。
 *
 *   https://www.szse.cn/api/report/exchange/onepersistenthour/monthList?month=2026-08
 *
 * 解决的问题：marketTime 只能判「周末 + 时段」，法定节假日靠行情时间戳事后回落
 * （isStaleForToday）。那个办法有两个毛病：开盘前拿不到今天的数据时判不出来，
 * 且每年调休都要手改代码。官方日历一次解决。
 *
 * 用深交所而非上交所：上交所的 commonQuery.do 实测返回 result:null 不可用。
 * 沪深休市日历完全一致（同一套法定节假日），用深市的没有偏差。
 *
 * 响应形如 { data: [{ zrxh: 2, jybz: "1", jyrq: "2026-08-03" }, ...], nowdate }
 *   jyrq 日期  jybz 交易标志：'1' = 交易日，'0' = 休市
 *   zrxh 是周内序号（1=周一…7=周日），本模块不用
 *
 * 已实测：
 *   1. 国庆假期（2026-10-01~07）jybz 全为 '0'，10-08 起恢复 '1'，含调休
 *   2. 越界月份（2027-01、1999-01）与非法月份（'abc'）都返回 { data: [] }，
 *      不报错。所以拿不到数据是常态，调用方必须能在无日历时正常工作
 *   3. 无需 Referer，也不校验 UA
 */

const { fetchJson } = require('./http');

const CALENDAR_URL = 'https://www.szse.cn/api/report/exchange/onepersistenthour/monthList';

/** 交易标志 */
const TRADING_FLAG = '1';

/**
 * 拉某个月的交易日历。
 *
 * @param {string} month 形如 '2026-08'
 * @returns {Promise<{ month: string, days: Map<string, boolean> }>}
 *          days: 'YYYY-MM-DD' → 是否交易日。取不到时为空 Map，不抛错
 */
async function fetchMonth(month, opts = {}) {
  const m = String(month || '').trim();
  if (!/^\d{4}-\d{2}$/.test(m)) throw new Error(`月份格式应为 YYYY-MM，收到：${month}`);

  const query = new URLSearchParams({ month: m, random: String(Math.random()) });
  const json = await fetchJson(`${CALENDAR_URL}?${query.toString()}`, opts);
  return { month: m, days: parseMonth(json) };
}

/**
 * 解析响应为 日期 → 是否交易日 的 Map。抽出来单测。
 *
 * 空 data 是常态（越界月份），返回空 Map 而不抛错。
 */
function parseMonth(json) {
  const out = new Map();
  const list = json && Array.isArray(json.data) ? json.data : [];
  for (const row of list) {
    if (!row || typeof row !== 'object') continue;
    const date = String(row.jyrq || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    out.set(date, String(row.jybz) === TRADING_FLAG);
  }
  return out;
}

/** 'YYYY-MM-DD' → 'YYYY-MM' */
function monthOf(dateKey) {
  return String(dateKey || '').slice(0, 7);
}

/**
 * 建一个带缓存的日历。
 *
 * 交易日历一个月内不变，每次判断都发请求是浪费；且接口偶发失败时不该把
 * 「是否交易日」变成不确定 —— 缓存住已拿到的月份，失败时回落到 null（未知），
 * 调用方按未知处理（继续用原来的周末判定）。
 *
 * @param {{ fetchMonthImpl?: Function }} [deps] 注入点，便于测试
 */
function createTradingCalendar(deps = {}) {
  const fetchMonthImpl = deps.fetchMonthImpl || fetchMonth;

  /** 'YYYY-MM' → Map<dateKey, boolean> */
  const cache = new Map();
  /** 正在请求中的月份 → Promise，避免同一月份并发打多次 */
  const inflight = new Map();
  /** 请求失败过的月份，避免每次判断都重试打接口 */
  const failed = new Set();

  /**
   * 确保某月已载入。失败时记下来，不抛错。
   * @returns {Promise<boolean>} 是否可用
   */
  async function ensureMonth(month) {
    if (cache.has(month)) return true;
    if (failed.has(month)) return false;

    if (inflight.has(month)) return inflight.get(month);

    const task = (async () => {
      try {
        const { days } = await fetchMonthImpl(month);
        // 空 Map 说明接口给了但没数据（越界月份），记为失败以免反复请求
        if (days.size === 0) {
          failed.add(month);
          return false;
        }
        cache.set(month, days);
        return true;
      } catch {
        failed.add(month);
        return false;
      } finally {
        inflight.delete(month);
      }
    })();

    inflight.set(month, task);
    return task;
  }

  /**
   * 某天是否交易日。
   * @param {string} dateKey 'YYYY-MM-DD'
   * @returns {Promise<boolean|null>} null = 日历不可用，调用方应回落到自己的判定
   */
  async function isTradingDay(dateKey) {
    const key = String(dateKey || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) return null;
    const okMonth = await ensureMonth(monthOf(key));
    if (!okMonth) return null;
    const days = cache.get(monthOf(key));
    // 月份载入了但没这天（月末越界），同样按未知处理
    return days.has(key) ? days.get(key) : null;
  }

  /** 同步查询已缓存的结果，不发请求。null = 未缓存或不可用 */
  function peek(dateKey) {
    const key = String(dateKey || '').trim();
    const days = cache.get(monthOf(key));
    if (!days) return null;
    return days.has(key) ? days.get(key) : null;
  }

  /** 清空缓存。跨月或长时间运行后可调用 */
  function reset() {
    cache.clear();
    failed.clear();
    inflight.clear();
  }

  return { isTradingDay, peek, ensureMonth, reset };
}

module.exports = {
  fetchMonth,
  parseMonth,
  monthOf,
  createTradingCalendar,
  CALENDAR_URL,
  TRADING_FLAG,
};
