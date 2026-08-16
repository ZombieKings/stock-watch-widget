'use strict';

/**
 * 悬浮窗几何：三种窗口模式的尺寸换算。
 *
 * 三态：
 *   expanded  完整详情，高度自适应内容（autoBounds）
 *   list      多股列表，高度由行数决定（listBounds）
 *   collapsed 单行，高度固定 40（collapsedBounds）
 *
 * 抽成独立模块是为了能单测——模式切换有三处容易写错：
 *   1. 切到非展开态后若把「当前高度」存进配置，那存下的是折叠/列表高度，
 *      展开就再也回不到原尺寸
 *   2. Electron 的 minimumSize 会夹住 setBounds：minHeight 还是 360 时
 *      setBounds({height: 40}) 会被静默改成 360，必须先 setMinimumSize 放开。
 *      **列表模式这个坑更隐蔽**：它的高度介于 40 与 360 之间，股票少时
 *      （3 只 → 116px）被夹回 360，股票多时（14 只 → 400px）却正常，
 *      症状是「股票少的时候切列表模式没反应」，容易被当成偶发
 *   3. 配置里的 bounds 可能缺字段或被手改坏，展开时要能回落到默认高度
 *
 * 其中 2 是 Electron 运行时行为，只能靠 main.js 里的调用顺序 + 注释保证；
 * 1 和 3 是纯计算，由本模块的函数兜住。
 */

/** 展开态默认尺寸：宽度够放新闻标题，高度够竖排「行情 + 走势图 + 新闻」 */
const WIN_W = 340;
const WIN_H = 580;

/** 展开态最小尺寸 */
const MIN_W = 300;
const MIN_H = 360;

/**
 * 新闻区在自动算高时按多高计。
 *
 * 不能按它的内容算：新闻列表本身能有上千像素（30 条新闻），按内容算会让窗口
 * 顶到屏幕高度。145px 是默认 580px 窗口下新闻区的实测高度，沿用它，
 * 自动调高前后新闻区的观感就是一致的。
 */
const NEWS_TARGET_H = 145;

/** 自动调高时窗口底部与工作区下沿留的间距 */
const SCREEN_MARGIN = 16;

/**
 * 折叠态高度：单行「名称 + 价格 + 涨跌幅」刚好放得下。
 * 改这个值要同步 style.css 里 .collapsed-bar 的字号，否则内容会被裁掉。
 */
const COLLAPSED_H = 40;

/** 三种窗口模式。加模式要同时改 boundsForMode / minSizeForMode / resizableForMode */
const MODES = ['expanded', 'list', 'collapsed'];

/** 列表模式一行的高度。改这个值要同步 style.css 的 .list-row */
const LIST_ROW_H = 26;

/** 列表模式表头（拖拽区 + 模式切换按钮）的高度 */
const LIST_HEAD_H = 34;

/**
 * 列表模式最多显示几行不滚动。
 *
 * 14 行 = 34 + 14×26 + 2 = 400px，与默认窗口 580px 同量级 ——
 * 切过去不会一下顶满屏幕。关注更多股票时靠列表自身的滚动区消化。
 */
const LIST_MAX_ROWS = 14;

/**
 * 列表模式至少要多高。
 *
 * 一行的高度：关注列表为空时这里放「还没有关注的股票」的空态提示，
 * 与一行数据占的地方一样，所以下限直接按一行算。
 */
const LIST_MIN_H = LIST_HEAD_H + LIST_ROW_H + 2;

/**
 * 取一份可用的列表态高度。
 *
 * 与 safeExpandedHeight 分开：那个的下限是 MIN_H(360)，用它校验列表高度会把
 * 用户拖出来的紧凑窗口（比如 4 行 = 138px）判为非法，静默弹回 580。
 */
function safeListHeight(v) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n >= LIST_MIN_H ? n : null;
}

/**
 * 把任意输入收成一个合法矩形。
 * 逐字段兜底而非整体丢弃：位置坏了不该连尺寸一起回落到默认值。
 */
function normalizeRect(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const pick = (v, fallback) => {
    const n = Math.round(Number(v));
    return Number.isFinite(n) ? n : fallback;
  };
  return {
    x: pick(r.x, 0),
    y: pick(r.y, 0),
    width: pick(r.width, WIN_W),
    height: pick(r.height, WIN_H),
  };
}

