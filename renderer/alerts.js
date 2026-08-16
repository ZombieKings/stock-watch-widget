'use strict';

/**
 * 价格预警规则编辑器的渲染（设置面板用）。
 *
 * 只做「数据 → DOM」，不碰 window.api、不管定时器、不读 state ——
 * 与 groups.js / listview.js / trades.js 同一套约定，可在 node 下用 DOM 桩单测。
 *
 * 顶层符号一律加 al 前缀或包在 ALERTS_API 里：renderer/ 下的脚本共享全局作用域，
 * 重名会在解析期抛错、整个文件静默不执行，而 node 单测照样全绿。
 *
 * 340px 下的形态取舍：每只股票一行**紧凑摘要**（`贵州茅台 涨跌幅≥+5% ✕`），
 * 加规则靠底部一个四格输入行。刻意**不做**「每只股票展开三类各两个方向的
 * 输入框」—— 那在这个宽度里是一面输入框的墙。
 */

/** 类型与方向的中文标签。与 src/alertRules.js 的 KIND_LABELS 是同一份约定 */
const AL_KIND_LABELS = { changePct: '涨跌幅', price: '价格', profitPct: '持仓盈亏' };
const AL_DIR_SYMBOLS = { gte: '≥', lte: '≤' };
const AL_PCT_KINDS = ['changePct', 'profitPct'];

/** 去掉无意义的尾随零 */
function alTrimNum(v) {
  if (!Number.isFinite(v)) return '--';
  return String(Math.round(v * 1e4) / 1e4);
}

/** 阈值展示：百分比带 % 与正号，价格都不带 */
function alFormatValue(kind, value) {
  if (AL_PCT_KINDS.includes(kind)) return `${value > 0 ? '+' : ''}${alTrimNum(value)}%`;
  return alTrimNum(value);
}

/**
 * 规则的人类可读描述。
 *
 * 与 src/alertRules.js 的 ruleLabel 刻意各写一份而非共用：那个模块是主进程侧的
 * （通知文案用），这个是渲染层的。renderer/ 不 require src/ 下的文件 ——
 * 那些是 CommonJS 模块，在浏览器里加载不了。两处都很短，由测试盯着不漂移。
 */
function ruleLabel(rule) {
  if (!rule) return '';
  const kind = AL_KIND_LABELS[rule.kind] || rule.kind;
  return `${kind} ${AL_DIR_SYMBOLS[rule.dir] || ''} ${alFormatValue(rule.kind, rule.value)}`;
}

/**
 * 渲染规则编辑器。
 *
 * @param {HTMLElement} container 会被清空
 * @param {object} rulesByCode { [code]: Rule[] }
 * @param {Array} watchlist 用于把代码显示成名称，并标出孤儿规则
 * @param {{ onRemove?: (code, rule) => void, onToggle?: (code, rule) => void }} [opts]
 */
function renderRuleEditor(container, rulesByCode, watchlist, opts = {}) {
  const doc = container.ownerDocument;
  container.textContent = '';

  const src = rulesByCode && typeof rulesByCode === 'object' ? rulesByCode : {};
  const list = Array.isArray(watchlist) ? watchlist : [];
  // 名称查表。孤儿规则（股票已从关注列表移除）查不到，显示代码本身
  const nameOf = (code) => {
    const w = list.find((x) => x.code === code);
    return (w && (w.alias || w.name || w.digits)) || code;
  };
  const known = new Set(list.map((w) => w.code));

  const codes = Object.keys(src).filter((c) => Array.isArray(src[c]) && src[c].length > 0);
  if (codes.length === 0) {
    const hint = doc.createElement('div');
    hint.className = 'hint';
    hint.textContent = '还没有预警规则。用下面一行添加，触发时会弹系统通知';
    container.appendChild(hint);
    return;
  }

  // 关注列表里的排在前、孤儿规则排在后 —— 后者是「历史遗留」，不该占据视线焦点
  codes.sort((a, b) => {
    const ka = known.has(a) ? 0 : 1;
    const kb = known.has(b) ? 0 : 1;
    if (ka !== kb) return ka - kb;
    return a < b ? -1 : a > b ? 1 : 0;
  });

  for (const code of codes) {
    for (const rule of src[code]) {
      container.appendChild(ruleRow(doc, code, rule, { ...opts, name: nameOf(code), orphan: !known.has(code) }));
    }
  }
}

/**
 * 一条规则：股票名 + 条件描述 +（停用标记）+ 删除。
 */
