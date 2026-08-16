'use strict';

/**
 * 价格预警的规则规范化与匹配。
 *
 * 纯函数：不发通知、不写文件、不看时钟（今天的日期由调用方传入）。
 * 副作用全在 main.js —— 那边负责发 Notification、落盘去重游标、起保底定时器。
 *
 * 三类触发条件：
 *   changePct  当日涨跌幅 ≥/≤ X%
 *   price      现价 ≥/≤ Y
 *   profitPct  持仓盈亏比例 ≥/≤ Z%（仅对设了成本价的持仓生效）
 *
 * 去重语义：**每条规则每天最多提醒一次**，次日自动重置。不加这个的话股价在
 * 阈值附近来回穿越会让同一条预警反复刷屏 —— 盘中每 3 秒轮询一次，
 * 一根横盘的分时能刷出几百条通知。
 */

/** 登记的条件类型。加类型要同时改 matchRule 与 formatAlert */
const ALERT_KINDS = ['changePct', 'price', 'profitPct'];

/** 方向：gte 涨破（≥），lte 跌破（≤） */
const ALERT_DIRS = ['gte', 'lte'];

/**
 * 单只股票最多几条规则。
 *
 * 6 条 = 三类各两个方向，够表达「涨5%或跌3%提醒我、价格上下轨、盈亏上下限」。
 * 再多的话设置界面在 340px 宽里排不下，且同一只股票同时命中好几条会连着弹通知。
 */
const MAX_RULES_PER_CODE = 6;

/** 类型 → 中文标签。UI 与通知文案共用，避免两处各写一份对不上 */
const KIND_LABELS = { changePct: '涨跌幅', price: '价格', profitPct: '持仓盈亏' };

/** 方向 → 符号 */
const DIR_SYMBOLS = { gte: '≥', lte: '≤' };

/** 百分比类的条件，格式化时要带 % */
const PCT_KINDS = ['changePct', 'profitPct'];

/**
 * 规范化单条规则。任何一项不合法就整条丢弃 ——
 * 半条规则会静默不触发或错误触发，不如当它不存在。
 *
 * @param {object} raw
 * @returns {{id, kind, dir, value, enabled}|null}
 */
function normalizeRule(raw) {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return null;

  const kind = String(raw.kind || '').trim();
  if (!ALERT_KINDS.includes(kind)) return null;

  const dir = String(raw.dir || '').trim();
  if (!ALERT_DIRS.includes(dir)) return null;

  const value = Number(raw.value);
  if (!Number.isFinite(value)) return null;
  // 价格必须为正（0 与负价没有现实含义，且现价为 0 表示停牌，见 matchRule）；
  // 涨跌幅与盈亏可以为负（「跌 5% 提醒我」是最常用的规则）
  if (kind === 'price' && value <= 0) return null;

  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : '',
    kind,
    dir,
    // 保留 4 位：价格阈值可能是基金净值（1.2345）
    value: Math.round(value * 1e4) / 1e4,
    // 缺省为启用。只有显式 false 才算关掉 —— 手改过的配置里可能没这个字段
    enabled: raw.enabled !== false,
  };
}

/**
 * 规范化某只股票的规则数组。
 *
 * 同 kind + dir 只留**最后一条**：两条「涨幅 ≥ 5%」会在命中时发两条一样的通知。
 * 留最后一条是因为设置界面追加在末尾，用户新填的那条更可能是他想要的。
 */
function normalizeRules(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const byKey = new Map();
  for (const item of list) {
    const r = normalizeRule(item);
    if (!r) continue;
    byKey.set(`${r.kind}|${r.dir}`, r);
  }
  return [...byKey.values()].slice(0, MAX_RULES_PER_CODE);
}