/**
 * 取一份可用的展开态高度。
 *
 * 小于最小高度的值一律不采信——那通常是「折叠态高度被误存进配置」留下的痕迹，
 * 直接用它展开会得到一个只有 40px 的窗口，看着像启动失败。
 */
function safeExpandedHeight(v, fallback = WIN_H) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n >= MIN_H ? n : fallback;
}

/** 折叠后的窗口矩形：位置与宽度不动，只压高度 */
function collapsedBounds(current) {
  const b = normalizeRect(current);
  return { x: b.x, y: b.y, width: b.width, height: COLLAPSED_H };
}

/**
 * 展开后的窗口矩形：位置与宽度沿用当前值，高度取配置里记住的展开高度。
 * @param {object} current 当前（折叠态）窗口矩形
 * @param {number} [storedHeight] 配置里存的展开态高度
 */
function expandedBounds(current, storedHeight) {
  const b = normalizeRect(current);
  return { x: b.x, y: b.y, width: b.width, height: safeExpandedHeight(storedHeight) };
}

/**
 * 算出该往配置里写的 bounds。
 *
 * 非展开态下窗口高度不是展开高度（折叠是 40，列表是按行数算的），直接存会把
 * 展开高度冲掉，所以高度沿用已存的值；位置与宽度仍要跟着走——用户在折叠或
 * 列表态挪动窗口，下次启动得回到新位置。
 *
 * **列表模式必须与折叠模式同样处理**，这是最容易漏的一处：列表高度看着像个
 * 「正常」的窗口高度（3 只股票是 116px，不像 40 那么显眼），照原样写进配置后
 * 切回展开就是个 116px 的窗口。
 *
 * 兼容旧调用：仍接受 collapsed 布尔（等价于 mode='collapsed'）——
 * 它与 mode 同时给时以 mode 为准。
 *
 * @param {{ current: object, stored?: object, mode?: string, collapsed?: boolean }} p
 */
function boundsToPersist(p) {
  const current = normalizeRect(p && p.current);
  const mode = resolveMode(p && p.mode, p && p.collapsed);
  if (mode === 'expanded') return current;
  const stored = p && p.stored && typeof p.stored === 'object' ? p.stored : null;
  return { ...current, height: safeExpandedHeight(stored && stored.height) };
}

/**
 * 列表态下用户手动拖出来的高度，该往配置里写什么。
 *
 * 列表高度**另存一个字段**（配置里的 listHeight），不进 bounds.height ——
 * 那一格是展开态高度，被列表态的紧凑值（4 行 = 138px）覆盖后，
 * safeExpandedHeight 会判它非法并回落到 580，用户手动拖的展开高度就丢了。
 * 这与「折叠高度不能进 bounds」是同一个坑的第三种形态。
 *
 * @param {{ current: object, mode?: string }} p
 * @returns {number|null} 该记的高度；不在列表态、或高度不合法时为 null（调用方跳过）
 */
function listHeightToPersist(p) {
  if (resolveMode(p && p.mode) !== 'list') return null;
  const current = normalizeRect(p && p.current);
  return safeListHeight(current.height);
}

/**
 * 把 mode / collapsed 两种表达收成一个合法模式名。
 *
 * mode 优先：调用方两个都给且互相矛盾时（手改过的配置、半迁移的调用点），
 * 采信新字段而不是猜。非法 mode 一律回落 expanded，绝不产出 NaN 尺寸 ——
 * 悬浮窗宁可尺寸不对也不能开不出来。
 */
function resolveMode(mode, collapsed) {
  if (typeof mode === 'string' && MODES.includes(mode)) return mode;
  return collapsed === true ? 'collapsed' : 'expanded';
}

/** 首次启动的默认位置：贴屏幕右上角 */
function defaultBounds(screenWidth) {
  const w = Number(screenWidth);
  const x = Number.isFinite(w) ? Math.round(w - WIN_W - 24) : 24;
  return { x, y: 24, width: WIN_W, height: WIN_H };
}