function ruleRow(doc, code, rule, opts = {}) {
  const row = doc.createElement('div');
  row.className = `rule-row${rule.enabled === false ? ' is-off' : ''}${opts.orphan ? ' is-orphan' : ''}`;

  const name = doc.createElement('span');
  name.className = 'rule-name';
  name.textContent = opts.name || code;
  row.appendChild(name);

  const label = doc.createElement('span');
  label.className = 'rule-label';
  label.textContent = ruleLabel(rule);
  row.appendChild(label);

  // 孤儿规则要标出来：它不参与匹配（引擎只遍历行情列表），
  // 不说明的话用户会以为规则失效了是 bug
  if (opts.orphan) {
    const tag = doc.createElement('span');
    tag.className = 'rule-tag';
    tag.textContent = '不在关注列表';
    row.appendChild(tag);
  }

  // 启用/停用切换。用 chip 而非勾选框：一行里已经有名称、条件、删除三项，
  // 勾选框的点击热区在 340px 下太挤
  if (typeof opts.onToggle === 'function') {
    const toggle = doc.createElement('button');
    toggle.className = `chip rule-toggle${rule.enabled === false ? '' : ' on'}`;
    toggle.type = 'button';
    toggle.textContent = rule.enabled === false ? '已停用' : '启用中';
    toggle.title = rule.enabled === false ? '点击启用这条规则' : '点击临时停用这条规则';
    toggle.addEventListener('click', () => opts.onToggle(code, rule));
    row.appendChild(toggle);
  }

  if (typeof opts.onRemove === 'function') {
    const del = doc.createElement('button');
    del.className = 'watch-remove';
    del.type = 'button';
    del.title = '删除这条规则';
    del.textContent = '✕';
    del.addEventListener('click', () => opts.onRemove(code, rule));
    row.appendChild(del);
  }

  row.title = ruleRowTitle(code, rule, opts);
  return row;
}

/** 悬停提示：把行里放不下的说明补齐 */
function ruleRowTitle(code, rule, opts = {}) {
  const parts = [`${opts.name || code}（${code}）`, ruleLabel(rule)];
  if (rule.enabled === false) parts.push('已停用，不会触发');
  if (opts.orphan) parts.push('该股票已不在关注列表，规则暂不生效（加回来即恢复）');
  parts.push('每条规则每天最多提醒一次，次日自动重置');
  return parts.join('\n');
}

/**
 * 总开关与状态摘要。
 *
 * @param {HTMLElement} container 会被清空
 * @param {object|null} alerts get-alerts 的结果
 */
function renderAlertStatus(container, alerts) {
  const doc = container.ownerDocument;
  container.textContent = '';
  if (!alerts) return;

  const n = countRules(alerts.rules);
  const text = doc.createElement('span');
  text.className = 'hint';
  if (!alerts.enabled) {
    text.textContent = n > 0 ? `预警已全部静音（${n} 条规则保留）` : '预警已关闭';
  } else {
    text.textContent = n > 0 ? `${n} 条规则生效中` : '尚无规则';
  }
  container.appendChild(text);
}

/** 规则总条数 */
function countRules(rulesByCode) {
  const src = rulesByCode && typeof rulesByCode === 'object' ? rulesByCode : {};
  let n = 0;
  for (const list of Object.values(src)) {
    if (Array.isArray(list)) n += list.length;
  }
  return n;
}

/**
 * 往 rulesByCode 里加一条，返回**新对象**（不改原对象）。
 *
 * 放在渲染层而非主进程：设置面板要先在本地拼出完整的 rules 再整体提交
 * （config.patch 对 rules 是整体替换语义，见 config.js）。
 * 去重与上限由主进程的 normalizeRules 兜底，这里不重复实现。
 */
function addRule(rulesByCode, code, rule) {
  const src = rulesByCode && typeof rulesByCode === 'object' ? rulesByCode : {};
  const cur = Array.isArray(src[code]) ? src[code] : [];
  return { ...src, [code]: [...cur, rule] };
}

/**
 * 从 rulesByCode 里删一条，返回新对象。
 *
 * 按 kind+dir+value 匹配而非 id：设置界面里新加的规则还没落盘、没有 id。
 * 同 kind+dir 在规范化后只会有一条，所以这三项足以唯一定位。
 */
function removeRule(rulesByCode, code, rule) {
  const src = rulesByCode && typeof rulesByCode === 'object' ? rulesByCode : {};
  const cur = Array.isArray(src[code]) ? src[code] : [];
  const left = cur.filter(
    (r) => !(r.kind === rule.kind && r.dir === rule.dir && r.value === rule.value)
  );
  const out = { ...src };
  // 删空了就去掉这个键，与 config.normalizeAlerts 的行为一致
  if (left.length > 0) out[code] = left;
  else delete out[code];
  return out;
}

/** 切换某条规则的启用状态，返回新对象 */
function toggleRule(rulesByCode, code, rule) {
  const src = rulesByCode && typeof rulesByCode === 'object' ? rulesByCode : {};
  const cur = Array.isArray(src[code]) ? src[code] : [];
  const next = cur.map((r) =>
    r.kind === rule.kind && r.dir === rule.dir && r.value === rule.value
      ? { ...r, enabled: r.enabled === false }
      : r
  );
  return { ...src, [code]: next };
}

/** 见文件头注释：导出对象名必须全局唯一 */
const ALERTS_API = {
  renderRuleEditor,
  ruleRow,
  ruleRowTitle,
  ruleLabel,
  renderAlertStatus,
  countRules,
  addRule,
  removeRule,
  toggleRule,
  alFormatValue,
  AL_KIND_LABELS,
  AL_DIR_SYMBOLS,
};

if (typeof module !== 'undefined' && module.exports) module.exports = ALERTS_API;
if (typeof window !== 'undefined') window.StockAlerts = ALERTS_API;