/**
 * 规则的稳定标识，用作去重游标的键。
 *
 * 刻意**不含数组下标**：用下标的话删掉前面一条规则会让后面那条的键发生变化，
 * 于是它当天会「重新提醒一次」。
 *
 * 刻意**含 value**：改了阈值算一条新规则，当天可以再提醒。这是有意的 ——
 * 用户调整阈值说明他想重新观察这个位置。需要在设置界面说明，
 * 否则改完阈值收到提醒会觉得是 bug。
 */
function ruleKey(code, rule) {
  return `${code}|${rule.kind}|${rule.dir}|${rule.value}`;
}

/**
 * 取规则要比较的当前值。
 *
 * @returns {number|null} null 表示「拿不到值」，此时一律不命中
 */
function currentValue(kind, item) {
  if (!item) return null;

  if (kind === 'changePct') {
    return Number.isFinite(item.changePct) ? item.changePct : null;
  }

  if (kind === 'price') {
    const p = Number(item.price);
    // 停牌 / 未开盘时接口给 0 或 null。不排除的话「价格 ≤ 15」这类规则
    // 每天开盘前都会命中一次，天天误报
    return Number.isFinite(p) && p > 0 ? p : null;
  }

  // profitPct 读 item.position.profitPct 而不自己算：
  // 口径必须与界面显示的那个数一致，重算一遍容易出现「通知说 -5%、界面显示 -4.98%」
  const pos = item.position;
  if (!pos || !Number.isFinite(pos.profitPct)) return null;
  return pos.profitPct;
}

/**
 * 单条规则是否命中。
 *
 * 用 ≥ / ≤ 而非 > / <：用户填「涨幅 5%」时的预期是「涨到 5% 提醒我」，
 * 正好 5.00% 不提醒会显得像漏了。
 */
function matchRule(rule, item) {
  if (!rule || rule.enabled === false) return false;
  // 拿不到行情的项（error 字段）一律不参与匹配：它的 price/changePct 都是空的，
  // 硬算会把「无数据」当成「跌到 0」
  if (item && item.error) return false;

  const cur = currentValue(rule.kind, item);
  if (cur == null) return false;

  return rule.dir === 'gte' ? cur >= rule.value : cur <= rule.value;
}

/** 阈值的展示文本。百分比带 %，价格按 4 位去尾 */
function formatValue(kind, value) {
  if (PCT_KINDS.includes(kind)) return `${value > 0 ? '+' : ''}${trimNum(value)}%`;
  return trimNum(value);
}

/** 去掉无意义的尾随零：1.2300 → 1.23，5 → 5 */
function trimNum(v) {
  if (!Number.isFinite(v)) return '--';
  return String(Math.round(v * 1e4) / 1e4);
}

/** 规则的人类可读描述。设置界面与通知正文共用 */
function ruleLabel(rule) {
  if (!rule) return '';
  const kind = KIND_LABELS[rule.kind] || rule.kind;
  return `${kind} ${DIR_SYMBOLS[rule.dir] || ''} ${formatValue(rule.kind, rule.value)}`;
}

/**
 * 命中后的通知文案。
 *
 * 标题给「谁 + 现价」，正文给「触发了什么 + 当前值」。只写「触发预警」
 * 会让用户还得回窗口里查是哪一条，通知就失去了「看一眼就知道」的价值。
 *
 * 全部走字符串拼接生成纯文本 —— Notification 的 body 不解析 HTML，
 * 但这里也不做任何标签拼接，免得将来有人把这段文案塞进 DOM。
 */
function formatAlert(rule, item) {
  const name = (item && (item.alias || item.name || item.digits || item.code)) || '';
  const price = item && Number.isFinite(item.price) ? trimNum(item.price) : '--';
  const pct =
    item && Number.isFinite(item.changePct)
      ? `${item.changePct > 0 ? '+' : ''}${item.changePct.toFixed(2)}%`
      : '--';

  const cur = currentValue(rule.kind, item);
  const curText = cur == null ? '--' : formatValue(rule.kind, cur);

  return {
    title: `${name} ${price} ${pct}`,
    // 「当前 X，已触发 条件」——先给事实再给规则，扫一眼就知道发生了什么
    body: `当前${KIND_LABELS[rule.kind] || rule.kind} ${curText}，已触发预警：${ruleLabel(rule)}`,
  };
}