/**
 * 按内容需要的高度算出窗口该多高（分组展开/收起后自动调整）。
 *
 * 三条规则，优先级由高到低：
 *   1. 不低于用户手动拖出来的高度（userHeight）—— 用户把窗口拉高是为了多看新闻，
 *      收起分组时缩回默认值会把那份空间又拿走，等于覆盖用户的选择
 *   2. 不超出工作区下沿（留 SCREEN_MARGIN 间距）。装不下就截断，
 *      剩下的靠渲染层的滚动区消化 —— 全部展开需要 1509px，比多数屏幕的
 *      工作区还高，截断是必然会走到的分支，不是边角情况
 *   3. 若截断后仍不够、而窗口上方还有空间，就把 y 上移让窗口能更高。
 *      只在窗口贴着屏幕下半部时才有效果
 *
 * 高度永远不小于 MIN_H。
 *
 * @param {{ needed?: number, userHeight?: number, current?: object, workArea?: object }} p
 *        needed     渲染层量出的内容所需高度
 *        userHeight 配置里记的用户手动高度（下限）
 *        current    当前窗口矩形
 *        workArea   屏幕工作区 { x, y, width, height }，缺省时不做上限约束
 * @returns {{ x: number, y: number, width: number, height: number }}
 */
function autoBounds(p) {
  const cur = normalizeRect(p && p.current);
  const want = Math.round(Number(p && p.needed));

  // 用户手动高度是下限。它不合法时（首次运行、配置坏了）退到默认高度
  const floor = safeExpandedHeight(p && p.userHeight);
  let height = Math.max(MIN_H, floor, Number.isFinite(want) ? want : floor);

  const wa = p && p.workArea && typeof p.workArea === 'object' ? p.workArea : null;
  const waY = Math.round(Number(wa && wa.y));
  const waH = Math.round(Number(wa && wa.height));
  // 工作区信息不全时只保底 MIN_H，不做上限约束——宁可窗口偏高，
  // 也不要因为拿不到屏幕信息就把窗口压小
  if (!Number.isFinite(waY) || !Number.isFinite(waH) || waH <= 0) {
    return { x: cur.x, y: cur.y, width: cur.width, height };
  }

  const waBottom = waY + waH;
  let y = cur.y;

  // 当前位置能放多高
  const roomBelow = waBottom - y - SCREEN_MARGIN;
  if (height > roomBelow) {
    // 规则 3：上方还有空间就上移。上移到工作区顶部为止，不越出屏幕
    const maxRoom = waBottom - waY - SCREEN_MARGIN * 2;
    const target = Math.min(height, Math.max(MIN_H, maxRoom));
    y = Math.max(waY + SCREEN_MARGIN, waBottom - SCREEN_MARGIN - target);
    // 规则 2：上移后仍放不下就截断，余下靠滚动区
    height = Math.max(MIN_H, Math.min(target, waBottom - y - SCREEN_MARGIN));
  }

  return { x: cur.x, y: Math.round(y), width: cur.width, height: Math.round(height) };
}

/**
 * 列表模式该多高：表头 + n 行 + 上下边框各 1px。
 *
 * 夹在 [一行, LIST_MAX_ROWS 行] 之间。行数为 0 时按一行算——那时列表里放的是
 * 「还没有关注的股票」的空态提示，占的地方和一行数据一样。
 *
 * @param {number} rowCount 关注列表长度
 * @returns {number} 像素高度，永远是正整数
 */
function listHeight(rowCount, userHeight) {
  /**
   * 用户手动拖过高度就完全听他的 —— 自动定高彻底让位。
   *
   * 加股票超出窗口时靠 .list-rows 自身的滚动条消化，减股票则底部留白。
   * 这与展开态 autoBounds 的「用户高度当下限、内容更高时仍会长高」不同：
   * 那边的内容（走势图、分组、资讯）不铺开就没法读，而列表少显示几行
   * 只是要滚一下，代价小得多。「你设成多高就一直是多高」在这里更可预测。
   */
  const user = safeListHeight(userHeight);
  if (user != null) return user;

  const n = Math.round(Number(rowCount));
  // 非法值按 0 处理 → 落到下限。渲染层量错行数不该让窗口尺寸变成 NaN
  const rows = Number.isFinite(n) && n > 0 ? Math.min(n, LIST_MAX_ROWS) : 0;
  return Math.max(LIST_MIN_H, LIST_HEAD_H + rows * LIST_ROW_H + 2);
}

