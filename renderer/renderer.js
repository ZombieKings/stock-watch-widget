'use strict';

/**
 * 渲染层逻辑。
 *
 * 两条独立的刷新节奏：
 *   行情+分时 —— 按交易时段轮询（盘中 3 秒，收盘后 5 分钟）
 *   新闻+公告 —— 固定 3 分钟，新闻不会秒级变化，没必要跟着行情打
 *
 * 安全约定：新闻标题来自第三方站点，一律用 textContent 写入，绝不拼 innerHTML。
 */

const NEWS_INTERVAL_MS = 180000;

const $ = (id) => document.getElementById(id);

/** 每根 K 线的目标像素宽度，据此按画布宽算要取多少根 */
const PX_PER_BAR = 5;

/** 每根 K 线的最小可辨像素宽。再窄实体就退化成一条竖线，看不出形态 */
const MIN_PX_PER_BAR = 1.5;

/**
 * 各周期默认显示的根数（用户未手动缩放时）。
 *
 * 按时间跨度定而非按画布宽——「最近 90 天」「最近半年」是看盘时真正想要的尺度，
 * 画布宽只该影响每根有多粗，不该决定看多长的历史。
 *   day  = 90 根日K
 *   week = 26 根周K ≈ 6 个月
 */
const DEFAULT_BAR_COUNT = {
  /** 一天 4 根，48 根 ≈ 12 个交易日。接口硬顶 126 根（≈31 天），别设太接近上限 */
  min60: 48,
  day: 90,
  week: 26,
};

/** 判定为拖拽的最小位移。小于这个值当成点击，仍走悬停读数 */
const DRAG_THRESHOLD_PX = 3;

/** 走势图视图：minute=分时，day5=5日分时，min60=60分钟K，day=日K，week=周K */
const VIEWS = ['minute', 'day5', 'min60', 'day', 'week'];

/** 走 K 线接口的视图。新增视图时只改这里，避免到处写 !== 'minute' */
const KLINE_VIEWS = ['min60', 'day', 'week'];

/** 当前视图是否画 K 线（60分/日/周），而非分时类 */
function isKlineView(view) {
  return KLINE_VIEWS.includes(view);
}

/**
 * 视图 → 传给 IPC 的 period 值。
 *
 * 视图名与周期名分开：视图是 UI 概念（标签页），period 是数据层概念。
 * 60 分钟那档两边不同名（min60 vs 60min），混用极易写错，这里显式映射。
 */
const VIEW_PERIOD = {
  min60: '60min',
  day: 'day',
  week: 'week',
};

/** 运行时状态 */
const state = {
  config: null,
  watchlist: [],
  /** 持仓汇总（summarizePositions 的结果）。无持仓时为 null */
  summary: null,
  selected: '',
  detail: null,
  news: null,
  quoteTimer: null,
  newsTimer: null,
  loading: false,
  lastError: '',
  /** 当前走势图视图 */
  view: 'minute',
  /** 当前视图的 K 线数据；切股票或切周期时置空 */
  kline: null,
  /** K 线加载中/失败提示 */
  klineError: '',
  klineLoading: false,
  /**
   * 两个可折叠分组的状态。open 从配置恢复；data/error/loading 各自独立，
   * 一个分组请求失败不影响另一个。
   */
  groups: {
    indicators: { open: false, data: null, error: '', loading: false },
    flow: { open: false, data: null, error: '', loading: false },
    margin: { open: false, data: null, error: '', loading: false },
    finance: { open: false, data: null, error: '', loading: false },
    lhb: { open: false, data: null, error: '', loading: false },
    trades: { open: false, data: null, error: '', loading: false },
  },
  /**
   * 已实现盈亏的区间筛选：'month' | 'all'。
   *
   * 与 groups.trades 分开存：那个是分组的展开态与流水列表数据，这个只是
   * 详情区那一行的显示范围，切区间不需要重新读流水文件（byMonth 一次都拿到了）。
   */
  realizedRange: 'all',
  realized: null,
  /**
   * 资讯区当前筛选：'all' | 'news' | 'reports'。三者共用一块合并后的时间线，
   * 按发布时间倒序穿插展示，筛选只影响显示哪些条目，不影响取数节奏。
   *
   * 研报数据单独存而不塞进 state.news：新闻有轮询刷新（NEWS_INTERVAL_MS），
   * 研报没有（发布频率是天级），混在一起会被新闻的定时器连带重拉。
   */
  filter: 'all',
  reports: null,
  reportsError: '',
  reportsLoading: false,
  /** 悬停的 K 线下标（可见区内），null 表示未悬停 */
  hoverIndex: null,
  /**
   * 用户缩放后的可见根数；null = 未缩放，按画布宽自动决定。
   * 存在 state 里而非 state.kline 里，是为了跨刷新保留——轮询重拉数据后
   * 缩放级别不该被重置回默认。切股票/切周期时清空。
   */
  zoomCount: null,
  /** 5 日分时数据；切股票或切走时置空 */
  minute5d: null,
  minute5dError: '',
  minute5dLoading: false,
  /**
   * 5 日分时的悬停位置 { dayIdx, pointIdx }。
   * 与 hoverIndex 分开存：那个是数字，两种形状混用极易出 bug。
   */
  hover5d: null,
  /**
   * 日/周K 拖拽平移后，可见窗口右端距「最新一根」的根数。0 = 贴最右（默认）。
   * 与 zoomCount 一样存在 state 而非 state.kline 里——轮询重拉后用户看的位置
   * 不该被拽回最右。切股票/切周期时清零。
   */
  panOffset: 0,
  /**
   * 窗口模式：'expanded' 完整详情 / 'list' 多股列表 / 'collapsed' 单行。
   *
   * 真相源在主进程（窗口尺寸由它改，托盘与右键菜单也能切），这里只是一份镜像，
   * 由 applyMode 统一写入，不要在别处直接赋值。
   */
  mode: 'expanded',
};

/**
 * 详情区（行情数字、走势图、分组、资讯）是否可见。
 *
 * 三态改造前这些判断写的都是 `!state.collapsed`，但它们的真实语义是
 * 「详情看得见吗」—— 列表模式下详情同样不可见。逐个改成
 * `state.mode === 'expanded'` 容易漏，抽成函数后漏改的地方在 review 时更显眼。
 */
function detailVisible() {
  return state.mode === 'expanded';
}

/**
 * 重内容（K 线、5 日分时、五个可折叠分组）是否要跟着轮询。
 *
 * 与 detailVisible 目前恒等，但语义不同：前者管「要不要渲染」，这个管
 * 「要不要发请求」。将来若列表模式想显示迷你走势图，两者就会分叉 ——
 * 那时改这一个函数即可，不必再去甄别十几个调用点当初是哪种意图。
 */
function heavyContentVisible() {
  return state.mode === 'expanded';
}

/**
 * 拖拽起点快照。位移按「相对按下时」算而非逐帧累加——累加的话每帧
 * dragBarShift 都要向零取整，误差会堆成明显的滞后。
 */
const dragBase = { from: 0, x: 0, active: false, moved: false };

// —— 格式化 ——

/** 价格：4 位数以上不留小数位，避免挤爆 26px 字号 */
function fmtPrice(v) {
  if (!Number.isFinite(v)) return '--';
  return v.toFixed(Math.abs(v) >= 1000 ? 2 : 2);
}

function fmtNum(v, digits = 2) {
  return Number.isFinite(v) ? v.toFixed(digits) : '--';
}

function fmtSigned(v, digits = 2) {
  if (!Number.isFinite(v)) return '--';
  return `${v > 0 ? '+' : ''}${v.toFixed(digits)}`;
}

function fmtPct(v) {
  if (!Number.isFinite(v)) return '--';
  return `${v > 0 ? '+' : ''}${v.toFixed(2)}%`;
}

/** 成交量（手）→ 万手/亿手 */
function fmtVolume(hands) {
  if (!Number.isFinite(hands)) return '--';
  if (hands >= 1e8) return `${(hands / 1e8).toFixed(2)}亿手`;
  if (hands >= 1e4) return `${(hands / 1e4).toFixed(2)}万手`;
  return `${Math.round(hands)}手`;
}

/** 成交额：接口给的单位是万元 */
function fmtAmount(wan) {
  if (!Number.isFinite(wan)) return '--';
  if (wan >= 1e4) return `${(wan / 1e4).toFixed(2)}亿`;
  return `${wan.toFixed(0)}万`;
}

/** 市值：接口给的单位是亿元 */
function fmtMarketCap(yi) {
  if (!Number.isFinite(yi)) return '--';
  if (yi >= 1e4) return `${(yi / 1e4).toFixed(2)}万亿`;
  return `${yi.toFixed(0)}亿`;
}

/** 涨跌方向 → CSS class */
function dirClass(v) {
  if (!Number.isFinite(v) || v === 0) return 'flat';
  return v > 0 ? 'up' : 'down';
}

/** 相对日期标签：今天/昨天/MM-DD */
function dateLabel(dateStr, todayKey) {
  if (dateStr === todayKey) return '今天';
  const d = new Date(`${dateStr}T00:00:00`);
  const today = new Date(`${todayKey}T00:00:00`);
  if (!Number.isNaN(d.getTime()) && !Number.isNaN(today.getTime())) {
    const diff = Math.round((today - d) / 86400000);
    if (diff === 1) return '昨天';
    if (diff === 2) return '前天';
  }
  return dateStr.slice(5); // MM-DD
}

function todayKey() {
  const n = new Date();
  const p = (x) => String(x).padStart(2, '0');
  return `${n.getFullYear()}-${p(n.getMonth() + 1)}-${p(n.getDate())}`;
}

