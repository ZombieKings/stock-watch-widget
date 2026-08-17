'use strict';

/**
 * 配置读写。存于 %APPDATA%/StockWatchWidget/config.json。
 *
 * 约定：normalizeConfig 永不抛异常——配置文件损坏、字段缺失、类型不对
 * 都要能回落到可用默认值，否则悬浮窗启动即白屏。
 */

const fs = require('fs');
const path = require('path');
const { normalizeCode } = require('./stockCode');
const { parseCost, parseShares } = require('./position');
const { normalizeRules } = require('./alertRules');

const FILE_NAME = 'config.json';

/** 分时图刷新间隔下限，防止用户填 0 把接口打爆 */
const MIN_REFRESH_MS = 2000;

const DEFAULTS = {
  /**
   * 关注列表：[{ code: 'sh600519', alias: '', cost: null, shares: null }]。
   * alias 为空则用行情返回的名称；cost/shares 为 null 表示未设持仓
   */
  watchlist: [],
  /** 当前选中的股票 code；为空时取 watchlist 首个 */
  selected: '',
  /** 盘中轮询间隔（毫秒）。为 0/未设时按 marketTime.pollIntervalMs 自动决定 */
  refreshMs: 0,
  /** 新闻列表最多显示条数 */
  newsLimit: 30,
  /** 是否把公司公告混入新闻列表 */
  includeAnnouncements: true,
  /** 新闻只看当日；false 则显示近期全部（仍按日期分组） */
  todayOnly: false,
  /** 窗口透明度 0.3~1 */
  opacity: 1,
  /**
   * 贴边后自动隐藏到屏幕边缘（鼠标碰边缘再滑出来）。
   *
   * 默认**关**。吸附本身（拖到边上自动对齐）是无条件的，那个只是让窗口摆得整齐；
   * 而自动隐藏会让窗口主动从视野里消失 —— 没预期到的用户会以为挂件崩了或被
   * 误关了，而它又没有任务栏入口可确认。这种「行为惊人」的能力该由用户显式开启。
   *
   * 几何与触发条件见 src/edgeSnap.js。
   */
  autoHide: false,
  /** 窗口位置与尺寸，退出时记住。非展开态下高度存的仍是**展开**高度 */
  bounds: null,
  /**
   * 列表模式下用户手动拖出来的高度。null = 从未手动调过，按行数自动定高。
   *
   * 单独一个字段而不是塞进 bounds.height：那一格是展开态高度，被列表态的
   * 紧凑值（4 行 = 138px）覆盖后会被判为非法并回落到 580，用户手动拖的
   * 展开高度就丢了。与「折叠高度不能进 bounds」是同一个坑的第三种形态。
   *
   * 宽度不必单独存：三种模式共用同一个宽度（切模式只改高度），
   * bounds.width 那一格已经够了。
   */
  listHeight: null,
  /**
   * 窗口模式，退出时记住：
   *   expanded  完整详情
   *   list      多股列表（每行一只：名称 + 现价 + 涨跌幅）
   *   collapsed 单行（名称 + 价格 + 涨跌幅）
   *
   * 取代原来的布尔 collapsed —— 三态用布尔表达不了。
   */
  mode: 'expanded',
  /**
   * @deprecated 由 mode 取代，但**不删**。
   *
   * 保留的理由是降级路径：用户装了新版又回退到旧版时，旧版认不得 mode 会拿
   * 默认值，但 collapsed 还在，不会退化成「每次启动都是展开态」。
   * 6 个字节换一条平滑的回退路，值得。
   *
   * 读写规则见 normalizeMode：它始终是 mode 的投影，不作为独立真相。
   */
  collapsed: false,
  /**
   * 各分组的展开状态，退出时记住。与上面的 collapsed 是两回事：
   * collapsed 折叠整个窗口，这里折叠窗口内的单个分组。
   *
   * 全部默认收起 —— 每个分组展开都要额外发一次请求，
   * 默认展开会让每次切股票都多打五个接口。
   */
  sections: {
    indicators: false,
    flow: false,
    margin: false,
    finance: false,
    lhb: false,
    reports: false,
    /** 交易记录。数据源是本地 trades.json，不是行情接口 */
    trades: false,
  },
  /**
   * 价格预警。
   *
   * 规则按股票代码分组，与 watchlist **平级**而不是塞进 watchlist[] 里：
   *   - 塞进去的话 normalizeWatchlist 每次都要连带跑一遍规则校验
   *   - 而且从关注列表里临时移除一只股票会把它的规则一起丢掉，
   *     用户加回来时得重新配一遍
   *
   * enabled 是总开关，关掉时引擎仍算但不发通知（便于临时静音，
   * 不必删掉规则）。
   */
  alerts: {
    enabled: true,
    /** { 'sh600519': [ {id, kind, dir, value, enabled}, ... ] } */
    rules: {},
  },
};