/**
 * 列表模式的窗口矩形：位置与宽度沿用当前值，高度按行数算或用用户拖过的值。
 *
 * 不做工作区约束——那需要 screen 信息，属于 main.js 的职责（见 autoBounds 的
 * workArea 参数）。LIST_MAX_ROWS 已经把自动高度压在 400px 以内；用户手动拖的
 * 高度受 Electron 自身的屏幕约束，也越不出去。
 *
 * @param {object} current 当前窗口矩形
 * @param {number} rowCount 关注列表长度
 * @param {number} [userHeight] 用户在列表态手动拖出来的高度。给了就优先用它
 */
function listBounds(current, rowCount, userHeight) {
  const b = normalizeRect(current);
  return { x: b.x, y: b.y, width: b.width, height: listHeight(rowCount, userHeight) };
}

/**
 * 模式 → 目标矩形的统一入口。
 *
 * 抽出来是为了让 main.js 的 setMode 不必写 if/else 三分支：那种分支散在副作用
 * 代码里，加第四种模式时容易漏掉一处。
 *
 * @param {{ mode, current, storedHeight?, rowCount?, listHeight? }} p
 *        storedHeight 展开态记住的高度；listHeight 列表态记住的高度。
 *        两者必须分开传 —— 混用会让列表态的紧凑高度冲掉展开态的高度
 */
function boundsForMode(p) {
  const mode = resolveMode(p && p.mode);
  const current = p && p.current;
  if (mode === 'collapsed') return collapsedBounds(current);
  if (mode === 'list') return listBounds(current, p && p.rowCount, p && p.listHeight);
  return expandedBounds(current, p && p.storedHeight);
}

/**
 * 该模式下的 minimumSize。
 *
 * 这是 Electron 那个「setBounds 被 minimumSize 静默夹住」坑的解药：切模式时
 * 必须**先**用这个值 setMinimumSize，**再** setBounds。
 *
 * 折叠与列表都要把下限压到各自的目标高度以下，否则 setBounds 不生效，
 * 表现为「点了切换没反应」——不是计算错误，是 Electron 的行为。
 */
function minSizeForMode(mode) {
  const m = resolveMode(mode);
  if (m === 'collapsed') return { minWidth: MIN_W, minHeight: COLLAPSED_H };
  // 列表模式的下限就是它自己的最小高度（一行）。用 LIST_MIN_H 而非 COLLAPSED_H：
  // 放得比需要的更松没有好处，用户手动缩放时能拖出一个比一行还矮的窗口
  if (m === 'list') return { minWidth: MIN_W, minHeight: LIST_MIN_H };
  return { minWidth: MIN_W, minHeight: MIN_H };
}

/**
 * 该模式下窗口能否手动缩放。
 *
 * 折叠与列表的高度都是算出来的（固定 40 / 按行数），允许拖高只会让用户得到
 * 一个下半截空白、或内容被裁掉的窗口。只有展开态的高度是「用户说了算」的。
 */
function resizableForMode(mode) {
  // 折叠态是唯一不可缩放的：那一行的高度由字号定死（COLLAPSED_H），
  // 拖高只会得到一条上下留白的空条，拖矮则把内容裁掉。
  // 列表态可缩放——宽度影响名称能显示多少字，高度影响显示几行，两者都是
  // 用户会想调的；超出的行靠 .list-rows 自身滚动消化
  return resolveMode(mode) !== 'collapsed';
}

/** 按 expanded → list → collapsed → expanded 轮换 */
function nextMode(mode) {
  const at = MODES.indexOf(resolveMode(mode));
  return MODES[(at + 1) % MODES.length];
}

module.exports = {
  WIN_W,
  WIN_H,
  MIN_W,
  MIN_H,
  COLLAPSED_H,
  NEWS_TARGET_H,
  SCREEN_MARGIN,
  MODES,
  LIST_ROW_H,
  LIST_HEAD_H,
  LIST_MAX_ROWS,
  LIST_MIN_H,
  normalizeRect,
  safeExpandedHeight,
  safeListHeight,
  collapsedBounds,
  expandedBounds,
  boundsToPersist,
  listHeightToPersist,
  defaultBounds,
  autoBounds,
  resolveMode,
  listHeight,
  listBounds,
  boundsForMode,
  minSizeForMode,
  resizableForMode,
  nextMode,
};