function clearNode(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

/** 简易节流：设置面板搜索框防抖 */
function debounce(fn, ms) {
  let t = null;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

// —— 渲染：行情数字 ——

function renderQuote(detail) {
  const q = detail && detail.quote;
  if (!q) return;

  $('pickerName').textContent = pickerNameFor(detail);
  $('pickerCode').textContent = q.code || detail.digits || '';

  $('price').textContent = fmtPrice(q.price);
  $('change').textContent = fmtSigned(q.change);
  $('changePct').textContent = fmtPct(q.changePct);

  const cls = dirClass(q.change);
  $('price').className = `price ${cls}`;
  $('changeBox').className = `change ${cls}`;

  $('open').textContent = fmtPrice(q.open);
  $('prevClose').textContent = fmtPrice(q.prevClose);
  $('high').textContent = fmtPrice(q.high);
  $('low').textContent = fmtPrice(q.low);

  $('volume').textContent = fmtVolume(q.volume);
  $('amount').textContent = fmtAmount(q.amount);
  $('turnover').textContent = Number.isFinite(q.turnover) ? `${fmtNum(q.turnover)}%` : '--';
  $('volumeRatio').textContent = fmtNum(q.volumeRatio);

  // 场内基金没有市盈/市净：接口给的 pe 是空串、pb 是字面 "0.00"，
  // 照原样渲染会显示成「市净 0.00」，看着像真实数据。整项隐藏更诚实。
  // 「市值」对基金实为基金规模（份额 × 净值），换个称呼避免误读。
  const isFund = !!(detail && detail.isFund);
  $('peBox').classList.toggle('hidden', isFund);
  $('pbBox').classList.toggle('hidden', isFund);
  $('marketCapLabel').textContent = isFund ? '规模' : '市值';
  if (!isFund) {
    $('pe').textContent = fmtNum(q.pe);
    $('pb').textContent = fmtNum(q.pb);
  }
  $('marketCap').textContent = fmtMarketCap(q.totalMarketCap);

  renderPosition(detail.position);

  // 开/高/低 也按相对昨收染色，快速看出全天位置
  for (const [id, val] of [['open', q.open], ['high', q.high], ['low', q.low]]) {
    const el = $(id);
    el.className = Number.isFinite(val) && Number.isFinite(q.prevClose) ? dirClass(val - q.prevClose) : '';
  }
}

/** 顶部显示名：别名优先，其次行情返回的名称 */
function pickerNameFor(detail) {
  const entry = state.watchlist.find((w) => w.code === detail.code);
  if (entry && entry.alias) return entry.alias;
  return (detail.quote && detail.quote.name) || detail.digits || '--';
}

// —— 持仓盈亏 ——

/**
 * 持仓金额：带千分位，超过 1 万走「万」、1 亿走「亿」。
 *
 * 与 fmtAmount（成交额，单位万元）不同——这里传入的是元，
 * 且散户持仓多在几万到几十万之间，这个区间保留完整数字更有用，
 * 千分位足以读清；到了百万以上再换单位。
 */
function fmtMoney(v, opts = {}) {
  if (!Number.isFinite(v)) return '--';
  const sign = opts.signed && v > 0 ? '+' : v < 0 ? '-' : '';
  const abs = Math.abs(v);
  if (abs >= 1e8) return `${sign}${(abs / 1e8).toFixed(2)}亿`;
  if (abs >= 1e6) return `${sign}${(abs / 1e4).toFixed(1)}万`;
  // toLocaleString 在 Electron 里可靠（内置完整 ICU），比手写正则稳
  return `${sign}${abs.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * 渲染详情区的持仓盈亏。
 *
 * @param {object|null} pos computePosition 的结果。null = 未设成本价或现价无效，
 *   此时整块隐藏而不是显示「--」：一堆占位符比不显示更干扰
 */
function renderPosition(pos) {
  const box = $('posBox');
  if (!pos) {
    box.classList.add('hidden');
    return;
  }
  box.classList.remove('hidden');

  // 盈亏方向沿用全局红涨绿跌，与当日涨跌同一套配色
  const cls = dirClass(pos.profitPct);

  const costText = pos.hasAmount
    ? `${fmtPrice(pos.cost)} × ${fmtShares(pos.shares)}`
    : fmtPrice(pos.cost);
  $('posCost').textContent = costText;

  $('posPct').textContent = fmtPct(pos.profitPct);
  $('posPct').className = `pos-pct ${cls}`;

  // 只有成本价时没有金额可显示，这一行整体隐藏，但每股盈亏值得留下——
  // 挪到比例旁边，避免只剩一个孤零零的百分比
  if (pos.hasAmount) {
    $('posAmountRow').classList.remove('hidden');
    $('posProfit').textContent = `盈亏 ${fmtMoney(pos.profit, { signed: true })}`;
    $('posProfit').className = `pos-profit ${cls}`;
    $('posValue').textContent = `市值 ${fmtMoney(pos.marketValue)}`;
    $('posPct').title = '';
  } else {
    $('posAmountRow').classList.add('hidden');
    $('posPct').title = `每股盈亏 ${fmtSigned(pos.profitPerShare)}`;
  }

  // 完整数据进 tooltip：当日盈亏平时用不上，但收盘复盘时想看
  const parts = [`成本价 ${fmtPrice(pos.cost)}`];
  if (pos.hasAmount) {
    parts.push(`数量 ${fmtShares(pos.shares)}`);
    parts.push(`持仓成本 ${fmtMoney(pos.costValue)}`);
    parts.push(`市值 ${fmtMoney(pos.marketValue)}`);
    parts.push(`盈亏 ${fmtMoney(pos.profit, { signed: true })} (${fmtPct(pos.profitPct)})`);
    if (pos.todayProfit != null) parts.push(`当日盈亏 ${fmtMoney(pos.todayProfit, { signed: true })}`);
  } else {
    parts.push(`每股盈亏 ${fmtSigned(pos.profitPerShare)} (${fmtPct(pos.profitPct)})`);
    parts.push('填写持仓数量后可显示盈亏金额与市值');
  }
  box.title = parts.join('\n');
}

// —— 已实现盈亏（来自交易流水）——

/**
 * 拉当前股票的已实现盈亏。
 *
 * 与浮动盈亏（随行情轮询刷新）不同，这个只在切股票、增删流水、切区间时才变 ——
 * 流水是本地文件，不会自己变。所以它不挂在 loadDetail 上。
 */
async function loadRealized() {
  if (!state.selected) return;
  const code = state.selected;
  const res = await window.api.getRealized({ code, range: state.realizedRange });

  // 请求期间用户可能已切股票
  if (code !== state.selected) return;

  state.realized = res.ok ? res.data : null;
  renderRealized();
}

function renderRealized() {
  window.StockTrades.renderRealizedRow($('realizedRow'), state.realized, {
    range: state.realizedRange,
    onRange: switchRealizedRange,
  });
  // 这一行的出现与消失会改变内容高度
  syncWindowHeight();
}

/**
 * 切换已实现盈亏的区间。
 *
 * 不重新请求：byMonth 在第一次取数时就全拿到了，本月的值本地就能算出来。
 * 但仍走一次 IPC —— 「本月」要由主进程的本地日期定，跨零点时渲染层与主进程
 * 可能算出不同的月份，交给一处决定更稳。
 */
async function switchRealizedRange(range) {
  const next = range === 'month' ? 'month' : 'all';
  if (next === state.realizedRange) return;
  state.realizedRange = next;
  await loadRealized();
}

/** 删一笔流水。删完要重读分组、重算持仓（浮动盈亏会跟着变） */
async function removeTrade(id) {
  if (!state.selected || !id) return;
  const res = await window.api.removeTrade(state.selected, id);
  if (!res.ok) {
    state.lastError = res.error || '删除失败';
    renderStatus();
    return;
  }
  await afterTradesChanged();
}

/**
 * 流水变动后的统一善后。
 *
 * 三件事都要做：重读流水分组、重拉行情（持仓成本变了，浮动盈亏跟着变）、
 * 重算已实现。漏掉第二件会让「删了一笔买入」之后成本价还是旧的。
 */
async function afterTradesChanged() {
  await Promise.all([loadGroup('trades'), loadDetail(), loadWatchlist(), loadRealized()]);
  // 设置面板开着时里面的编辑区也要跟着更新
  if (!$('settings').classList.contains('hidden')) await refreshTradeEditor();
}

/** 持仓数量：整数不带小数点，基金份额可能有小数才保留 */
function fmtShares(v) {
  if (!Number.isFinite(v)) return '--';
  const text = Number.isInteger(v) ? v.toLocaleString('zh-CN') : v.toFixed(2);
  return `${text} 股`;
}

// —— 折叠模式 ——

/**
 * 折叠条：名称 + 价格 + 涨跌幅。
 *
 * 与展开态共用 state.detail，所以不需要额外请求。染色沿用 dirClass，
 * 与展开态的大字价格保持同一套红涨绿跌。
 */
function renderCollapsedBar(detail) {
  const d = detail || state.detail;
  const q = d && d.quote;
  if (!q) {
    $('cName').textContent = state.selected ? '加载中…' : '未选择';
    $('cPrice').textContent = '--';
    $('cPrice').className = 'collapsed-price';
    $('cPct').textContent = '';
    $('cPct').className = 'collapsed-pct';
    $('cSpark').classList.add('hidden');
    return;
  }

  const cls = dirClass(q.change);
  $('cName').textContent = pickerNameFor(d);
  $('cPrice').textContent = fmtPrice(q.price);
  $('cPrice').className = `collapsed-price ${cls}`;
  // 折叠条只有一行，涨跌额与涨跌幅并排会挤掉名称，这里只留涨跌幅
  $('cPct').textContent = fmtPct(q.changePct);
  $('cPct').className = `collapsed-pct ${cls}`;
  renderCollapsedSpark(d, cls);
  // 完整信息进 tooltip，悬停仍能看到开高低与涨跌额
  $('collapsedBar').title =
    `${pickerNameFor(d)} ${q.code || d.digits || ''}\n` +
    `价 ${fmtPrice(q.price)}  ${fmtSigned(q.change)} ${fmtPct(q.changePct)}\n` +
    `开 ${fmtPrice(q.open)}  昨 ${fmtPrice(q.prevClose)}  高 ${fmtPrice(q.high)}  低 ${fmtPrice(q.low)}` +
    `${d.phaseLabel ? `\n${d.phaseLabel}${d.quoteTimeText ? ' ' + d.quoteTimeText : ''}` : ''}`;
}

/** dirClass 的类名 → 缩略图线色，保证与旁边的价格数字同色 */
const SPARK_COLOR = {
  up: () => window.StockChart.COLOR.up,
  down: () => window.StockChart.COLOR.down,
  flat: () => window.StockChart.COLOR.flat,
};

/**
 * 折叠条右侧的分时缩略图。
 *
 * 数据取 state.detail.minute——它随 getDetail 一起返回，折叠态本来就在轮询，
 * 所以这里不发新请求，也不受当前是分时还是 K 线视图影响。
 *
 * 必须先去掉 .hidden 再画：display:none 下 clientWidth 为 0，
 * drawSparkline 会按后备尺寸去配 DPR 缓冲，等真显示出来线是错位的。
 */
function renderCollapsedSpark(detail, cls) {
  const canvas = $('cSpark');
  const minute = detail && detail.minute;
  const hasPoints = minute && Array.isArray(minute.points) && minute.points.length > 0;

  if (!hasPoints) {
    canvas.classList.add('hidden');
    return;
  }

  canvas.classList.remove('hidden');
  const color = (SPARK_COLOR[cls] || SPARK_COLOR.flat)();
  const drawn = window.StockChart.drawSparkline(canvas, minute, { color });
  // 有点位但画不出来（价格全是 null）：藏掉，别留一块空画布
  if (!drawn) canvas.classList.add('hidden');
}

/**
 * 应用窗口模式到 DOM。
 *
 * 只改显示，不动窗口尺寸——尺寸是主进程的事。切到非展开态时顺手关掉设置面板
 * 与下拉：40px 的折叠条上它们只露出一角且点不到关闭按钮，列表模式下下拉面板
 * 也会超出窗口边界被裁掉。
 *
 * @param {string} next 'expanded' | 'list' | 'collapsed'
 */
function applyMode(next) {
  const want = ['expanded', 'list', 'collapsed'].includes(next) ? next : 'expanded';
  state.mode = want;

  const card = document.querySelector('.card');
  card.classList.toggle('is-collapsed', want === 'collapsed');
  card.classList.toggle('is-list', want === 'list');
  $('collapsedBar').classList.toggle('hidden', want !== 'collapsed');
  $('listView').classList.toggle('hidden', want !== 'list');
  // 列表模式要留着 head：它是拖拽区，也放着模式切换与设置按钮。
  // 只有折叠态用自己那条 collapsedBar 取代它
  $('head').classList.toggle('hidden', want === 'collapsed');

  if (want !== 'expanded') {
    closeWatchPanel();
    closeSettings();
    // 图表不可见时留着悬停状态，会在切回展开后画出一条幽灵十字线
    state.hoverIndex = null;
    state.hover5d = null;
  }

  if (want === 'collapsed') {
    renderCollapsedBar();
  } else if (want === 'list') {
    renderListView();
  } else {
    // 展开后画布尺寸从 0 变回正常，必须重画——Canvas 不会自适应，
    // 而非展开期间的 resize 事件拿到的是隐藏状态下的宽度
    renderChart();
    // 非展开期间跳过的加载在这里补上，否则切回来要等下一轮轮询才有内容。
    // 不 await：让 DOM 先切过去，数据到了各自重画
    if (state.selected) {
      if (!state.news) loadNews();
      if (state.view === 'day5') loadMinute5d();
      else if (isKlineView(state.view)) loadKline();
    }
    // 非展开期间 syncWindowHeight 是跳过的，切回来后按当前内容重新定高
    syncWindowHeight();
  }
  // 从展开态走开时不必 syncWindowHeight —— 那两个模式的高度由主进程直接算
}

/** 按 expanded → list → collapsed 轮换。以主进程返回值为准，避免两边状态不同步 */
async function cycleMode() {
  const res = await window.api.cycleMode(state.watchlist.length);
  if (res.ok) applyMode(res.data.mode);
}

/** 切到指定模式 */
async function switchMode(mode) {
  const res = await window.api.setMode(mode, state.watchlist.length);
  if (res.ok) applyMode(res.data.mode);
}

/**
 * 画列表模式。
 *
 * 画完后按行数报窗口高度 —— 用行数而非量像素：行数在数据到手时就知道，
 * 不必等 DOM 布局完成，少一帧抖动。
 */
function renderListView() {
  window.StockListView.renderList($('listRows'), state.watchlist, {
    selected: state.selected,
    onPick: pickFromList,
  });
  window.StockListView.renderListSummary($('listSummary'), state.summary);

  /**
   * 只在行数变化时才报高度。
   *
   * 这个函数每轮轮询都跑（列表数据就靠它刷新），而行数只在用户加减股票时变。
   * 不判断的话盘中每 3 秒一次无用 IPC —— 主进程那边虽然也会判「高度没变就
   * 不 setBounds」，但省掉一次跨进程往返更干净。
   *
   * 用户手动拖过高度后主进程会直接忽略这个调用（见 set-list-height），
   * 所以这里不必知道用户是否拖过 —— 那个状态的真相在主进程。
   */
  const n = state.watchlist.length;
  if (n !== lastReportedRowCount) {
    lastReportedRowCount = n;
    window.api.setListHeight(n);
  }
}

/** 上次报给主进程的行数。-1 表示还没报过（0 是合法值：空关注列表） */
let lastReportedRowCount = -1;

/**
 * 列表模式点某行：切到展开态看该股详情。
 *
 * 这是列表模式的主要出口，也是它存在的意义。先切模式再切股票 ——
 * 反过来的话 selectStock 会在列表模式下白跑一遍「跳过重内容」的分支，
 * 切到展开后还要再补一次加载。
 */
async function pickFromList(code) {
  await switchMode('expanded');
  if (code !== state.selected) await selectStock(code);
}

// —— 渲染：走势图 ——

/**
 * 当前选中股票的持仓成本价，没设则为 null。
 *
 * 优先取 detail.position.cost（服务层 parseCost 规范化过），但它在停牌/未开盘时
 * 是 null——computePosition 现价无效就整块返回 null。成本线不依赖现价，那种时候
 * 照样该画，所以回落到 watchlist 条目上的原始 cost。
 */
function selectedCost() {
  const pos = state.detail && state.detail.position;
  if (pos && Number.isFinite(pos.cost)) return pos.cost;
  const entry = state.watchlist.find((w) => w.code === state.selected);
  const raw = entry && entry.cost;
  const n = raw == null || raw === '' ? NaN : Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** 按当前视图分派绘制。分时/5日走 chart.js，日/周 K 走 candle.js。 */
function renderChart() {
  // 只有日/周K 能拖，分时的横轴是固定时间槽——给分时也显示抓手会误导
  const canvas = $('chart');
  if (!dragBase.active) canvas.style.cursor = isKlineView(state.view) ? 'grab' : '';

  if (state.view === 'minute') renderMinuteView();
  else if (state.view === 'day5') renderMinute5dView();
  else renderKlineView();
}

function renderMinuteView() {
  const canvas = $('chart');
  const empty = $('chartEmpty');
  const hint = $('chartHint');
  const detail = state.detail;

  $('maLegend').classList.add('hidden');

  const minute = detail && detail.minute;
  const drawn = minute
    ? window.StockChart.drawMinuteChart(canvas, minute, { cost: selectedCost() })
    : false;

  empty.classList.toggle('hidden', drawn);
  if (!drawn && detail && detail.minuteError) {
    empty.textContent = `分时加载失败：${detail.minuteError}`;
  } else if (!drawn) {
    empty.textContent = detail && detail.isHoliday ? '今日休市，无分时数据' : '暂无分时数据';
  }

  // 图例：白线价格 / 黄线均价 + 最新均价值
  const pts = (minute && minute.points) || [];
  const last = pts.length > 0 ? pts[pts.length - 1] : null;
  if (last && Number.isFinite(last.avgPrice)) {
    hint.textContent = `均价 ${fmtPrice(last.avgPrice)} · ${last.time}`;
  } else {
    hint.textContent = pts.length > 0 ? `${pts.length} 点` : '';
  }
}

function renderMinute5dView() {
  const canvas = $('chart');
  const empty = $('chartEmpty');

  // 均线图例是日/周K的，5 日分时用不上
  $('maLegend').classList.add('hidden');

  const data = state.minute5d;
  const drawn = data
    ? window.StockChart.drawMinute5dChart(canvas, data, {
        hover: state.hover5d,
        cost: selectedCost(),
      })
    : false;

  empty.classList.toggle('hidden', drawn);
  if (!drawn) {
    clearCanvas(canvas);
    empty.textContent = state.minute5dError
      ? `5 日分时加载失败：${state.minute5dError}`
      : state.minute5dLoading
        ? '加载中…'
        : '暂无 5 日分时数据';
  }

  // 画不出来时提示行也要清掉：否则画布写着「暂无数据」、顶部却还挂着
  // 「价 --」，两处自相矛盾（全部价格为 NaN 时会走到这里）
  renderMinute5dHint(drawn ? data : null);
}

/** 5 日分时提示行：悬停时显示该分钟的价/均价/涨跌幅，否则显示最新点 */
function renderMinute5dHint(data) {
  const hint = $('chartHint');
  clearNode(hint);
  if (!data || !Array.isArray(data.days) || data.days.length === 0) {
    hint.textContent = '';
    return;
  }

  const days = data.days;
  const hover = state.hover5d;
  const dayIdx = hover && days[hover.dayIdx] ? hover.dayIdx : days.length - 1;
  const day = days[dayIdx];
  const points = day.points || [];
  const point = hover && points[hover.pointIdx] ? points[hover.pointIdx] : points[points.length - 1];
  if (!point) {
    hint.textContent = '';
    return;
  }

  const date = document.createElement('span');
  date.textContent = `${String(day.date || '').slice(5)} ${point.time}`;
  hint.appendChild(date);

  const price = document.createElement('span');
  price.textContent = `价 ${fmtPrice(point.price)}`;
  hint.appendChild(price);

  if (Number.isFinite(point.avgPrice)) {
    const avg = document.createElement('span');
    avg.style.color = window.StockChart.COLOR.avg;
    avg.textContent = `均 ${fmtPrice(point.avgPrice)}`;
    hint.appendChild(avg);
  }

  // 涨跌幅按**当日**昨收算，与各家行情软件一致
  const prevClose = Number(day.prevClose);
  if (Number.isFinite(prevClose) && prevClose !== 0) {
    const pct = ((point.price - prevClose) / prevClose) * 100;
    const chg = document.createElement('span');
    chg.className = dirClass(pct);
    chg.textContent = fmtPct(pct);
    hint.appendChild(chg);
  }
}

function renderKlineView() {
  const canvas = $('chart');
  const empty = $('chartEmpty');
  const legend = $('maLegend');

  const data = state.kline;
  const drawn = data
    ? window.StockCandle.drawCandleChart(canvas, data, {
        hoverIndex: state.hoverIndex,
        cost: selectedCost(),
      })
    : false;

  empty.classList.toggle('hidden', drawn);
  if (!drawn) {
    // 画不出来时清掉画布，否则会残留上一个视图的图形
    clearCanvas(canvas);
    empty.textContent = state.klineError
      ? `K 线加载失败：${state.klineError}`
      : state.klineLoading
        ? '加载中…'
        : '暂无 K 线数据';
  }

  legend.classList.toggle('hidden', !drawn);
  if (drawn) renderMaLegend(legend, data);
  // 提示行必须跟着 drawn 走：画不出来时画布已显示「暂无数据」，
  // 若这里照旧渲染，顶部会留下一行「开-- 高-- 低-- 收--」与之矛盾
  renderKlineHint(drawn ? data : null);
}

/** 均线图例：悬停时显示该根的均线值，否则显示最新一根 */
function renderMaLegend(legend, data) {
  clearNode(legend);
  const bar = pickHoverBar(data);
  if (!bar) return;

  for (const style of window.StockCandle.MA_STYLE) {
    const span = document.createElement('span');
    span.style.color = style.color;
    const v = bar[style.key];
    const b = document.createElement('b');
    b.textContent = Number.isFinite(v) ? fmtPrice(v) : '--';
    span.textContent = `${style.label} `;
    span.appendChild(b);
    legend.appendChild(span);
  }
}

/**
 * 当前可见窗口内的那一段根。
 *
 * 必须带上 visibleCount：平移到历史后，窗口右侧还留着未显示的根（那是为拖拽预取的
 * 余量），只按 visibleFrom 切到末尾的话，「最新一根」会取到屏幕外的根——提示行显示
 * 的日期与图上最右那根对不上。与 drawCandleChart 的切法保持一致。
 */
function visibleBars(data) {
  if (!data || !Array.isArray(data.bars) || data.bars.length === 0) return [];
  const from = Math.max(0, Math.min(data.bars.length, data.visibleFrom || 0));
  const raw = Math.round(Number(data.visibleCount));
  const count = Number.isFinite(raw) && raw > 0 ? raw : data.bars.length - from;
  return data.bars.slice(from, from + count);
}

/** 取当前要在图例/提示里展示的那根：悬停优先，否则最新（= 图上最右那根） */
function pickHoverBar(data) {
  const visible = visibleBars(data);
  if (visible.length === 0) return null;
  if (Number.isInteger(state.hoverIndex) && state.hoverIndex >= 0 && state.hoverIndex < visible.length) {
    return visible[state.hoverIndex];
  }
  return visible[visible.length - 1];
}

/** 顶部提示行：悬停时显示该根 OHLC 与涨跌幅，否则显示根数与区间 */
function renderKlineHint(data) {
  const hint = $('chartHint');
  clearNode(hint);

  const bar = pickHoverBar(data);
  if (!bar) {
    hint.textContent = '';
    return;
  }

  const visible = visibleBars(data);
  const idx = visible.indexOf(bar);
  // 涨跌幅要跟**前一根**比：前一根不在可见区时用 baseClose 兜底
  const prev = idx > 0 ? visible[idx - 1] : null;
  const prevClose = prev ? prev.close : data.baseClose;
  const pct = Number.isFinite(prevClose) && prevClose !== 0
    ? ((bar.close - prevClose) / prevClose) * 100
    : null;

  const date = document.createElement('span');
  // 60 分钟 K 的 date 带 ' HH:MM'，整段留着（去掉年份）；日/周 K 只有日期
  date.textContent = bar.date.slice(5);
  hint.appendChild(date);

  const ohlc = document.createElement('span');
  ohlc.textContent = `开${fmtPrice(bar.open)} 高${fmtPrice(bar.high)} 低${fmtPrice(bar.low)} 收${fmtPrice(bar.close)}`;
  hint.appendChild(ohlc);

  if (pct != null) {
    const chg = document.createElement('span');
    chg.className = dirClass(pct);
    chg.textContent = fmtPct(pct);
    hint.appendChild(chg);
  }

  if (bar.dividend && bar.dividend.content) {
    const div = document.createElement('span');
    div.className = 'ma-legend';
    div.style.padding = '0';
    div.textContent = `除权 ${bar.dividend.content}`;
    hint.appendChild(div);
  }
}

/** 清空画布：切视图时避免旧图残留 */
function clearCanvas(canvas) {
  const ctx = canvas.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
}

// —— 渲染：资讯（新闻 + 公告 + 研报，合并成一条时间线）——

/**
 * 归并新闻/公告与研报为一条按时间倒序的列表。
 *
 * 研报只有发布日期、没有具体时间（接口不给），排序时按当天 00:00 处理——
 * 这样它落在同一天新闻/公告之后，而不会因为「没有时间」被误排到当天最前。
 */
function buildFeedItems() {
  const items = [];
  for (const it of (state.news && state.news.items) || []) items.push(it);
  for (const it of (state.reports && state.reports.items) || []) {
    items.push({ ...it, feedType: 'report', datetime: `${it.date} 00:00`, time: '' });
  }
  items.sort((a, b) => (a.datetime < b.datetime ? 1 : a.datetime > b.datetime ? -1 : 0));
  return items;
}

/** 当前筛选（全部/新闻/研报）下，这一条要不要显示 */
function passesFilter(item, filter) {
  if (filter === 'news') return item.feedType !== 'report';
  if (filter === 'reports') return item.feedType === 'report';
  return true;
}

function renderFeed() {
  const list = $('feedList');
  const count = $('newsCount');
  clearNode(list);

  const filter = state.filter;
  const wantNews = filter !== 'reports';
  const wantReports = filter !== 'news';

  const items = buildFeedItems().filter((it) => passesFilter(it, filter));

  // 计数：看研报时给篇数，否则沿用新闻区的今日/近期计数（研报按发布日排，没有「今日」概念）
  if (filter === 'reports') {
    const total = (state.reports && state.reports.total) || 0;
    count.textContent = total > 0 ? `共 ${total} 篇` : '';
  } else if (state.news) {
    count.textContent = state.news.todayCount > 0 ? `今日 ${state.news.todayCount} 条` : `近期 ${state.news.total} 条`;
  } else {
    count.textContent = '';
  }

  // 涉及的数据源还在加载、且手上一条可显示的都没有时，才提示「加载中」
  if (items.length === 0 && wantReports && state.reportsLoading && !state.reports) {
    list.appendChild(emptyDiv('empty', '加载中…'));
    return;
  }

  if (items.length === 0) {
    // 报错：只在当前筛选涉及的数据源都失败（且没有另一路能兜底）时才展示
    const newsErr = wantNews ? (state.news && state.news.error) : '';
    const reportsErr = wantReports ? state.reportsError : '';
    const err =
      filter === 'reports' ? reportsErr : filter === 'news' ? newsErr : [newsErr, reportsErr].filter(Boolean).join('；');
    if (err) {
      list.appendChild(emptyDiv('error-box', err));
      return;
    }

    // 基金只有公告一路数据源（新浪个股新闻页对基金只会回落成大盘快讯，
    // 见 collectNews 注释），文案要说「公告」，否则用户会以为是加载失败
    const what =
      filter === 'reports' ? '机构研报' : state.news && state.news.newsSupported === false ? '公告' : '新闻/研报';
    const todayOnly = filter !== 'reports' && state.config && state.config.todayOnly;
    list.appendChild(emptyDiv('empty', `${todayOnly ? '今日' : ''}暂无相关${what}`));
    return;
  }

  const tk = todayKey();
  let lastDate = null;
  for (const item of items) {
    // items 已按 datetime 倒序，同一天的条目本就相邻，顺序遍历即可分组，
    // 不必像之前那样先分组再遍历
    if (item.date !== lastDate) {
      lastDate = item.date;
      const head = document.createElement('div');
      head.className = `news-date${item.date === tk ? ' today' : ''}`;
      head.textContent = dateLabel(item.date, tk);
      list.appendChild(head);
    }
    list.appendChild(buildFeedRow(item));
  }
}

function emptyDiv(cls, text) {
  const div = document.createElement('div');
  div.className = cls;
  div.textContent = text;
  return div;
}

function buildFeedRow(item) {
  const row = document.createElement('div');
  row.className = 'news-item';
  const isReport = item.feedType === 'report';

  row.title = isReport
    ? `${item.date} ${item.org || ''}${item.researcher ? ` · ${item.researcher}` : ''}\n${item.title}`
    : `${item.datetime}\n${item.title}`;

  const time = document.createElement('span');
  time.className = 'news-time';
  // 研报没有具体时间，那一格留空——日期已经在分组标头里
  time.textContent = isReport ? '' : item.time || '';
  row.appendChild(time);

  const title = document.createElement('span');
  title.className = 'news-title';
  title.textContent = item.title; // 第三方内容，只用 textContent
  row.appendChild(title);

  // 标签区分来源：公告用统一色块，研报借用评级配色（正向买入/负向减持一眼可辨）
  if (item.isAnnouncement) {
    const tag = document.createElement('span');
    tag.className = 'news-tag';
    tag.textContent = '公告';
    row.appendChild(tag);
  } else if (isReport) {
    const tag = document.createElement('span');
    tag.className = `rep-rating ${window.StockGroups.ratingClass(item.rating)}`;
    tag.textContent = item.rating || '研报';
    row.appendChild(tag);
  }

  if (item.url) {
    row.addEventListener('click', () => window.api.openExternal(item.url));
  }
  return row;
}

// —— 渲染：关注列表下拉 ——

function renderWatchPanel() {
  const panel = $('watchPanel');
  clearNode(panel);

  if (state.watchlist.length === 0) {
    const div = document.createElement('div');
    div.className = 'empty';
    div.textContent = '还没有关注的股票，点 ⚙ 添加';
    panel.appendChild(div);
    return;
  }

  for (const item of state.watchlist) {
    const row = document.createElement('div');
    row.className = `watch-item${item.code === state.selected ? ' active' : ''}`;
    row.setAttribute('role', 'option');
    row.setAttribute('aria-selected', String(item.code === state.selected));

    const left = document.createElement('div');
    left.className = 'watch-item-left';
    const name = document.createElement('span');
    name.className = 'watch-item-name';
    name.textContent = item.name || item.digits;
    const code = document.createElement('span');
    code.className = 'watch-item-code';
    code.textContent = item.digits;
    left.append(name, code);
    if (item.isFund) {
      const kind = document.createElement('span');
      kind.className = 'search-item-kind';
      kind.textContent = '基金';
      left.appendChild(kind);
    }

    const right = document.createElement('div');
    right.className = 'watch-item-right';
    if (item.error) {
      const err = document.createElement('span');
      err.className = 'watch-item-pct flat';
      err.textContent = item.error;
      right.appendChild(err);
    } else {
      const price = document.createElement('div');
      price.className = `watch-item-price ${dirClass(item.change)}`;
      price.textContent = fmtPrice(item.price);
      const pct = document.createElement('div');
      pct.className = `watch-item-pct ${dirClass(item.change)}`;
      pct.textContent = fmtPct(item.changePct);
      right.append(price, pct);
    }

    // 持仓盈亏：设了成本价才显示，挂在名称下方而非右侧——
    // 右侧已被现价与当日涨跌幅占满，再挤一个百分比容易和当日涨跌看混
    if (item.position) {
      const hold = document.createElement('span');
      hold.className = `watch-item-hold ${dirClass(item.position.profitPct)}`;
      hold.textContent = `持 ${fmtPct(item.position.profitPct)}`;
      hold.title = item.position.hasAmount
        ? `成本 ${fmtPrice(item.position.cost)} × ${fmtShares(item.position.shares)}\n` +
          `盈亏 ${fmtMoney(item.position.profit, { signed: true })}　市值 ${fmtMoney(item.position.marketValue)}`
        : `成本 ${fmtPrice(item.position.cost)}　每股盈亏 ${fmtSigned(item.position.profitPerShare)}`;
      left.appendChild(hold);
    }

    row.append(left, right);
    row.addEventListener('click', () => {
      closeWatchPanel();
      if (item.code !== state.selected) selectStock(item.code);
    });
    panel.appendChild(row);
  }

  renderWatchSummary(panel);
}

/**
 * 关注列表底部的持仓汇总行。
 *
 * 只在有「成本价 + 数量」齐全的条目时出现。只填成本价的股票算不出金额，
 * summarizePositions 已排除它们——若被排除的条目存在，这里说明一下，
 * 否则用户会以为汇总漏算了。
 */
function renderWatchSummary(panel) {
  const sum = state.summary;
  if (!sum) return;

  const row = document.createElement('div');
  row.className = 'watch-summary';

  const label = document.createElement('span');
  label.className = 'watch-summary-label';
  label.textContent = `持仓合计 (${sum.counted})`;

  const right = document.createElement('span');
  right.className = 'watch-summary-right';
  const profit = document.createElement('span');
  profit.className = `watch-summary-profit ${dirClass(sum.profit)}`;
  profit.textContent = fmtMoney(sum.profit, { signed: true });
  const pct = document.createElement('span');
  pct.className = `watch-summary-pct ${dirClass(sum.profit)}`;
  pct.textContent = fmtPct(sum.profitPct);
  right.append(profit, pct);

  // 只填了成本价、没填数量的条目不计入金额汇总，说明一下避免误读
  const partial = state.watchlist.filter((w) => w.position && !w.position.hasAmount).length;
  const tips = [
    `总成本 ${fmtMoney(sum.costValue)}`,
    `总市值 ${fmtMoney(sum.marketValue)}`,
    `盈亏 ${fmtMoney(sum.profit, { signed: true })} (${fmtPct(sum.profitPct)})`,
  ];
  if (sum.todayProfit != null) tips.push(`当日盈亏 ${fmtMoney(sum.todayProfit, { signed: true })}`);
  if (partial > 0) tips.push(`另有 ${partial} 只只填了成本价，未计入金额`);
  row.title = tips.join('\n');

  row.append(label, right);
  panel.appendChild(row);
}

// —— 渲染：状态条 ——

function renderStatus() {
  const phase = $('phase');
  const msg = $('statusMsg');
  const updated = $('updated');

  const d = state.detail;
  if (d) {
    phase.textContent = d.phaseLabel || '';
    phase.className = `phase${d.phase === 'trading' ? ' live' : ''}`;
    updated.textContent = d.quoteTimeText || '';
  } else {
    phase.textContent = '';
    phase.className = 'phase';
    updated.textContent = '';
  }

  const warning = state.news && state.news.warning;
  msg.textContent = state.lastError || warning || '';
}

// —— 数据加载 ——

async function loadConfig() {
  const res = await window.api.getConfig();
  if (res.ok) {
    state.config = res.data;
    state.selected = res.data.selected || '';
    syncTodayOnlyChip();
    // 上次退出时的模式要恢复。主进程已按它开好窗口尺寸，这里只补 DOM；
    // 仅在不一致时才调，避免每轮 refreshAll 都白跑一遍 applyMode
    if (res.data.mode !== state.mode) applyMode(res.data.mode);
    restoreGroups(res.data.sections);
  }
  return state.config;
}

// —— 可折叠分组（技术指标 / 资金流向）——

/** 分组 key → 取数函数与渲染函数的映射，避免两处写重复的 if/else */
const GROUP_SPECS = {
  indicators: {
    fetch: (code) => window.api.getIndicators(code, {}),
    render: (g) => {
      window.StockGroups.renderIndicators($('indicatorGrid'), g.data, { error: g.error, loading: g.loading });
      drawIndicatorCharts();
    },
    hint: (g) => (g.error ? '' : window.StockGroups.indicatorHint(g.data)),
    hintEl: 'indicatorHint',
    bodyEl: 'indicatorBody',
    sectionEl: 'indicatorGroup',
    failMsg: '指标加载失败',
  },
  flow: {
    fetch: (code) => window.api.getFlow(code, { days: FLOW_DAYS }),
    render: (g) =>
      window.StockGroups.renderFlow($('flowGrid'), $('flowBars'), g.data, { error: g.error, loading: g.loading }),
    hint: (g) => (g.error ? '' : window.StockGroups.flowHint(g.data)),
    hintEl: 'flowHint',
    bodyEl: 'flowBody',
    sectionEl: 'flowGroup',
    failMsg: '资金流加载失败',
  },
  margin: {
    fetch: (code) => window.api.getMargin(code, { days: FLOW_DAYS }),
    render: (g) =>
      window.StockGroups.renderMargin($('marginGrid'), $('marginBars'), g.data, {
        error: g.error,
        loading: g.loading,
      }),
    hint: (g) => (g.error ? '' : window.StockGroups.marginHint(g.data)),
    hintEl: 'marginHint',
    bodyEl: 'marginBody',
    sectionEl: 'marginGroup',
    failMsg: '两融加载失败',
  },
  finance: {
    fetch: (code) => window.api.getFinance(code, { periods: FINANCE_PERIODS }),
    render: (g) =>
      window.StockGroups.renderFinance($('financeGrid'), g.data, { error: g.error, loading: g.loading }),
    hint: (g) => (g.error ? '' : window.StockGroups.financeHint(g.data)),
    hintEl: 'financeHint',
    bodyEl: 'financeBody',
    sectionEl: 'financeGroup',
    failMsg: '财务加载失败',
  },
  lhb: {
    fetch: (code) => window.api.getLhb(code, { limit: LHB_LIMIT }),
    render: (g) => window.StockGroups.renderLhb($('lhbList'), g.data, { error: g.error, loading: g.loading }),
    hint: (g) => (g.error ? '' : window.StockGroups.lhbHint(g.data)),
    hintEl: 'lhbHint',
    bodyEl: 'lhbBody',
    sectionEl: 'lhbGroup',
    failMsg: '龙虎榜加载失败',
  },
  /**
   * 交易记录。与上面几个分组走同一套表驱动，但数据源是本地文件而非行情接口 ——
   * 所以它不参与 refreshAll 的强制重拉（流水不会自己变），
   * 只在切股票与增删流水后重新读。
   */
  trades: {
    fetch: (code) => window.api.getTrades(code),
    render: (g) =>
      window.StockTrades.renderTradeList($('tradeList'), g.data && g.data.summary && g.data.summary.lots, {
        oversold: !!(g.data && g.data.summary && g.data.summary.oversold),
        onRemove: (id) => removeTrade(id),
      }),
    hint: (g) => (g.error ? '' : window.StockTrades.tradeHint(g.data && g.data.summary)),
    hintEl: 'tradeHint',
    bodyEl: 'tradeBody',
    sectionEl: 'tradeGroup',
    failMsg: '流水读取失败',
  },
};

/** 资金流与两融各看几天。5 天够看趋势，迷你柱也画得下 */
const FLOW_DAYS = 5;

/** 财务看几期。4 期 = 最近一年四个季度 */
const FINANCE_PERIODS = 4;

/** 龙虎榜取几条上榜记录 */
const LHB_LIMIT = 5;

/** 研报取几篇 */
const REPORT_LIMIT = 10;

/**
 * 画指标子图。
 *
 * canvas 必须已在文档里且可见（display 不为 none）才有 clientWidth，
 * 所以这里只能在 renderIndicators 插完 DOM 之后、且分组处于展开态时调用。
 * 收起态下 drawIndCharts 会跳过所有画布，展开时再补画。
 */
function drawIndicatorCharts() {
  const g = state.groups.indicators;
  if (!g.open || !g.data) return;
  window.StockGroups.drawIndCharts($('indicatorGrid'), g.data.series);
}

/** 从配置恢复展开态。已展开的要补一次取数，否则展开着却是空的 */
function restoreGroups(sections) {
  const src = sections || {};
  for (const key of Object.keys(GROUP_SPECS)) {
    const want = src[key] === true;
    if (want === state.groups[key].open) continue;
    state.groups[key].open = want;
    applyGroupOpen(key);
    if (want) loadGroup(key);
  }
  // 无论有没有变化都定一次高：启动时窗口用的是配置里记住的尺寸，
  // 若那份配置是在分组全收起时存的，恢复出展开态后就会不够高。
  // applyGroupOpen 只在状态**变化**时才被调到，指望它覆盖启动路径会漏。
  syncWindowHeight();
}

/** 只改 DOM，不碰取数与配置 —— 三件事分开才好测好改 */
function applyGroupOpen(key) {
  const spec = GROUP_SPECS[key];
  const open = state.groups[key].open;
  $(spec.sectionEl).classList.toggle('is-open', open);
  $(spec.bodyEl).classList.toggle('hidden', !open);
  const bar = $(spec.sectionEl).querySelector('.group-bar');
  if (bar) bar.setAttribute('aria-expanded', open ? 'true' : 'false');
  renderGroupHint(key);

  // 收起时 canvas 的 clientWidth 是 0，那期间的绘制全被跳过；
  // 展开这一刻才是第一次能拿到真实宽度，必须补画一次
  if (key === 'indicators' && open) drawIndicatorCharts();

  // 开合改变了内容高度，窗口跟着调（防抖，连续开合只调一次）
  syncWindowHeight();
}

/** 摘要文字：收起时也能看到最关键的一个数，省得为看一个数字反复展开 */
function renderGroupHint(key) {
  const spec = GROUP_SPECS[key];
  const g = state.groups[key];
  $(spec.hintEl).textContent = g.loading ? '…' : spec.hint(g);
}

/**
 * 展开/收起。展开时若还没有数据就顺手拉一次（懒加载：不展开就不发请求）。
 * 状态写回配置，下次启动恢复。
 */
async function toggleGroup(key) {
  const g = state.groups[key];
  g.open = !g.open;
  applyGroupOpen(key);

  if (g.open && !g.data && !g.loading) loadGroup(key);

  // 只提交变化的那一个键，避免把另一个分组的旧值覆盖回去
  const sections = { ...(state.config && state.config.sections), [key]: g.open };
  const res = await window.api.patchConfig({ sections });
  if (res && res.ok) state.config = res.data;
}

/** 拉一个分组的数据。失败只写自己的 error，不打扰其它分组与状态栏 */
async function loadGroup(key) {
  if (!state.selected) return;
  const spec = GROUP_SPECS[key];
  const g = state.groups[key];
  const code = state.selected;

  g.loading = true;
  g.error = '';
  spec.render(g);
  renderGroupHint(key);

  let res;
  try {
    res = await spec.fetch(code);
  } catch (err) {
    res = { ok: false, error: err && err.message };
  }

  // 请求回来时用户可能已经切了股票，这份数据就不是想要的了
  if (code !== state.selected) return;

  g.loading = false;
  if (res && res.ok) {
    g.data = res.data;
    g.error = '';
  } else {
    g.data = null;
    g.error = (res && res.error) || spec.failMsg;
  }
  spec.render(g);
  renderGroupHint(key);
  // 数据到达后内容才有真实高度（「加载中…」只有一行），此刻再调一次
  if (g.open) syncWindowHeight();
}

/** 切股票后重画：已展开的重新取数，收起的清掉旧数据等下次展开 */
function resetGroups() {
  for (const key of Object.keys(GROUP_SPECS)) {
    const g = state.groups[key];
    g.data = null;
    g.error = '';
    g.loading = false;
    if (g.open) loadGroup(key);
    else {
      GROUP_SPECS[key].render(g);
      renderGroupHint(key);
    }
  }
  // 切股票会让展开分组的内容高度变（龙虎榜「从未上榜」↔ 5 条记录差 294px），
  // 窗口跟着调
  syncWindowHeight();
}

// —— 窗口高度自适应 ——

/**
 * 新闻区按多高计入所需高度。
 *
 * 不能按它的内容算：30 条新闻能有上千像素，按内容算窗口会顶到屏幕高度。
 * 这个值与 src/windowLayout.js 的 NEWS_TARGET_H 是同一个约定（那边做算术，
 * 这边做测量），改一处要同步另一处。
 */
const NEWS_TARGET_H = 145;

/**
 * 量出「内容全部铺开需要多高」。
 *
 * 逐个累加 .card 可见子元素的 scrollHeight 而非 offsetHeight：后者是
 * flex 压缩**之后**的实际高度，此刻新闻区可能已经被挤成 0，拿它去算
 * 会得出「现在刚好够」的结论，窗口永远不会长高。
 *
 * @returns {number} 所需像素高度；量不出来时返回 0（调用方据此跳过）
 */
function measureNeededHeight() {
  const card = document.querySelector('.card');
  if (!card) return 0;

  let sum = 0;
  for (const el of card.children) {
    // 设置面板是绝对定位的浮层，不占布局高度
    if (el.classList.contains('settings')) continue;
    if (el.classList.contains('hidden')) continue;
    if (getComputedStyle(el).display === 'none') continue;

    if (el.id === 'scrollArea') {
      // 滚动区自身高度是被压缩后的值，要按它内部各块的需要累加
      for (const child of el.children) {
        if (child.classList.contains('hidden')) continue;
        if (getComputedStyle(child).display === 'none') continue;
        sum += child.classList.contains('news-box') ? NEWS_TARGET_H : child.scrollHeight;
      }
      continue;
    }
    sum += el.scrollHeight;
  }
  // 卡片上下边框各 1px
  return sum + 2;
}

/** 防抖计时器。展开一个分组会连着触发 applyGroupOpen 与随后的 loadGroup 渲染 */
let heightTimer = null;

/**
 * 把当前内容所需高度报给主进程，由它决定窗口高度。
 *
 * 防抖 80ms：展开分组时 DOM 先变（applyGroupOpen），数据回来后内容再变一次
 * （loadGroup → render），两次都该触发但只需调整一次窗口。
 *
 * 只在展开态生效：折叠态高度固定 40px、列表态按行数算，两者都由主进程的
 * setMode / set-list-height 掌管，这里插一脚会把它们撑开。
 * measureNeededHeight 也只对展开态的 DOM 有意义 —— 那两个模式的高度是
 * 算出来的，不是量出来的。
 */
function syncWindowHeight() {
  clearTimeout(heightTimer);
  heightTimer = setTimeout(() => {
    if (state.mode !== 'expanded') return;
    const needed = measureNeededHeight();
    if (needed > 0) window.api.setAutoHeight(needed);
  }, 80);
}

async function loadWatchlist() {
  const res = await window.api.getWatchlist();
  if (res.ok) {
    state.watchlist = res.data.items || [];
    state.summary = res.data.summary || null;
    if (res.data.error) state.lastError = res.data.error;
    // 选中项失效时回落到首个
    if (state.watchlist.length > 0 && !state.watchlist.some((w) => w.code === state.selected)) {
      state.selected = state.watchlist[0].code;
    }
  } else if (res.needConfig) {
    state.watchlist = [];
    state.summary = null;
  } else {
    state.lastError = res.error || '';
  }
  renderWatchPanel();
  // 列表模式就靠这一路数据，每轮轮询都要跟着重画。
  // 关注列表长度变了（设置里加减股票）时 renderListView 会顺手报新的高度
  if (state.mode === 'list') renderListView();
}

async function loadDetail() {
  if (!state.selected) return;
  const res = await window.api.getDetail(state.selected);
  if (res.ok) {
    state.detail = res.data;
    state.lastError = '';
    renderQuote(res.data);
    // 折叠条与展开态共用这份数据，两边都要跟着更新。
    // 列表模式不用：它的数据来自 loadWatchlist 那一路
    if (state.mode === 'collapsed') renderCollapsedBar(res.data);
    // 分时视图下才由行情轮询驱动重画；K 线视图有自己的加载节奏。
    // 详情不可见时画布也不可见，重画纯属浪费
    if (state.view === 'minute' && detailVisible()) renderChart();
  } else {
    state.lastError = res.error || '行情加载失败';
  }
  renderStatus();
}

async function loadNews() {
  if (!state.selected) return;
  const res = await window.api.getNews(state.selected);
  if (res.ok) {
    state.news = res.data;
  } else {
    state.news = null;
    state.lastError = res.error || '新闻加载失败';
  }
  renderFeed();
  renderStatus();
}

/**
 * 拉研报。
 *
 * 新闻与研报合并显示后不再懒加载——默认筛选「全部」就要看到研报，
 * 所以随 selectStock/refreshAll 与新闻一起取，不等用户切到研报筛选才发请求。
 *
 * 不跟着新闻的定时器刷新 —— 研报是天级更新，3 分钟重拉一次纯属浪费。
 */
async function loadReports(opts = {}) {
  if (!state.selected) return;
  // 已有数据且非强制就不重复请求
  if (!opts.force && state.reports) return;

  const code = state.selected;
  state.reportsLoading = true;
  state.reportsError = '';
  renderFeed();

  const res = await window.api.getReports(code, { limit: REPORT_LIMIT });

  // 请求期间用户可能已切股票，这份结果就不是想要的了
  if (code !== state.selected) return;

  state.reportsLoading = false;
  if (res.ok) {
    state.reports = res.data;
    state.reportsError = '';
  } else {
    state.reports = null;
    state.reportsError = res.error || '研报加载失败';
  }
  renderFeed();
}

/**
 * 切换资讯筛选（全部 / 新闻 / 研报）。三者共用同一条合并时间线，
 * 筛选只决定显示哪些条目，不重新取数——数据本来就一起加载。
 *
 * 「只看今日」那个 chip 对研报没有意义（研报按发布日排，没有今日概念），
 * 只看研报时隐藏它，免得点了没反应。
 */
function switchFilter(filter) {
  const next = ['news', 'reports'].includes(filter) ? filter : 'all';
  state.filter = next;

  for (const btn of document.querySelectorAll('[data-filter]')) {
    const on = btn.dataset.filter === next;
    btn.classList.toggle('active', on);
    btn.setAttribute('aria-checked', on ? 'true' : 'false');
  }

  $('btnTodayOnly').classList.toggle('hidden', next === 'reports');

  renderFeed();
}

/** 画布能放多少根 K：按目标像素宽算，并给出合理上下限 */
function barCountForWidth() {
  const usable = Math.max(60, window.StockCandle.plotWidth($('chart').clientWidth));
  return Math.min(240, Math.max(20, Math.floor(usable / PX_PER_BAR)));
}

/**
 * 该周期的默认根数：按固定时间跨度，但槽宽压到看不清形态时就少看几根。
 *
 * 这里的下限用 MIN_PX_PER_BAR（1.5px）而非 barCountForWidth 的 PX_PER_BAR（5px）——
 * 后者是「一根该有多粗」的期望值，拿它当硬上限会让 340px 默认窗口只放得下 59 根，
 * 90 根的默认跨度永远达不到。1.5px 下实体宽仍有 1px，形态勉强可辨。
 */
function defaultBarCount(period) {
  const want = DEFAULT_BAR_COUNT[period];
  if (!want) return barCountForWidth();

  const usable = Math.max(60, window.StockCandle.plotWidth($('chart').clientWidth));
  const fits = Math.floor(usable / MIN_PX_PER_BAR);
  return window.StockCandle.clampBarCount(Math.min(want, fits));
}

/**
 * 当前该显示多少根：用户缩放过就用缩放值，否则用该周期的默认跨度。
 * 缩放值可能大于默认值，此时要多取数据，故用于请求根数也用它。
 */
function currentBarCount() {
  return state.zoomCount != null
    ? window.StockCandle.clampBarCount(state.zoomCount)
    : defaultBarCount(state.view);
}

/**
 * 该向服务端请求多少根。
 *
 * 可见根数之外还要带上 panOffset——窗口已经往历史挪了 N 根，就得多取 N 根，
 * 否则重拉（轮询/换缩放）后手上的数据不够填当前位置，窗口会被夹回最右。
 * 再加一屏余量，让用户能接着往左拖而不必每次都等接口。
 */
function requestBarCount() {
  const visible = currentBarCount();
  const { clampBarCount } = window.StockCandle;
  return clampBarCount(visible + state.panOffset + visible);
}

/**
 * 拉 K 线。
 * @param {{ force?: boolean }} [opts] force=true 时忽略「已有数据」直接重拉
 */
async function loadKline(opts = {}) {
  if (!isKlineView(state.view) || !state.selected) return;

  // 视图名与数据层的 period 不同名（min60 → 60min），一律经 VIEW_PERIOD 换算，
  // 直接拿 state.view 与 kline.period 比会让 60 分钟视图每次都判定为「数据已过期」
  const period = VIEW_PERIOD[state.view] || state.view;
  const view = state.view;

  // 已有当前周期的数据且非强制，就不重复请求（切回标签时秒出图）
  if (!opts.force && state.kline && state.kline.period === period) return;

  const code = state.selected;
  state.klineLoading = true;
  state.klineError = '';
  if (!state.kline || state.kline.period !== period) renderChart();

  const res = await window.api.getKline(code, { period, count: requestBarCount() });

  // 请求期间用户可能已切走：结果过期就丢弃，避免把周K画到日K标签下
  if (state.view !== view || state.selected !== code) return;

  state.klineLoading = false;
  if (res.ok) {
    state.kline = res.data;
    state.klineError = '';
    // 服务端按 requestBarCount 给的窗口（贴最右、含历史余量）与用户当前的缩放
    // 级别和平移位置都不一致，重新按两者定位一次
    applyWindow();
  } else {
    state.kline = null;
    state.klineError = res.error || '未知错误';
  }
  renderChart();
}

/**
 * 按当前的缩放级别 + 平移位置重新定位可见窗口。
 *
 * 拉到新数据后必须走一次：服务端总是返回「贴最右的一段」，而用户可能既缩放过
 * 也拖动过。缩放先定根数，平移再定起点，顺序不能反——起点要夹在
 * [0, total-count] 内，count 未定就没法夹。
 */
function applyWindow() {
  const data = state.kline;
  if (!data || !Array.isArray(data.bars) || data.bars.length === 0) return;

  // 先存一份：applyZoom 会按「锚定最右」改写 panOffset，那是缩放场景下的正确行为，
  // 但这里要恢复的是用户拖到的位置，得拿改写前的值
  const wantPan = state.panOffset;
  // 未缩放时也要收窄：requestBarCount 为了给拖拽留余量，请求的根数比该显示的多，
  // 服务端按那个数给窗口，不收窄的话默认跨度会被撑成「一屏 + 余量」那么宽
  const zoomed = state.zoomCount != null;
  applyZoom(zoomed ? state.zoomCount : defaultBarCount(state.view), null);
  // applyZoom 会把实际根数写进 zoomCount。默认路径下得擦掉，否则「未缩放」状态
  // 就丢了——resize 后不再按新画布宽重算，切走再切回也会沿用这个数
  if (!zoomed) state.zoomCount = null;

  if (wantPan > 0) {
    state.panOffset = wantPan;
    applyPan();
  }
}

/**
 * 把缩放应用到当前 K 线数据上，就地改 visibleFrom / visibleCount。
 *
 * @param {number} newCount 目标可见根数
 * @param {number|null} anchorRatio 光标在可见区内的比例 0..1；null 表示锚定最右
 * @returns {boolean} 可见窗口是否真的变了（没变就不必重画）
 */
function applyZoom(newCount, anchorRatio) {
  const data = state.kline;
  if (!data || !Array.isArray(data.bars) || data.bars.length === 0) return false;

  const { rezoomWindow, clampBarCount } = window.StockCandle;
  const oldFrom = data.visibleFrom || 0;
  const oldCount = data.visibleCount || data.bars.length - oldFrom;

  const next = rezoomWindow({
    total: data.bars.length,
    oldFrom,
    oldCount,
    newCount: clampBarCount(newCount),
    anchorRatio,
  });

  state.zoomCount = next.visibleCount;
  // 缩放锚定光标时起点会变，panOffset 得跟着改写，否则下次重拉数据会按旧的
  // 偏移把窗口挪回缩放前的位置
  state.panOffset = Math.max(0, data.bars.length - next.visibleCount - next.visibleFrom);

  if (next.visibleFrom === oldFrom && next.visibleCount === oldCount) return false;

  commitWindow(next.visibleFrom, next.visibleCount);
  return true;
}

/**
 * 手上有多少根**可显示**的数据。
 *
 * bars 的头部是均线预热段（服务端多取 max(MA周期) 根），那几根算不出 MA20，
 * 不该当成可平移/可缩放的余量。maPeriods 由服务端一并返回，据它推预热根数，
 * 免得两边各写一个常量。
 */
function availableBars(data) {
  const total = (data && Array.isArray(data.bars) ? data.bars.length : 0) || 0;
  const periods = (data && data.maPeriods) || [];
  const warmup = periods.length > 0 ? Math.max(...periods) : 0;
  return Math.max(0, total - warmup);
}

/** 就地写入可见窗口，并同步涨跌幅基准 */
function commitWindow(visibleFrom, visibleCount) {
  const data = state.kline;
  data.visibleFrom = visibleFrom;
  data.visibleCount = visibleCount;
  // 首根的前一根变了，涨跌幅基准要跟着更新（提示行按它算首根涨跌）
  data.baseClose = visibleFrom > 0 ? data.bars[visibleFrom - 1].close : data.prevClose;
}

/**
 * 把 state.panOffset 应用到当前数据上：窗口右端距最新一根 panOffset 根。
 *
 * panOffset 是「距最右的根数」而非绝对起点下标，因为轮询会往 bars 末尾追加新根，
 * 用绝对下标存的话每来一根新数据、用户看的位置就会往左漂一根。
 *
 * @returns {boolean} 可见窗口是否真的变了
 */
function applyPan() {
  const data = state.kline;
  if (!data || !Array.isArray(data.bars) || data.bars.length === 0) return false;

  const total = data.bars.length;
  const oldFrom = data.visibleFrom || 0;
  const count = data.visibleCount || total - oldFrom;
  const maxFrom = Math.max(0, total - count);
  // 与 handleDragPan 用同一个下界，否则重拉后恢复位置会越进预热段
  const minFrom = Math.min(maxFrom, total - availableBars(data));

  // 手上的历史不够挪这么多时，夹到最左；panOffset 跟着回写，
  // 否则它会一直大于实际可达的位移，后续每次拖动都在「已到左端」上空转
  const target = Math.max(minFrom, maxFrom - state.panOffset);
  state.panOffset = maxFrom - target;

  if (target === oldFrom) return false;
  commitWindow(target, count);
  return true;
}

/**
 * 滚轮缩放。日/周K 专用——分时与 5 日的横轴是固定时间槽，缩放没有意义。
 *
 * 数据不够时会重新拉：放大到超出已取根数才需要，本地够切就不打接口。
 */
async function handleWheelZoom(e) {
  if (!isKlineView(state.view) || !state.kline) return;

  const canvas = $('chart');
  const { LAYOUT, plotWidth, zoomBarCount, clampBarCount } = window.StockCandle;
  const data = state.kline;
  const oldCount = data.visibleCount || data.bars.length - (data.visibleFrom || 0);

  const target = zoomBarCount(oldCount, e.deltaY);
  if (target === clampBarCount(oldCount)) return; // 已到上下限，不做无用重画

  // 光标锚点：落在绘图区内才锚定，否则锚最右
  const rect = canvas.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const plotW = plotWidth(canvas.clientWidth);
  const inPlot = x >= LAYOUT.padL && x <= LAYOUT.padL + plotW;
  const anchorRatio = inPlot ? (x - LAYOUT.padL) / plotW : null;

  const changed = applyZoom(target, anchorRatio);

  // 缩小到比已有数据更多的根数时，本地没有那么多根可切——补拉一次。
  // 判据用总根数而非「visibleFrom 到末尾」：平移后窗口右侧还留着未显示的根，
  // 按后者算会把那段也当成可用余量，该补拉时不补，缩放就卡住不动了
  const needMore = target > availableBars(data) && target > oldCount;
  if (needMore) {
    await loadKline({ force: true });
    return;
  }

  if (changed) {
    // 缩放后可见根数变了，原 hoverIndex 指向的已是别的根——按光标重新定位
    state.hoverIndex = inPlot
      ? window.StockCandle.barIndexAtX(x, LAYOUT.padL, plotW, data.visibleCount)
      : null;
    if (state.hoverIndex < 0) state.hoverIndex = null;
    renderChart();
  }
}

/**
 * 拖拽平移一步。日/周K 专用。
 *
 * @param {number} dx 本次拖拽相对**起点**的累计像素位移（右为正）
 * @returns {{ changed: boolean, atLeft: boolean }} atLeft=true 表示已顶到手上数据的最左端
 */
function handleDragPan(dx) {
  const data = state.kline;
  if (!isKlineView(state.view) || !data || !Array.isArray(data.bars)) {
    return { changed: false, atLeft: false };
  }

  const canvas = $('chart');
  const { plotWidth, dragBarShift, panWindow } = window.StockCandle;
  const plotW = plotWidth(canvas.clientWidth);
  const count = data.visibleCount || data.bars.length - (data.visibleFrom || 0);

  const shift = dragBarShift(dx, plotW, count);
  if (shift === 0) return { changed: false, atLeft: false };

  // 往右拖 = 把图往右拽 = 露出更早的数据 = 起点变小，故取负。
  // minFrom 挡住预热段：那几根没有 MA20，拖进去均线会突然断掉
  const next = panWindow({
    total: data.bars.length,
    from: dragBase.from,
    count,
    shift: -shift,
    minFrom: data.bars.length - availableBars(data),
  });

  const changed = next.visibleFrom !== (data.visibleFrom || 0);
  if (changed) {
    commitWindow(next.visibleFrom, next.visibleCount);
    state.panOffset = Math.max(0, data.bars.length - next.visibleCount - next.visibleFrom);
  }
  return { changed, atLeft: next.atLeft };
}

/** 切换走势图周期 */
async function switchView(view) {
  if (!VIEWS.includes(view) || view === state.view) return;
  state.view = view;
  state.hoverIndex = null;
  state.hover5d = null;
  state.panOffset = 0;
  // 清掉缩放，让新周期回到自己的默认跨度（见 DEFAULT_BAR_COUNT）。
  // 不清的话从周K切日K会沿用 26 根，只剩一个多月
  state.zoomCount = null;
  // 换周期后旧数据不再适用
  if (!isKlineView(view) || (state.kline && state.kline.period !== view)) state.kline = null;
  state.klineError = '';
  // 5 日数据只在该视图下有意义，切走就丢，切回时重拉
  if (view !== 'day5') {
    state.minute5d = null;
    state.minute5dError = '';
  }

  // 只动走势标签，别碰资讯区那两个（它们也是 .tab）
  for (const btn of document.querySelectorAll('[data-view]')) {
    const on = btn.dataset.view === view;
    btn.classList.toggle('active', on);
    btn.setAttribute('aria-selected', String(on));
  }

  renderChart();
  if (view === 'day5') await loadMinute5d();
  else await loadKline();
}

/**
 * 拉 5 日分时。
 * @param {{ force?: boolean }} [opts] force=true 时忽略「已有数据」直接重拉
 */
async function loadMinute5d(opts = {}) {
  if (state.view !== 'day5' || !state.selected) return;
  if (!opts.force && state.minute5d) return;

  const code = state.selected;
  state.minute5dLoading = true;
  state.minute5dError = '';
  if (!state.minute5d) renderChart();

  const res = await window.api.getMinute5d(code);

  // 请求期间用户可能已切走：结果过期就丢弃
  if (state.view !== 'day5' || state.selected !== code) return;

  state.minute5dLoading = false;
  if (res.ok) {
    state.minute5d = res.data;
    state.minute5dError = '';
  } else {
    state.minute5d = null;
    state.minute5dError = res.error || '未知错误';
  }
  renderChart();
}

/** 切换股票：立刻重画两块内容，并重置新闻定时器 */
async function selectStock(code) {
  state.selected = code;
  state.detail = null;
  state.news = null;
  state.kline = null;
  state.klineError = '';
  state.hoverIndex = null;
  state.zoomCount = null;
  state.panOffset = 0;
  state.minute5d = null;
  state.minute5dError = '';
  state.hover5d = null;
  state.reports = null;
  state.reportsError = '';
  state.reportsLoading = false;
  // 已实现盈亏是按股票的，切股票后旧值立刻作废（留着会短暂显示上一只的数字）。
  // 区间选择（本月/全部）保留 —— 那是用户的偏好，不该跟着切股票重置
  state.realized = null;
  renderRealized();
  await window.api.patchConfig({ selected: code });
  resetGroups();

  const entry = state.watchlist.find((w) => w.code === code);
  $('pickerName').textContent = (entry && (entry.alias || entry.name)) || code;
  $('pickerCode').textContent = (entry && entry.digits) || '';
  $('feedList').textContent = '';
  // 折叠条上的名称要立刻跟着换，不等行情回来——否则切股票后有一瞬间
  // 显示的是上一只的名字配新价格
  if (state.mode === 'collapsed') {
    $('cName').textContent = (entry && (entry.alias || entry.name)) || code;
    $('cPrice').textContent = '--';
    $('cPrice').className = 'collapsed-price';
    $('cPct').textContent = '';
    // 同理要清掉缩略图：留着的话新名字配的是上一只的走势，比不显示更误导
    $('cSpark').classList.add('hidden');
  }

  renderWatchPanel();
  // 列表模式要立刻挪动选中高亮，不等行情回来
  if (state.mode === 'list') renderListView();
  // 详情不可见时只需要行情数字；图与资讯等切回展开时再拉
  if (!heavyContentVisible()) await loadDetail();
  else {
    // 新闻与研报一起拉：合并显示后默认筛选就是「全部」，两路都要有数据。
    // 已实现盈亏读的是本地文件，顺带一起（不算网络请求）
    await Promise.all([loadDetail(), loadNews(), loadReports(), loadKline(), loadMinute5d(), loadRealized()]);
  }
  // 设置面板开着时切股票（点关注列表也能切），编辑区要跟着换到新股票
  if (!$('settings').classList.contains('hidden')) await refreshTradeEditor();
  scheduleNews();
}

/** 空配置态：提示去设置 */
function renderEmptyState() {
  $('pickerName').textContent = '未选择';
  $('pickerCode').textContent = '';
  if (state.mode === 'collapsed') renderCollapsedBar(null);
  // 列表模式下 renderList 自己会显示空态提示（「还没有关注的股票」）
  if (state.mode === 'list') renderListView();
  const list = $('feedList');
  clearNode(list);
  const div = document.createElement('div');
  div.className = 'empty';
  div.textContent = '还没有关注的股票\n点右上角 ⚙ 添加';
  div.style.whiteSpace = 'pre-line';
  list.appendChild(div);
  $('chartEmpty').classList.remove('hidden');
  $('chartEmpty').textContent = '';
}

// —— 轮询 ——

async function scheduleQuote() {
  clearTimeout(state.quoteTimer);
  const res = await window.api.getPollInterval();
  const ms = res.ok ? res.data.ms : 5000;

  state.quoteTimer = setTimeout(async () => {
    // 顺序执行：行情先于列表，保证选中项的数字最新
    await loadDetail();
    await loadWatchlist();
    // 折叠态只显示价格与涨跌幅、列表态只显示各股的价格与涨跌幅，
    // K 线/5日 的图两者都看不见，不必跟着轮询打接口 —— 这是列表模式最大的
    // 性能收益。切回展开时 applyMode → renderChart，需要的数据那时再补
    if (heavyContentVisible()) {
      // K 线视图下，末根是当日动态数据，跟着行情节奏一起刷新；
      // 悬停读数时不刷，避免数据在指针下被换掉
      // 拖拽中也不刷：重拉会重定位窗口，图会在手底下跳
      if (isKlineView(state.view) && state.hoverIndex == null && !dragBase.active) {
        await loadKline({ force: true });
      }
      // 5 日分时的今天那段也是动态的，同理刷新
      if (state.view === 'day5' && state.hover5d == null) await loadMinute5d({ force: true });
    }
    scheduleQuote(); // 每轮重新问间隔，跨时段自动变频
  }, ms);
}

function scheduleNews() {
  clearTimeout(state.newsTimer);
  state.newsTimer = setTimeout(async () => {
    // 折叠态与列表态都看不到新闻列表，跳过这一轮
    // （定时器仍继续，切回展开后自然接上）
    if (detailVisible()) await loadNews();
    scheduleNews();
  }, NEWS_INTERVAL_MS);
}

async function refreshAll() {
  if (state.loading) return;
  state.loading = true;
  try {
    await loadConfig();
    await loadWatchlist();
    if (!state.selected) {
      renderEmptyState();
      return;
    }
    // 详情不可见时（折叠/列表）只有行情数字有用，其余几路都省掉（手动刷新同理）
    if (!heavyContentVisible()) {
      await loadDetail();
    } else {
      await Promise.all([
        loadDetail(),
        loadNews(),
        loadKline({ force: true }),
        loadMinute5d({ force: true }),
        // 新闻与研报合并显示后两路都常驻，手动刷新时一起强制重拉
        loadReports({ force: true }),
        // 流水是本地文件、不会自己变，但手动刷新时一并重读 ——
        // 用户可能在别处（另一个实例、手改文件）动过它
        loadRealized(),
        // 收起的分组不刷 —— 懒加载的意义就在这。展开的才跟着一起更新
        ...Object.keys(GROUP_SPECS)
          .filter((k) => state.groups[k].open)
          .map((k) => loadGroup(k)),
      ]);
    }
  } finally {
    state.loading = false;
  }
}

// —— 关注列表下拉开关 ——

function openWatchPanel() {
  // 非展开态的窗口高度装不下下拉面板，会被窗口边界裁掉（DOM 画不到窗口外）：
  // 折叠态只有 40px，列表态也只有几行的高度。
  // 折叠态改由点击名称轮换（见 cycleStock）；列表态本身就是一份关注列表，
  // 再叠一个下拉面板没有意义
  if (!detailVisible()) return;
  renderWatchPanel();
  $('watchPanel').classList.remove('hidden');
  $('picker').setAttribute('aria-expanded', 'true');
}

function closeWatchPanel() {
  $('watchPanel').classList.add('hidden');
  $('picker').setAttribute('aria-expanded', 'false');
}

/**
 * 按关注列表顺序切到上一只/下一只，不弹下拉面板。
 *
 * 折叠态点名称、展开态的 ◀▶ 按钮与在 picker 上滚轮，都是同一套「按位置轮换」
 * 手感，故合并成一个函数，只有方向不同。只有一只时不动。
 */
async function stepStock(dir) {
  const list = state.watchlist;
  if (list.length < 2) return;
  const at = list.findIndex((w) => w.code === state.selected);
  const next = list[(at + dir + list.length) % list.length];
  if (next && next.code !== state.selected) await selectStock(next.code);
}

const cycleStock = () => stepStock(1);

function toggleWatchPanel() {
  if ($('watchPanel').classList.contains('hidden')) openWatchPanel();
  else closeWatchPanel();
}

// —— 设置面板 ——

/** 设置面板里的待保存关注列表（保存后才写回配置） */
let draftWatchlist = [];

async function openSettings() {
  // 非展开态的窗口装不下设置面板：折叠态只有 40px，面板铺满窗口也只露出一条缝、
  // 点不到关闭按钮；列表态同理。先切到展开再打开，比拒绝打开更符合预期
  // （右键菜单与托盘在任何模式下都能点「设置」）
  if (!detailVisible()) await switchMode('expanded');

  const cfg = state.config || {};
  draftWatchlist = (cfg.watchlist || []).map((w) => ({
    code: w.code,
    digits: w.digits,
    alias: w.alias || '',
    name: (state.watchlist.find((x) => x.code === w.code) || {}).realName || w.alias || w.digits,
    // 已存的持仓要回填到输入框，否则打开设置再保存就丢了
    cost: w.cost != null ? w.cost : null,
    shares: w.shares != null ? w.shares : null,
  }));

  $('refreshMs').value = String(cfg.refreshMs || 0);
  $('newsLimit').value = String(cfg.newsLimit || 30);
  $('opacity').value = String(cfg.opacity != null ? cfg.opacity : 1);
  $('opacityVal').textContent = `${Math.round((cfg.opacity != null ? cfg.opacity : 1) * 100)}%`;
  $('includeAnnouncements').checked = cfg.includeAnnouncements !== false;
  $('todayOnly').checked = cfg.todayOnly === true;
  $('autoHide').checked = cfg.autoHide === true;
  // 下拉读的是「配置里存的模式」。此刻窗口一定是展开的（开面板前会先切过去），
  // 所以不能用 state.mode
  $('startMode').value = cfg.mode || 'expanded';
  syncListSizeReset(cfg);
  $('searchInput').value = '';
  clearNode($('searchResults'));
  $('settingsMsg').textContent = '';

  $('alertMsg').textContent = '';
  $('tradeMsg').textContent = '';

  renderWatchEditor();
  await Promise.all([refreshTradeEditor(), refreshAlertEditor()]);
  $('settings').classList.remove('hidden');
  // 面板开着期间不要被自动隐藏卷走：用户的手在键盘上，鼠标很可能已经不在窗口里，
  // 窗口滑出屏幕会把他敲了一半的代码和成本价一起带走
  window.api.setSettingsOpen(true);
  $('searchInput').focus();
}

// —— 设置面板：交易流水编辑 ——

/**
 * 重读并重画流水编辑区（只管当前选中那只）。
 *
 * 每次都重新拉而不缓存：流水可能在别处被改（详情区的分组里也能删），
 * 而这个面板打开的频率很低，一次文件读取的成本可以忽略。
 */
async function refreshTradeEditor() {
  const box = $('tradeEditor');
  const code = state.selected;

  if (!code) {
    window.StockTrades.renderTradeEditor(box, [], {});
    $('tradeStockLabel').textContent = '（未选择股票）';
    $('holdingHint').textContent = '';
    return;
  }

  const entry = state.watchlist.find((w) => w.code === code);
  $('tradeStockLabel').textContent = `当前：${(entry && (entry.alias || entry.name)) || code}`;

  const res = await window.api.getTrades(code);
  // 请求期间用户可能在面板里切了股票
  if (code !== state.selected) return;

  const data = res.ok ? res.data : null;
  window.StockTrades.renderTradeEditor(box, data && data.trades, {
    // loadError 优先于 IPC 错误：前者说的是「文件坏了、已拒绝写入」，
    // 比一句泛泛的「读取失败」有用得多
    error: (data && data.loadError) || (res.ok ? '' : res.error),
    onRemove: (id) => removeTradeFromEditor(id),
  });

  // 有流水时手填的成本价会被忽略，把这件事说出来
  $('holdingHint').textContent = window.StockTrades.holdingSourceHint(data && data.summary);
}

/** 编辑区里删一笔。与详情区的 removeTrade 走同一条善后路径 */
async function removeTradeFromEditor(id) {
  if (!state.selected || !id) return;
  const res = await window.api.removeTrade(state.selected, id);
  if (!res.ok) {
    $('tradeMsg').textContent = `删除失败：${res.error}`;
    return;
  }
  $('tradeMsg').textContent = '';
  await afterTradesChanged();
}

/**
 * 添加一笔流水。
 *
 * 校验交给主进程（tradeStore.add → normalizeTrade）：那边是唯一的真相，
 * 在渲染层再写一遍校验规则会有两套标准，早晚不一致。这里只负责把错误显示出来。
 */
async function addTradeFromEditor() {
  if (!state.selected) {
    $('tradeMsg').textContent = '请先选择一只股票';
    return;
  }

  const trade = {
    date: $('tradeDate').value.trim(),
    side: $('tradeSide').value,
    price: $('tradePrice').value.trim(),
    shares: $('tradeShares').value.trim(),
  };

  const res = await window.api.addTrade(state.selected, trade);
  if (!res.ok) {
    $('tradeMsg').textContent = res.error;
    return;
  }

  // 只清价格与数量，保留日期与方向 —— 连续记同一天的多笔是常见操作
  $('tradePrice').value = '';
  $('tradeShares').value = '';
  $('tradeMsg').textContent = '';
  await afterTradesChanged();
}

/** 日期输入框的默认值：今天。最常见的情形是「刚成交，记一笔」 */
function fillTodayInTradeDate() {
  if (!$('tradeDate').value) $('tradeDate').value = todayKey();
}

// —— 设置面板：价格预警 ——

/**
 * 面板里待保存的预警配置。
 *
 * 与 draftWatchlist 同一套思路：先在本地改，点「保存」才落盘。
 * 但**规则的增删是立即生效的**（各自 patch 一次）—— 预警是「设了就该管用」的
 * 东西，让用户加完规则还得记得点保存，漏点一次就白等一天。
 * 所以这里存的是当前真实状态的镜像，不是草稿。
 */
let alertsState = { enabled: true, rules: {} };

/** 重读并重画预警区 */
async function refreshAlertEditor() {
  const res = await window.api.getAlerts();
  alertsState = res.ok ? res.data : { enabled: true, rules: {} };
  renderAlertEditor();
  fillRuleCodeOptions();
}

function renderAlertEditor() {
  $('alertsEnabled').checked = alertsState.enabled !== false;
  window.StockAlerts.renderAlertStatus($('alertStatus'), alertsState);
  window.StockAlerts.renderRuleEditor($('ruleEditor'), alertsState.rules, state.watchlist, {
    onRemove: removeAlertRule,
    onToggle: toggleAlertRule,
  });
}

/**
 * 填「对哪只股票」下拉。
 *
 * 只列关注列表里的股票 —— 给不在列表里的股票设规则没有意义（引擎只遍历
 * 行情列表，见 evaluateAlerts）。已有的孤儿规则仍会显示，但不能新增。
 */
function fillRuleCodeOptions() {
  const sel = $('ruleCode');
  const keep = sel.value;
  clearNode(sel);
  for (const w of state.watchlist) {
    const opt = document.createElement('option');
    opt.value = w.code;
    opt.textContent = w.alias || w.name || w.digits;
    sel.appendChild(opt);
  }
  // 尽量保住用户已选的那只，否则每次重画都跳回第一个
  if (keep && state.watchlist.some((w) => w.code === keep)) sel.value = keep;
  else if (state.selected && state.watchlist.some((w) => w.code === state.selected)) sel.value = state.selected;
}

/** 提交当前的 alertsState 并重画。失败时把错误显示出来 */
async function commitAlerts() {
  const res = await window.api.saveAlerts(alertsState);
  if (!res.ok) {
    $('alertMsg').textContent = `保存失败：${res.error}`;
    return false;
  }
  // 以主进程规范化后的结果为准：它会去重、截断上限、剔除非法项，
  // 拿本地那份继续用会让界面显示出实际没生效的规则
  alertsState = res.data;
  $('alertMsg').textContent = '';
  renderAlertEditor();
  return true;
}

async function addAlertRule() {
  const code = $('ruleCode').value;
  if (!code) {
    $('alertMsg').textContent = '请先在关注列表里添加股票';
    return;
  }
  const raw = $('ruleValue').value.trim();
  if (raw === '') {
    $('alertMsg').textContent = '请填阈值';
    return;
  }

  alertsState = {
    ...alertsState,
    rules: window.StockAlerts.addRule(alertsState.rules, code, {
      kind: $('ruleKind').value,
      dir: $('ruleDir').value,
      value: raw,
      enabled: true,
    }),
  };

  const okSaved = await commitAlerts();
  if (!okSaved) return;
  // 校验由主进程做，它可能把这条丢掉（阈值填了文字之类）。
  // 提交后规则数没变就说明没被接受
  if (!(alertsState.rules[code] || []).some((r) => String(r.value) === String(Number(raw)))) {
    $('alertMsg').textContent = '阈值格式不正确（价格须为正数，涨跌幅与盈亏可为负）';
    return;
  }
  $('ruleValue').value = '';
}

async function removeAlertRule(code, rule) {
  alertsState = { ...alertsState, rules: window.StockAlerts.removeRule(alertsState.rules, code, rule) };
  await commitAlerts();
}

async function toggleAlertRule(code, rule) {
  alertsState = { ...alertsState, rules: window.StockAlerts.toggleRule(alertsState.rules, code, rule) };
  await commitAlerts();
}

async function toggleAlertsEnabled() {
  alertsState = { ...alertsState, enabled: $('alertsEnabled').checked };
  await commitAlerts();
}

async function sendTestAlert() {
  const res = await window.api.testAlert();
  $('alertMsg').textContent = res.ok
    ? '已发出测试通知。没看到的话请检查系统的通知设置与专注助手'
    : `发送失败：${res.error}`;
}

async function resetAlertState() {
  const res = await window.api.resetAlertState();
  $('alertMsg').textContent = res.ok ? '已重置：今天已提醒过的规则可以再次触发' : `重置失败：${res.error}`;
}

/**
 * 点了预警通知后跳到那只股票。
 *
 * 主进程已经把窗口唤出来并切到展开态了，这里只管切股票。
 * 不检查当前模式 —— 那边的 setMode 是同步发生在 alert-navigate 之前的
 */
async function navigateFromAlert(code) {
  if (!code || code === state.selected) return;
  // 通知里的股票可能已被移出关注列表（规则还留着），那时切过去会显示空数据，
  // 不如留在原处
  if (!state.watchlist.some((w) => w.code === code)) return;
  await selectStock(code);
}

function closeSettings() {
  const wasOpen = !$('settings').classList.contains('hidden');
  $('settings').classList.add('hidden');
  /**
   * 只在真的开着时才报。
   *
   * applyMode 每次切到非展开态都会无条件调 closeSettings（省掉一次判断），
   * 不加这个判断的话每次切模式都会发一次多余的 IPC。
   */
  if (wasOpen) window.api.setSettingsOpen(false);
}

function renderWatchEditor() {
  const box = $('watchEditor');
  clearNode(box);

  if (draftWatchlist.length === 0) {
    const div = document.createElement('div');
    div.className = 'hint';
    div.textContent = '搜索并点击结果即可添加';
    box.appendChild(div);
    return;
  }

  draftWatchlist.forEach((item, index) => {
    const row = document.createElement('div');
    row.className = 'watch-row';
    row.draggable = true;
    row.dataset.index = String(index);

    const grip = document.createElement('span');
    grip.className = 'watch-grip';
    grip.textContent = '⋮⋮';

    const name = document.createElement('span');
    name.className = 'watch-row-name';
    name.textContent = item.alias || item.name || item.digits;

    const code = document.createElement('span');
    code.className = 'watch-row-code';
    code.textContent = item.digits;

    const remove = document.createElement('button');
    remove.className = 'watch-remove';
    remove.type = 'button';
    remove.title = '移除';
    remove.textContent = '✕';
    remove.addEventListener('click', () => {
      draftWatchlist.splice(index, 1);
      renderWatchEditor();
    });

    row.append(grip, name, code, remove);

    // 持仓成本与数量：直接写回 draftWatchlist，保存时随关注列表一起落盘。
    // 放在第二行而不是挤进同一行——340px 宽塞不下名称+代码+两个输入框
    const holdRow = document.createElement('div');
    holdRow.className = 'watch-hold-row';

    const costInput = makeHoldInput({
      value: item.cost,
      placeholder: '成本价',
      title: '持仓成本价，留空表示不跟踪盈亏',
      onInput: (v) => {
        item.cost = v;
      },
    });
    const sharesInput = makeHoldInput({
      value: item.shares,
      placeholder: '数量',
      title: '持仓数量（股/份）。留空则只显示盈亏比例，不显示金额',
      onInput: (v) => {
        item.shares = v;
      },
    });

    const times = document.createElement('span');
    times.className = 'watch-hold-x';
    times.textContent = '×';

    holdRow.append(costInput, times, sharesInput);
    row.appendChild(holdRow);

    attachDragHandlers(row);
    box.appendChild(row);
  });
}

/**
 * 成本价/数量输入框。
 *
 * 存原始字符串到 draft，规范化交给 normalizeConfig——在输入过程中就把
 * '12.' 这类中间态清成 null 会让光标跳掉、没法继续打小数点。
 */
function makeHoldInput({ value, placeholder, title, onInput }) {
  const el = document.createElement('input');
  el.type = 'text';
  el.className = 'watch-hold-input';
  el.placeholder = placeholder;
  el.title = title;
  el.value = value != null ? String(value) : '';
  el.addEventListener('input', () => {
    const t = el.value.trim();
    onInput(t === '' ? null : t);
  });
  // 拖动排序时输入框内的文本选择会被 DnD 抢走，按下时临时关掉行的 draggable
  el.addEventListener('mousedown', () => {
    const row = el.closest('.watch-row');
    if (row) row.draggable = false;
  });
  el.addEventListener('blur', () => {
    const row = el.closest('.watch-row');
    if (row) row.draggable = true;
  });
  return el;
}

/** 拖动排序：HTML5 DnD，落点前后交换 */
function attachDragHandlers(row) {
  row.addEventListener('dragstart', (e) => {
    e.dataTransfer.setData('text/plain', row.dataset.index);
    e.dataTransfer.effectAllowed = 'move';
    row.classList.add('dragging');
  });
  row.addEventListener('dragend', () => row.classList.remove('dragging'));
  row.addEventListener('dragover', (e) => {
    e.preventDefault();
    row.classList.add('drop-target');
  });
  row.addEventListener('dragleave', () => row.classList.remove('drop-target'));
  row.addEventListener('drop', (e) => {
    e.preventDefault();
    row.classList.remove('drop-target');
    const from = Number(e.dataTransfer.getData('text/plain'));
    const to = Number(row.dataset.index);
    if (!Number.isFinite(from) || !Number.isFinite(to) || from === to) return;
    const [moved] = draftWatchlist.splice(from, 1);
    draftWatchlist.splice(to, 0, moved);
    renderWatchEditor();
  });
}

const runSearch = debounce(async (keyword) => {
  const box = $('searchResults');
  clearNode(box);
  if (!keyword) return;

  const res = await window.api.searchStocks(keyword);
  if (!res.ok) {
    const div = document.createElement('div');
    div.className = 'hint';
    div.textContent = `搜索失败：${res.error}`;
    box.appendChild(div);
    return;
  }

  const results = res.data || [];
  if (results.length === 0) {
    const div = document.createElement('div');
    div.className = 'hint';
    div.textContent = '没找到匹配的股票或基金';
    box.appendChild(div);
    return;
  }

  for (const item of results) {
    const added = draftWatchlist.some((w) => w.code === item.code);
    const row = document.createElement('div');
    row.className = `search-item${added ? ' added' : ''}`;

    const name = document.createElement('span');
    name.textContent = item.name;
    const code = document.createElement('span');
    code.className = 'search-item-code';
    code.textContent = `${item.exchangeLabel} ${item.digits}`;
    row.append(name, code);

    // 基金打标：ETF 名称常与指数近似（「沪深300」既是指数也是一堆 ETF），
    // 不标出来用户分不清搜到的是什么
    if (item.kindLabel) {
      const kind = document.createElement('span');
      kind.className = 'search-item-kind';
      kind.textContent = item.kindLabel;
      row.appendChild(kind);
    }

    if (added) {
      const tag = document.createElement('span');
      tag.className = 'search-item-code';
      tag.textContent = '已添加';
      row.appendChild(tag);
    } else {
      row.addEventListener('click', () => {
        draftWatchlist.push({
          code: item.code,
          digits: item.digits,
          kind: item.kind,
          isFund: item.isFund,
          alias: '',
          name: item.name,
          cost: null,
          shares: null,
        });
        renderWatchEditor();
        runSearch($('searchInput').value.trim()); // 重画以标记「已添加」
      });
    }
    box.appendChild(row);
  }
}, 250);

async function saveSettings() {
  const cfg = {
    ...(state.config || {}),
    // cost/shares 一并带上，漏掉会在每次保存设置时把持仓静默清空。
    // 这里传的可能是输入中的原始字符串，由 normalizeConfig 统一规范化
    watchlist: draftWatchlist.map((w) => ({
      code: w.code,
      alias: w.alias || '',
      cost: w.cost != null ? w.cost : null,
      shares: w.shares != null ? w.shares : null,
    })),
    selected: draftWatchlist.some((w) => w.code === state.selected)
      ? state.selected
      : draftWatchlist.length > 0
        ? draftWatchlist[0].code
        : '',
    refreshMs: Number($('refreshMs').value) || 0,
    newsLimit: Number($('newsLimit').value) || 30,
    opacity: Number($('opacity').value) || 1,
    includeAnnouncements: $('includeAnnouncements').checked,
    todayOnly: $('todayOnly').checked,
    autoHide: $('autoHide').checked,
    mode: $('startMode').value,
  };

  const res = await window.api.saveConfig(cfg);
  if (!res.ok) {
    $('settingsMsg').textContent = `保存失败：${res.error}`;
    return;
  }

  closeSettings();
  await refreshAll();
  scheduleQuote();
  scheduleNews();

  // 选了「启动时的模式」就当场生效：保存后窗口还是展开的，让用户再去切一次
  // 不合预期。上面的 refreshAll → loadConfig 只同步了 DOM，窗口尺寸得由主进程改。
  // setMode 幂等（同模式直接返回），无条件调即可
  await switchMode(cfg.mode);
}

/**
 * 「恢复自动」那一行只在用户真的拖过列表高度时才显示。
 *
 * 没拖过的话它是句废话（当前就是自动的），摆在 340px 宽的面板里白占两行。
 */
function syncListSizeReset(cfg) {
  const manual = cfg && cfg.listHeight != null;
  $('listSizeRow').classList.toggle('hidden', !manual);
}

/** 清掉手动设的列表高度。清完重读配置，把提示行收起来 */
async function resetListSize() {
  const res = await window.api.resetListHeight();
  if (!res.ok) {
    $('settingsMsg').textContent = `重置失败：${res.error}`;
    return;
  }
  const cfgRes = await window.api.getConfig();
  if (cfgRes.ok) {
    state.config = cfgRes.data;
    syncListSizeReset(cfgRes.data);
  }
  $('settingsMsg').textContent = '已恢复按关注股票数量自动定高';
}

/** 顶部「近期/今日」切换 chip 与配置同步 */
function syncTodayOnlyChip() {
  const chip = $('btnTodayOnly');
  const on = state.config && state.config.todayOnly === true;
  chip.textContent = on ? '今日' : '近期';
  chip.classList.toggle('on', Boolean(on));
  chip.title = on ? '当前：只看今日，点击看近期' : '当前：看近期，点击只看今日';
}

// —— 事件绑定 ——

/**
 * K 线悬停读数：鼠标移到哪根就在顶部显示那根的 OHLC。
 * 分时视图不参与（分时本来就有均价提示）。
 */
function bindChartHover() {
  const canvas = $('chart');
  /** 补拉历史数据期间的去重标记，避免贴着左端每帧都打一次接口 */
  let panLoading = false;

  canvas.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return; // 只认左键
    if (!isKlineView(state.view) || !state.kline) return;

    dragBase.active = true;
    dragBase.moved = false;
    dragBase.x = e.clientX;
    dragBase.from = state.kline.visibleFrom || 0;
    // 拖拽时清掉十字线，读数框留在原处会跟着图一起错位
    if (state.hoverIndex != null) {
      state.hoverIndex = null;
      renderChart();
    }
  });

  // 挂 window 而非 canvas：拖出画布再松手也要正常结束，否则 active 会一直留着，
  // 之后鼠标一进画布就在「拖拽中」状态
  window.addEventListener('mouseup', () => {
    if (!dragBase.active) return;
    dragBase.active = false;
    dragBase.moved = false;
    canvas.style.cursor = isKlineView(state.view) ? 'grab' : '';
  });

  canvas.addEventListener('mousemove', (e) => {
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;

    // 拖拽中：只平移，不做悬停命中——十字线跟着手走会让人分不清在读数还是在拖
    if (dragBase.active) {
      const dx = e.clientX - dragBase.x;
      // 阈值前不动：点一下想看读数时手指难免抖一两像素，直接响应会让十字线闪一下
      if (!dragBase.moved) {
        if (Math.abs(dx) < DRAG_THRESHOLD_PX) return;
        dragBase.moved = true;
        canvas.style.cursor = 'grabbing';
      }

      const { changed, atLeft } = handleDragPan(dx);
      if (changed) renderChart();
      // 顶到左端说明手上的历史不够了，补拉一次。requestBarCount 会带上
      // 当前 panOffset，所以拉回来的数据足够继续往左拖
      if (atLeft && !panLoading) {
        panLoading = true;
        Promise.resolve(loadKline({ force: true })).finally(() => {
          panLoading = false;
          // 数据到手后窗口位置变了，把拖拽基准重贴到当前位置，
          // 否则后续位移仍按补拉前的起点算，图会突然跳一段
          if (dragBase.active && state.kline) {
            dragBase.from = state.kline.visibleFrom || 0;
            dragBase.x = e.clientX;
          }
        });
      }
      return;
    }

    if (state.view === 'day5') {
      if (!state.minute5d) return;
      const days = state.minute5d.days || [];
      if (days.length === 0) return;
      const { MINUTE5D_LAYOUT, minute5dPlotWidth, hitTestMinute5d } = window.StockChart;
      const hit = hitTestMinute5d(
        x,
        MINUTE5D_LAYOUT.padL,
        minute5dPlotWidth(canvas.clientWidth),
        days
      );
      const prev = state.hover5d;
      // 同一个点不重画，省掉整帧开销
      if (
        (hit == null && prev == null) ||
        (hit && prev && hit.dayIdx === prev.dayIdx && hit.pointIdx === prev.pointIdx)
      ) {
        return;
      }
      state.hover5d = hit;
      renderChart();
      return;
    }

    if (!isKlineView(state.view) || !state.kline) return;
    const data = state.kline;
    const bars = data.bars || [];
    const from = data.visibleFrom || 0;
    // 用 visibleCount 而非「从 from 到末尾」：平移后窗口右侧还留着未显示的根，
    // 按到末尾算根数会偏大，十字线会对错根
    const count = Math.min(data.visibleCount || bars.length - from, bars.length - from);
    if (count <= 0) return;

    const { LAYOUT, plotWidth, barIndexAtX } = window.StockCandle;
    const idx = barIndexAtX(x, LAYOUT.padL, plotWidth(canvas.clientWidth), count);

    if (idx === state.hoverIndex) return; // 同一根不重画，省掉整帧开销
    state.hoverIndex = idx < 0 ? null : idx;
    renderChart();
  });

  canvas.addEventListener('mouseleave', () => {
    // 拖拽中鼠标划出画布是常事，此时不该清状态——手还没松，拖动要继续
    if (dragBase.active) return;
    if (state.hoverIndex == null && state.hover5d == null) return;
    state.hoverIndex = null;
    state.hover5d = null;
    renderChart();
  });

  // 滚轮缩放。passive:false 才能 preventDefault——不阻止的话滚轮会连带
  // 滚动下面的新闻列表，缩放时整个面板跟着乱跳
  let wheelBusy = false;
  canvas.addEventListener(
    'wheel',
    (e) => {
      if (!isKlineView(state.view)) return; // 分时/5日 横轴是固定时间槽，不缩放
      e.preventDefault();
      // 缩放可能触发补拉数据，期间忽略新事件，避免连滚十格打十次接口
      if (wheelBusy) return;
      wheelBusy = true;
      Promise.resolve(handleWheelZoom(e)).finally(() => {
        wheelBusy = false;
      });
    },
    { passive: false }
  );
}

function bindEvents() {
  $('picker').addEventListener('click', (e) => {
    e.stopPropagation();
    toggleWatchPanel();
  });

  // ◀▶ 按位置切换，不弹下拉面板
  $('btnPrevStock').addEventListener('click', (e) => {
    e.stopPropagation();
    stepStock(-1);
  });
  $('btnNextStock').addEventListener('click', (e) => {
    e.stopPropagation();
    stepStock(1);
  });

  // 在名称上滚轮也能切换：下拉面板此时是收起的（否则会跟着滚），
  // 拦住 wheel 避免把整卡当页面滚动
  $('picker').addEventListener(
    'wheel',
    (e) => {
      if (!$('watchPanel').classList.contains('hidden')) return; // 面板开着时让面板自己滚
      e.preventDefault();
      stepStock(e.deltaY > 0 ? 1 : -1);
    },
    { passive: false }
  );

  // 点空白处收起下拉
  document.addEventListener('click', (e) => {
    const panel = $('watchPanel');
    if (!panel.classList.contains('hidden') && !panel.contains(e.target)) closeWatchPanel();
  });

  // 折叠态与展开态各有一套按钮（两套互斥 DOM），共用同一批 handler
  const refreshNow = async () => {
    await refreshAll();
    scheduleQuote();
    scheduleNews();
  };
  $('btnRefresh').addEventListener('click', refreshNow);
  $('btnRefreshC').addEventListener('click', refreshNow);

  // 分组头：点击或空格/回车都能开合。用 role=button + tabindex 而不是 <button>，
  // 是因为标题栏里还要放 hint 文字，套在 button 里语义更别扭
  for (const key of Object.keys(GROUP_SPECS)) {
    const bar = $(GROUP_SPECS[key].sectionEl).querySelector('.group-bar');
    if (!bar) continue;
    bar.addEventListener('click', () => toggleGroup(key));
    bar.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault(); // 空格默认会滚动页面
        toggleGroup(key);
      }
    });
  }

  // openSettings 在折叠态下会先展开再开面板（40px 高放不下面板），
  // 所以折叠条上的 ⚙ 直接接同一个函数，与右键菜单行为一致
  $('btnSettings').addEventListener('click', openSettings);
  $('btnSettingsC').addEventListener('click', openSettings);
  const quitApp = () => window.api.quitApp();
  $('btnClose').addEventListener('click', quitApp);
  $('btnCloseC').addEventListener('click', quitApp);
  $('btnSettingsClose').addEventListener('click', closeSettings);
  $('btnSave').addEventListener('click', saveSettings);

  // 交易流水：添加。日期框获得焦点时自动填今天，省一次输入
  $('btnAddTrade').addEventListener('click', addTradeFromEditor);
  $('tradeDate').addEventListener('focus', fillTodayInTradeDate);
  // 在数量框按回车直接添加——记多笔时不必来回摸鼠标
  $('tradeShares').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') addTradeFromEditor();
  });

  // 价格预警。规则的增删改立即生效（各自 patch 一次），不等「保存」——
  // 预警是「设了就该管用」的东西，漏点一次保存就白等一天
  $('btnAddRule').addEventListener('click', addAlertRule);
  $('ruleValue').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') addAlertRule();
  });
  $('alertsEnabled').addEventListener('change', toggleAlertsEnabled);
  $('btnTestAlert').addEventListener('click', sendTestAlert);
  $('btnResetAlertState').addEventListener('click', resetAlertState);

  // 列表模式：清掉手动设的高度，回到按行数自动定高
  $('btnResetListSize').addEventListener('click', resetListSize);

  // —— 模式切换 ——
  // 展开态的 ▲ 走轮换（下一个是列表）；折叠条的 ▼ 直接回展开而不经过列表 ——
  // 从 40px 的条上点展开时，用户想要的是详情
  $('btnCollapse').addEventListener('click', cycleMode);
  $('btnExpand').addEventListener('click', () => switchMode('expanded'));

  // 折叠条上点名称轮换到下一只（放不下下拉面板）
  $('collapsedPicker').addEventListener('click', (e) => {
    e.stopPropagation();
    cycleStock();
  });

  // 双击标题栏轮换模式——与大多数悬浮挂件的手感一致。
  // 双击落在按钮上时不触发，否则「双击刷新」会顺带把窗口切走
  for (const id of ['head', 'collapsedBar']) {
    $(id).addEventListener('dblclick', (e) => {
      if (e.target.closest('button')) return;
      cycleMode();
    });
  }

  // 只看今日 / 看近期
  $('btnTodayOnly').addEventListener('click', async () => {
    const next = !(state.config && state.config.todayOnly);
    const res = await window.api.patchConfig({ todayOnly: next });
    if (res.ok) {
      state.config = res.data;
      syncTodayOnlyChip();
      await loadNews();
    }
  });

  // 走势周期标签。按 [data-view] 选而不是 .tab —— 资讯区的新闻/研报标签
  // 用的是同一个 .tab 样式类，用 .tab 会把它们也绑到 switchView 上
  for (const btn of document.querySelectorAll('[data-view]')) {
    btn.addEventListener('click', () => switchView(btn.dataset.view));
  }

  // 资讯筛选：全部 / 新闻 / 研报
  for (const btn of document.querySelectorAll('[data-filter]')) {
    btn.addEventListener('click', () => switchFilter(btn.dataset.filter));
  }

  bindChartHover();

  $('searchInput').addEventListener('input', (e) => runSearch(e.target.value.trim()));
  $('searchInput').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeSettings();
  });

  $('opacity').addEventListener('input', (e) => {
    $('opacityVal').textContent = `${Math.round(Number(e.target.value) * 100)}%`;
  });

  /**
   * 自动隐藏即时生效，不等「保存」。
   *
   * 与其他设置项不同的理由：勾了之后用户会立刻想试试（把鼠标移开看它会不会滑走），
   * 而其他项（新闻条数、透明度）改完看不出什么，攒到保存再一起生效没问题。
   * 用 patchConfig 而不是 saveConfig —— 面板里其他字段可能正编辑到一半，
   * 整体保存会把半成品写进配置。
   */
  $('autoHide').addEventListener('change', async (e) => {
    const on = e.target.checked;
    const res = await window.api.patchConfig({ autoHide: on });
    if (!res.ok) {
      $('settingsMsg').textContent = `设置失败：${res.error}`;
      // 写不进去就把勾选状态改回来，别让界面显示一个没生效的状态
      e.target.checked = !on;
      return;
    }
    state.config = res.data;
  });

  // Esc 关面板；F5 / Ctrl+R 刷新
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (!$('settings').classList.contains('hidden')) closeSettings();
      else closeWatchPanel();
    }
    if (e.key === 'F5' || (e.ctrlKey && e.key === 'r')) {
      e.preventDefault();
      refreshAll();
    }
    // Ctrl+M 轮换模式（M = minimize，与常见挂件一致）
    if (e.ctrlKey && (e.key === 'm' || e.key === 'M')) {
      e.preventDefault();
      cycleMode();
    }
  });

  // 窗口尺寸变化时重画（Canvas 不会自适应）。
  // K 线视图下宽度变了要取的根数也变，重新拉一次。
  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      // 折叠态下大图与指标图都不可见，重画是白费；要跟着宽度走的是缩略图——
      // 它是可收缩的（.collapsed-spark 的 flex: 0 1 62px），CSS 宽度变了
      // 位图不重画就会被拉伸发虚
      if (state.mode === 'collapsed') {
        renderCollapsedBar();
        return;
      }
      // 列表模式全是 DOM 文本，宽度变化由 CSS 的 ellipsis 消化，无需重画。
      // 高度也不用重报——它只跟行数有关，与窗口宽度无关
      if (state.mode === 'list') return;
      if (state.view === 'minute') {
        if (state.detail) renderChart();
      } else if (state.view === 'day5') {
        // 点数与画布宽无关（固定 5×240 槽），只需重画不必重拉
        if (state.minute5d) renderChart();
      } else if (state.zoomCount != null) {
        // 用户已手动缩放：根数由缩放决定，与画布宽无关，重画即可。
        // 若照旧重拉会按新画布宽覆盖掉缩放级别
        if (state.kline) renderChart();
      } else {
        loadKline({ force: true });
      }
      // 指标子图的宽度跟着窗口走，重画即可（数据与宽度无关，不必重拉）
      drawIndicatorCharts();
    }, 120);
  });

  // 主进程右键菜单
  window.api.onRefresh(() => refreshAll());
  window.api.onOpenSettings(() => openSettings());
  // 托盘与右键菜单里的模式切换由主进程改完尺寸后通知过来
  window.api.onModeChanged((v) => applyMode(v));
  // 点了预警通知：主进程已唤出窗口并切到展开态，这里只管切股票
  window.api.onAlertNavigate((code) => navigateFromAlert(code));
}

// —— 启动 ——

(async function boot() {
  bindEvents();
  await refreshAll();
  if (state.selected) {
    scheduleQuote();
    scheduleNews();
  } else {
    renderEmptyState();
    // 空配置也要轮询：用户在设置里加完股票后，下一轮自动接上
    scheduleQuote();
  }
})();