/** sections 的合法键。加新分组时在这里登记，否则会被 sanitize 丢掉 */
const SECTION_KEYS = ['indicators', 'flow', 'margin', 'finance', 'lhb', 'reports', 'trades'];

/**
 * 合法的窗口模式。与 src/windowLayout.js 的 MODES 是同一份约定。
 *
 * 没有从那边 require 过来：config 是纯配置层，不该依赖窗口几何模块 ——
 * 反过来 windowLayout 也不认识配置。两边各留一份三元素数组，
 * 由下面那条一致性测试盯着，比引入一个方向可疑的依赖干净。
 */
const MODES = ['expanded', 'list', 'collapsed'];

function isPlainObject(v) {
  return v != null && typeof v === 'object' && !Array.isArray(v);
}

function clampNumber(v, min, max, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** 规范化关注列表：校验代码、去重、保序、剔除非法项 */
function normalizeWatchlist(raw) {
  const items = Array.isArray(raw) ? raw : [];
  const seen = new Set();
  const out = [];

  for (const item of items) {
    // 兼容两种写法：字符串 'sh600519' 或对象 { code, alias }
    const input = typeof item === 'string' ? item : isPlainObject(item) ? item.code : '';
    const r = normalizeCode(input);
    if (!r.ok || seen.has(r.code)) continue;
    seen.add(r.code);
    out.push({
      code: r.code,
      digits: r.digits,
      exchange: r.exchange,
      // 类型每次都由代码重新推导，不采信配置文件里存的值——
      // 手改过的配置或旧版本写入的字段都可能与代码不符
      kind: r.kind,
      isFund: r.isFund,
      alias: isPlainObject(item) && typeof item.alias === 'string' ? item.alias.trim() : '',
      // 持仓成本与数量。非法值（0、负数、文本）统一收成 null，
      // 表示「未设置」——盈亏那块界面据此整体隐藏
      cost: isPlainObject(item) ? parseCost(item.cost) : null,
      shares: isPlainObject(item) ? parseShares(item.shares) : null,
    });
  }
  return out;
}

/**
 * 规范化列表态高度。
 *
 * null 表示「从未手动调过」，此时按行数自动定高 —— 这个语义要保住，
 * 所以非法值一律收成 null 而不是某个默认数字：给个默认值等于替用户
 * 做了「他调过高度」的决定，自动定高就永久失效了。
 *
 * 下限 60 是个粗筛（比一行 62px 略松，留一点余量），精确的夹取由
 * windowLayout.safeListHeight 负责 —— 那边才知道 LIST_MIN_H 是多少。
 * 上限 4000 挡住手改坏的配置（比任何屏幕都高）。
 */
function normalizeListHeight(raw) {
  if (raw == null) return null;
  const n = Math.round(Number(raw));
  if (!Number.isFinite(n) || n < 60 || n > 4000) return null;
  return n;
}

/** 规范化窗口 bounds，字段不全就整体丢弃（让 Electron 用默认位置） */
function normalizeBounds(raw) {
  if (!isPlainObject(raw)) return null;
  const { x, y, width, height } = raw;
  const nums = [x, y, width, height].map(Number);
  if (nums.some((n) => !Number.isFinite(n))) return null;
  return { x: nums[0], y: nums[1], width: nums[2], height: nums[3] };
}

/**
 * 容错补全配置。任何异常输入都返回可用对象。
 */
function normalizeConfig(raw) {
  const cfg = isPlainObject(raw) ? raw : {};
  const watchlist = normalizeWatchlist(cfg.watchlist);
  const mode = normalizeMode(cfg);

  // selected 必须在 watchlist 内，否则回落到首个
  const selectedNorm = normalizeCode(cfg.selected);
  const selectedValid = selectedNorm.ok && watchlist.some((w) => w.code === selectedNorm.code);
  const selected = selectedValid ? selectedNorm.code : watchlist.length > 0 ? watchlist[0].code : '';

  const refreshMsRaw = Number(cfg.refreshMs);
  const refreshMs =
    Number.isFinite(refreshMsRaw) && refreshMsRaw > 0
      ? Math.max(MIN_REFRESH_MS, Math.round(refreshMsRaw))
      : 0; // 0 = 自动

  return {
    watchlist,
    selected,
    refreshMs,
    newsLimit: clampNumber(cfg.newsLimit, 5, 200, DEFAULTS.newsLimit),
    includeAnnouncements:
      typeof cfg.includeAnnouncements === 'boolean' ? cfg.includeAnnouncements : DEFAULTS.includeAnnouncements,
    todayOnly: typeof cfg.todayOnly === 'boolean' ? cfg.todayOnly : DEFAULTS.todayOnly,
    opacity: clampNumber(cfg.opacity, 0.3, 1, DEFAULTS.opacity),
    /**
     * 只认严格的布尔。手改过的配置里可能是字符串 'false'，当真值处理会让
     * 窗口莫名开始自己往屏幕外躲 —— 而用户并不知道这个功能存在，无从排查
     */
    autoHide: typeof cfg.autoHide === 'boolean' ? cfg.autoHide : DEFAULTS.autoHide,
    bounds: normalizeBounds(cfg.bounds),
    /**
     * 列表态高度。下限用 windowLayout.LIST_MIN_H 那套语义（一行的高度），
     * 而不是展开态的 MIN_H —— 用后者会把用户拖出来的紧凑窗口判为非法。
     * 这里只做「正整数且不太小」的粗校验，精确的夹取在 windowLayout 里。
     */
    listHeight: normalizeListHeight(cfg.listHeight),
    mode,
    /**
     * collapsed 始终由 mode 推出，**不采信原值**。
     *
     * 两个字段各自独立读写会漂移（改了一个忘了另一个），只保一个方向的推导
     * 就不会。副作用是 mode='list' 时它是 false，旧版读到会展开 —— 那是合理的
     * 降级：旧版本没有列表模式，展开比折叠更接近用户想看的东西。
     */
    collapsed: mode === 'collapsed',
    sections: normalizeSections(cfg.sections),
    alerts: normalizeAlerts(cfg.alerts),
  };
}

/**
 * 规范化预警配置。
 *
 * 规则本身的校验委托给 alertRules.normalizeRules —— 这里只负责形状兜底与
 * 代码键的合法性（那个模块不认识股票代码格式，保持纯粹）。
 *
 * 不要求代码在 watchlist 里：用户可能先删股票再加回来，规则留着比丢掉更符合
 * 预期。这种「孤儿规则」不参与匹配（evaluateAlerts 只遍历行情 items），
 * 只在设置界面里标注「已不在关注列表」。
 *
 * 空规则数组的键直接删掉，否则「加规则又删掉」会让配置文件单调膨胀。
 */
function normalizeAlerts(raw) {
  const src = isPlainObject(raw) ? raw : {};
  const srcRules = isPlainObject(src.rules) ? src.rules : {};

  const rules = {};
  for (const [key, list] of Object.entries(srcRules)) {
    const r = normalizeCode(key);
    if (!r.ok) continue;
    const norm = normalizeRules(list);
    if (norm.length > 0) rules[r.code] = norm;
  }

  return {
    enabled: typeof src.enabled === 'boolean' ? src.enabled : DEFAULTS.alerts.enabled,
    rules,
  };
}

/**
 * 定出窗口模式。
 *
 * 要兼容三种配置文件：
 *   1. 只有 collapsed（旧版）→ true 映射到 'collapsed'，其余到 'expanded'
 *   2. 只有 mode（新版）→ 直接用
 *   3. 两者都有 → **mode 优先**。正常情况下两者自洽（collapsed 由 mode 推出），
 *      不自洽时说明用户手改过文件，采信新字段而不是猜
 *
 * collapsed 只认严格的 true：手改过的配置里可能是 'false' 字符串，
 * 当真值处理会导致启动即折叠。
 */
function normalizeMode(raw) {
  const cfg = isPlainObject(raw) ? raw : {};
  if (typeof cfg.mode === 'string' && MODES.includes(cfg.mode)) return cfg.mode;
  return cfg.collapsed === true ? 'collapsed' : DEFAULTS.mode;
}

/**
 * 只保留 SECTION_KEYS 里登记过的键，值必须是布尔。
 * 旧版本配置文件没有 sections 字段，会走到这里拿默认值。
 */
function normalizeSections(raw) {
  const src = isPlainObject(raw) ? raw : {};
  const out = {};
  for (const key of SECTION_KEYS) {
    out[key] = typeof src[key] === 'boolean' ? src[key] : DEFAULTS.sections[key];
  }
  return out;
}

/** 是否已经配置到可用状态（至少关注一只股票） */
function isConfigured(cfg) {
  const n = normalizeConfig(cfg);
  return n.watchlist.length > 0;
}

/**
 * 创建配置存储。
 * @param {string} userDataDir 一般传 app.getPath('userData')
 */
function createConfigStore(userDataDir) {
  const filePath = path.join(userDataDir, FILE_NAME);

  function load() {
    try {
      const text = fs.readFileSync(filePath, 'utf8');
      return normalizeConfig(JSON.parse(text));
    } catch {
      // 首次运行文件不存在，或内容损坏——都回落到默认配置
      return normalizeConfig(null);
    }
  }

  function save(cfg) {
    const normalized = normalizeConfig(cfg);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(normalized, null, 2), 'utf8');
    return normalized;
  }

  /**
   * 局部更新：读出来合并再写回。
   *
   * sections 要深合并 —— 浅合并下 patch({ sections: { flow: true } })
   * 会把整个 sections 换掉，normalizeSections 再给缺失的 indicators 填默认值，
   * 结果是「展开资金流」顺手把「技术指标」收了回去。
   *
   * alerts 同样要深合并，且是比 sections 更贵的版本：
   * patch({alerts: {enabled: false}}) 浅合并会把整个 rules 换成 {}，
   * 用户配的所有预警规则静默消失。
   */
  function patch(partial) {
    const p = isPlainObject(partial) ? partial : {};
    const cur = load();
    const merged = { ...cur, ...p };
    if (isPlainObject(p.sections)) {
      merged.sections = { ...cur.sections, ...p.sections };
    }
    if (isPlainObject(p.alerts)) {
      merged.alerts = { ...cur.alerts, ...p.alerts };
      /**
       * rules 本身是**整体替换**而非 per-code 合并：单条规则的增删改都由渲染层
       * 算好整个对象再提交。做成合并语义的话「删掉某只股票的全部规则」
       * 就表达不出来了（提交 {} 会被当成「什么都没改」）。
       */
      if (isPlainObject(p.alerts.rules)) merged.alerts.rules = p.alerts.rules;
    }
    return save(merged);
  }

  return { filePath, load, save, patch };
}

module.exports = {
  createConfigStore,
  normalizeConfig,
  normalizeWatchlist,
  isConfigured,
  DEFAULTS,
  MIN_REFRESH_MS,
  FILE_NAME,
  SECTION_KEYS,
  MODES,
  normalizeSections,
  normalizeMode,
  normalizeAlerts,
  normalizeListHeight,
};
