'use strict';

/**
 * 预警去重游标的落盘。存于 %APPDATA%/StockWatchWidget/alerts-state.json。
 *
 * 只存一件事：每条规则上次提醒的日期（{ [ruleKey]: 'YYYY-MM-DD' }）。
 * 靠它实现「每条规则每天最多提醒一次」，跨天由 pruneFired 在评估前剔除旧条目，
 * 不需要定时任务。
 *
 * 容错策略介于 config 与 trades 之间，取最宽的那种：**读写失败都静默**。
 * 理由是这份数据完全可再生 —— 丢了最坏的后果是某条预警当天重复提醒一次，
 * 而为它抛错会打断行情轮询（runAlerts 挂在 get-watchlist 的返回路径上）。
 * 对比 tradeStore：那边是用户手输的记账数据，坏了必须拒绝写入。
 *
 * 与 config 分开存的理由：这个文件在盘中会被频繁改写（每次有新预警命中就写一次），
 * 混进 config.json 会让每次命中都连带重写关注列表与窗口位置。
 */

const fs = require('fs');
const path = require('path');

const FILE_NAME = 'alerts-state.json';

/**
 * 游标条目数上限。
 *
 * pruneFired 每天会把非今日的条目清掉，正常情况下条目数不会超过「规则总数」。
 * 这个上限只是防御异常情况（比如用户反复改阈值，每次都产生新 ruleKey 且
 * 当天全部命中）。超限时丢弃最先遇到的 —— 顺序无所谓，反正明天就清空了。
 */
const MAX_ENTRIES = 2000;

/** 只保留形如 'YYYY-MM-DD' 的值，其余丢弃 */
function isDateValue(v) {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
}

/**
 * 规范化游标对象。
 *
 * 键（ruleKey）不做格式校验：它由 alertRules.ruleKey 生成，格式变化时旧键
 * 自然对不上、当天多提醒一次就过去了。值必须是日期串 —— 不然
 * `fired[key] === today` 的比较会静默失效，去重形同虚设。
 */
function normalizeFired(raw) {
  const src = raw != null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const out = {};
  let n = 0;
  for (const [key, value] of Object.entries(src)) {
    if (!key || !isDateValue(value)) continue;
    if (n >= MAX_ENTRIES) break;
    out[key] = value;
    n += 1;
  }
  return out;
}

/**
 * 创建预警状态存储。
 * @param {string} userDataDir 一般传 app.getPath('userData')
 */
function createAlertStore(userDataDir) {
  const filePath = path.join(userDataDir, FILE_NAME);

  /**
   * 读游标。
   *
   * 文件不存在、内容坏了、字段不对 —— 一律回落到空对象，与 config 的
   * 「永不抛异常」同款。丢了游标只会让当天的预警重复提醒一次，
   * 而抛错会打断行情轮询。
   */
  function load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      const src = parsed && typeof parsed === 'object' ? parsed : {};
      return { fired: normalizeFired(src.fired) };
    } catch {
      return { fired: {} };
    }
  }

  /**
   * 写游标。失败静默 —— 同上，这份数据不值得为它中断主流程。
   * @returns {boolean} 是否真的写成功了（便于调用方在日志里留痕，但不强制处理）
   */
  function save(state) {
    try {
      const fired = normalizeFired(state && state.fired);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, JSON.stringify({ fired }, null, 2), 'utf8');
      return true;
    } catch {
      return false;
    }
  }

  /** 清空。设置界面的「重置预警提醒记录」用（改完规则想立刻重新收到提醒时） */
  function clear() {
    return save({ fired: {} });
  }

  return { filePath, load, save, clear };
}

module.exports = { createAlertStore, normalizeFired, isDateValue, FILE_NAME, MAX_ENTRIES };