/**
 * 对整个关注列表跑一遍规则，返回该发的通知。
 *
 * **遍历整个 items 而不只是当前选中那只** —— 这是需求的硬约束：
 * 预警的价值就在于盯着你没在看的那些股票。
 *
 * 纯函数：不改传入的 fired，返回一份新的 nextFired。调用方拿它去落盘。
 *
 * @param {object} p
 * @param {Array}  p.items       collectWatchlist 的 items
 * @param {object} p.rulesByCode { [code]: Rule[] }
 * @param {object} p.fired       { [ruleKey]: 'YYYY-MM-DD' } 上次提醒的日期
 * @param {string} p.today       'YYYY-MM-DD'，由调用方给（本模块不看时钟）
 * @returns {{ alerts: Array<{code, ruleKey, rule, title, body}>, nextFired: object }}
 */
function evaluateAlerts(p) {
  const items = Array.isArray(p && p.items) ? p.items : [];
  const rulesByCode = p && p.rulesByCode && typeof p.rulesByCode === 'object' ? p.rulesByCode : {};
  const fired = p && p.fired && typeof p.fired === 'object' ? p.fired : {};
  const today = String((p && p.today) || '');

  const alerts = [];
  // 复制一份而不是原地改：纯函数不该有可观察的副作用，
  // 而且调用方要靠「新旧对比」判断有没有变化、要不要落盘
  const nextFired = { ...fired };

  for (const item of items) {
    if (!item || !item.code) continue;
    // 只遍历 items 里出现的代码 —— 孤儿规则（股票已从关注列表移除但规则还留着）
    // 自然被跳过，不必单独判断
    const rules = normalizeRules(rulesByCode[item.code]);

    for (const rule of rules) {
      if (!matchRule(rule, item)) continue;

      const key = ruleKey(item.code, rule);
      // 今天已经提醒过这条了。股价在阈值附近来回穿越时靠这里挡住刷屏
      if (nextFired[key] === today) continue;

      nextFired[key] = today;
      const { title, body } = formatAlert(rule, item);
      alerts.push({ code: item.code, ruleKey: key, rule, title, body });
    }
  }

  return { alerts, nextFired };
}

/**
 * 剔除不是今天的去重条目。
 *
 * 跨天重置靠它，不需要定时任务 —— 每次评估前过一遍即可。顺带防止 fired
 * 无限增长（用户改过很多次阈值的话，历史键会一直累积）。
 */
function pruneFired(fired, today) {
  const src = fired && typeof fired === 'object' ? fired : {};
  const day = String(today || '');
  const out = {};
  for (const [key, value] of Object.entries(src)) {
    if (value === day) out[key] = value;
  }
  return out;
}

/**
 * 规范化整份预警配置。config.js 调它，避免那边重复一遍规则校验。
 *
 * 代码键的合法性由 config.js 用 normalizeCode 校验（本模块不认识股票代码格式，
 * 保持纯粹）。空规则数组的键会被删掉，否则「加了又删」会让配置文件单调膨胀。
 */
function normalizeRulesByCode(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const out = {};
  for (const [code, list] of Object.entries(src)) {
    const rules = normalizeRules(list);
    if (rules.length > 0) out[code] = rules;
  }
  return out;
}

module.exports = {
  ALERT_KINDS,
  ALERT_DIRS,
  MAX_RULES_PER_CODE,
  KIND_LABELS,
  DIR_SYMBOLS,
  PCT_KINDS,
  normalizeRule,
  normalizeRules,
  normalizeRulesByCode,
  ruleKey,
  ruleLabel,
  currentValue,
  matchRule,
  formatValue,
  formatAlert,
  evaluateAlerts,
  pruneFired,
};
