'use strict';

/**
 * 编排层：把 quoteClient / newsClient 的原始数据组装成渲染层直接可用的形状。
 *
 * 所有函数都接受 `deps` 注入点（默认走真实客户端），便于单测不发网络请求。
 */

const quoteClient = require('./quoteClient');
const newsClient = require('./newsClient');
const klineClient = require('./klineClient');
const emKlineClient = require('./emKlineClient');
const flowClient = require('./flowClient');
const marginClient = require('./marginClient');
const financeClient = require('./financeClient');
const reportClient = require('./reportClient');
const lhbClient = require('./lhbClient');
const indicators = require('./indicators');
const { normalizeCode } = require('./stockCode');
const { localDateKey, parseQuoteTime, resolvePhase } = require('./marketTime');
const { computePosition, summarizePositions } = require('./position');

const DEFAULT_DEPS = {
  fetchQuotes: quoteClient.fetchQuotes,
  fetchMinuteLine: quoteClient.fetchMinuteLine,
  fetchMultiDayMinute: quoteClient.fetchMultiDayMinute,
  fetchStockNewsWithFallback: newsClient.fetchStockNewsWithFallback,
  fetchAnnouncements: newsClient.fetchAnnouncements,
  fetchKline: klineClient.fetchKline,
  fetchKline60: emKlineClient.fetchKline60,
  fetchFlow: flowClient.fetchFlow,
  fetchMargin: marginClient.fetchMargin,
  fetchFinance: financeClient.fetchFinance,
  fetchReports: reportClient.fetchReports,
  fetchLhb: lhbClient.fetchLhb,
};

/** 均线周期：日/周 K 都用这三条，与各家行情软件默认一致 */
const MA_PERIODS = [5, 10, 20];

/** 多取的预热根数：让屏幕最左侧那根也能算出 MA20 */
const MA_WARMUP = Math.max(...MA_PERIODS);

/** 统一的错误信息提取，避免把 Error 对象直接抛给 IPC */
function errMsg(err) {
  return String(err && err.message ? err.message : err);
}

/**
 * 拉关注列表的行情快照（用于顶部下拉与涨跌染色）。
 * 单只失败不影响其他，失败项带 error 字段返回。
 *
 * @param {object} cfg
 * @param {object} [deps]
 * @param {object|null} [holdings] 持仓覆盖表 { [code]: {cost, shares} }。
 *   给了就用它取代 watchlist 条目里手填的 cost/shares —— 交易流水推导出的持仓
 *   走这条路。本层仍然不读文件、不认识 trades.json，可测性不变
 */
async function collectWatchlist(cfg, deps = {}, holdings = null) {
  const d = { ...DEFAULT_DEPS, ...deps };
  const watchlist = (cfg && cfg.watchlist) || [];
  const codes = watchlist.map((w) => w.code);

  /**
   * 该股实际生效的持仓。
   *
   * 覆盖表里**存在这个键**就用它（哪怕值是 {cost: null}）—— 那表示
   * 「这只股票有流水，且流水显示已清仓」，此时不该回落到手填的旧成本价，
   * 否则清仓后界面还挂着浮动盈亏。用 `in` 判断而非真值判断正是为了这个。
   */
  const holdingFor = (w) => (holdings && w.code in holdings ? holdings[w.code] : w);

  let quotes = new Map();
  let error = '';
  try {
    quotes = await d.fetchQuotes(codes);
  } catch (err) {
    error = errMsg(err);
  }

  const items = watchlist.map((w) => {
    const h = holdingFor(w);
    const cost = h && h.cost != null ? h.cost : null;
    const shares = h && h.shares != null ? h.shares : null;

    const q = quotes.get(w.code);
    if (!q || !q.ok) {
      return {
        code: w.code,
        digits: w.digits,
        kind: w.kind,
        isFund: w.isFund,
        alias: w.alias,
        name: w.alias || w.digits,
        cost,
        shares,
        // 拿不到现价就算不出盈亏，position 保持 null
        position: null,
        error: (q && q.error) || error || '无数据',
      };
    }
    return {
      code: w.code,
      digits: w.digits,
      kind: w.kind,
      isFund: w.isFund,
      alias: w.alias,
      name: w.alias || q.name,
      realName: q.name,
      price: q.price,
      change: q.change,
      changePct: q.changePct,
      cost,
      shares,
      // 在服务层算而非渲染层：详情区与下拉列表共用同一套结果，
      // 两处各算一遍容易出现口径不一致
      position: computePosition({
        cost,
        shares,
        price: q.price,
        change: q.change,
      }),
    };
  });

  return { items, error, summary: summarizePositions(items) };
}

/**
 * 拉单只股票的完整行情详情（快照 + 当日分时）。
 */
/**
 * @param {string} code
 * @param {object} [deps]
 * @param {{cost?: number, shares?: number}} [holding]
 *   该股在配置里的持仓设置。由 main.js 从 cfg.watchlist 查出后传入——
 *   本层不读配置，保持可测性
 * @param {{ isTradingDay?: (dateKey: string) => Promise<boolean|null> }} [calendar]
 *   交易日历，可选。给了就用它判法定节假日（能在开盘前就判出来）；
 *   不给或查询失败时回落到「周末 + 行情时间戳」，与接入日历前的行为一致
 */
async function collectDetail(code, deps = {}, holding = null, calendar = null) {
  const d = { ...DEFAULT_DEPS, ...deps };
  const norm = normalizeCode(code);
  if (!norm.ok) throw new Error(norm.error);

  const now = new Date();

  // 分时接口偶发失败不应连带打掉数字行情，故分别 catch。
  // 日历也一并并发查：它有缓存，绝大多数调用不会真的发请求
  const [quoteRes, minuteRes, calRes] = await Promise.allSettled([
    d.fetchQuotes([norm.code]),
    d.fetchMinuteLine(norm.code),
    calendar && typeof calendar.isTradingDay === 'function'
      ? calendar.isTradingDay(localDateKey(now))
      : Promise.resolve(null),
  ]);

  if (quoteRes.status !== 'fulfilled') throw new Error(errMsg(quoteRes.reason));
  const quote = quoteRes.value.get(norm.code);
  if (!quote || !quote.ok) throw new Error((quote && quote.error) || '无行情数据');

  const minute =
    minuteRes.status === 'fulfilled' ? minuteRes.value : { date: '', prevClose: null, points: [] };
  const minuteError = minuteRes.status === 'rejected' ? errMsg(minuteRes.reason) : '';

  // 分时接口没给昨收时，用快照的昨收兜底（基准线必须有值）
  const prevClose = minute.prevClose != null ? minute.prevClose : quote.prevClose;

  const quoteTime = parseQuoteTime(quote.quoteTime);
  // 日历查询失败按「不可用」处理，不让它影响行情展示
  const isTradingDay = calRes.status === 'fulfilled' ? calRes.value : null;
  const resolved = resolvePhase({ now, quoteTime, isTradingDay });

  return {
    code: norm.code,
    digits: norm.digits,
    exchange: norm.exchange,
    kind: norm.kind,
    isFund: norm.isFund,
    quote,
    minute: { ...minute, prevClose, points: minute.points || [] },
    minuteError,
    phase: resolved.phase,
    phaseLabel: resolved.label,
    isHoliday: resolved.isHoliday,
    /** 时段结论由哪一层给出：'calendar' | 'stale' | 'weekend' | 'clock'。便于排查 */
    phaseSource: resolved.source,
    quoteTimeText: quoteTime ? formatClock(quoteTime) : '',
    fetchedAt: now.toISOString(),
    /** 持仓盈亏。未设成本价时为 null，渲染层据此隐藏整块 */
    position: computePosition({
      cost: holding && holding.cost,
      shares: holding && holding.shares,
      price: quote.price,
      change: quote.change,
    }),
  };
}

function formatClock(date) {
  const p = (n) => String(n).padStart(2, '0');
  return `${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}`;
}

/**
 * 合并新闻与公告，按时间倒序，标注是否今日，并按日期分组。
 */
function mergeNewsItems(news, announcements, opts = {}) {
  const { newsLimit = 30, todayOnly = false, today = localDateKey() } = opts;

  const all = [
    ...(Array.isArray(news) ? news : []),
    ...(Array.isArray(announcements) ? announcements : []),
  ].filter((it) => it && it.title);

  // 同一条新闻可能同时出现在新闻与公告里，按标题去重（保留先出现的）
  const seen = new Set();
  const deduped = [];
  for (const it of all) {
    const key = `${it.date}|${it.title}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push({ ...it, isToday: it.date === today });
  }

  deduped.sort((a, b) => (a.datetime < b.datetime ? 1 : a.datetime > b.datetime ? -1 : 0));

  const todayCount = deduped.filter((it) => it.isToday).length;
  const filtered = todayOnly ? deduped.filter((it) => it.isToday) : deduped;
  const limited = filtered.slice(0, newsLimit);

  // 按日期分组，保持倒序
  const groups = [];
  const indexByDate = new Map();
  for (const it of limited) {
    if (!indexByDate.has(it.date)) {
      indexByDate.set(it.date, groups.length);
      groups.push({ date: it.date, isToday: it.date === today, items: [] });
    }
    groups[indexByDate.get(it.date)].items.push(it);
  }

  return { items: limited, groups, todayCount, total: deduped.length };
}

/**
 * 拉单只股票的新闻 + 公告。
 * 新闻失败时仍返回公告（反之亦然），两者都失败才带 error。
 */
async function collectNews(code, cfg = {}, deps = {}) {
  const d = { ...DEFAULT_DEPS, ...deps };
  const norm = normalizeCode(code);
  if (!norm.ok) throw new Error(norm.error);

  const wantAnn = cfg.includeAnnouncements !== false;

  // 基金不拉个股新闻：新浪那个页面只按 symbol 取「个股」新闻，对基金代码会
  // 静默回落成大盘快讯——已实测 ETF 与伪代码 sh999999 返回的内容逐条相同。
  // 拿它当「该 ETF 的新闻」展示是在骗人，不如只给基金公告（东财那路是真的）。
  const wantNews = !norm.isFund;

  const [newsRes, annRes] = await Promise.allSettled([
    // 新浪优先、东财兜底。fetchStockNewsWithFallback 内部不抛错，
    // 但仍放在 allSettled 里 —— 注入的 dep 可能是会抛的实现
    wantNews
      ? d.fetchStockNewsWithFallback(norm.code, norm.digits)
      : Promise.resolve({ items: [], source: '', warning: '' }),
    wantAnn ? d.fetchAnnouncements(norm.digits, { kind: norm.kind }) : Promise.resolve([]),
  ]);

  const newsOut = newsRes.status === 'fulfilled' ? newsRes.value : { items: [], source: '', warning: '' };
  const news = Array.isArray(newsOut.items) ? newsOut.items : [];
  const announcements = annRes.status === 'fulfilled' ? annRes.value : [];

  const errors = [];
  if (wantNews && newsRes.status === 'rejected') errors.push(`新闻：${errMsg(newsRes.reason)}`);
  // 主源失灵走了备份源，或两个源都空 —— 都由 warning 带出来，不算硬错误
  if (wantNews && newsRes.status === 'fulfilled' && newsOut.warning) errors.push(newsOut.warning);
  if (wantAnn && annRes.status === 'rejected') errors.push(`公告：${errMsg(annRes.reason)}`);

  const merged = mergeNewsItems(news, announcements, {
    newsLimit: cfg.newsLimit,
    todayOnly: cfg.todayOnly,
  });

  return {
    code: norm.code,
    kind: norm.kind,
    isFund: norm.isFund,
    // 基金只有公告一路数据源，UI 据此把空列表的文案说成「暂无公告」而非「暂无新闻」
    newsSupported: wantNews,
    /** 新闻实际来自哪个源：'sina' | 'eastmoney' | ''。UI 在走备份源时可标注 */
    newsSource: newsOut.source || '',
    ...merged,
    // 两个源都挂了才算硬错误；单源失败只做提示
    error: news.length === 0 && announcements.length === 0 && errors.length > 0 ? errors.join('；') : '',
    warning: errors.length > 0 && (news.length > 0 || announcements.length > 0) ? errors.join('；') : '',
    fetchedAt: new Date().toISOString(),
  };
}

/**
 * 拉机构研报评级。
 *
 * 与新闻页平级的独立区块（用户指定），故单独一个 collect 而不是塞进 collectNews。
 *
 * 基金与指数直接返回空：研报接口对 ETF 返回 hits=0（已实测 510300），
 * 白发一次请求不如省掉。
 *
 * @param {string} code
 * @param {{ limit?: number }} [params]
 */
async function collectReports(code, params = {}, deps = {}) {
  const d = { ...DEFAULT_DEPS, ...deps };
  const norm = normalizeCode(code);
  if (!norm.ok) throw new Error(norm.error);

  if (norm.kind !== 'stock') {
    return {
      code: norm.code,
      supported: false,
      items: [],
      total: 0,
      summary: { counts: [], top: '', total: 0 },
      fetchedAt: new Date().toISOString(),
    };
  }

  const raw = await d.fetchReports(norm.digits, { limit: params.limit });

  return {
    code: norm.code,
    supported: true,
    items: (raw && raw.items) || [],
    total: (raw && raw.total) || 0,
    summary: (raw && raw.summary) || { counts: [], top: '', total: 0 },
    fetchedAt: new Date().toISOString(),
  };
}

/**
 * 拉融资融券。懒加载。
 *
 * 非两融标的（多数小盘股与全部指数）返回空 days，UI 显示「非两融标的」。
 * ETF 可能是标的（510300 有数据），故不按 kind 预先排除，交给接口判断。
 *
 * @param {string} code
 * @param {{ days?: number }} [params]
 */
async function collectMargin(code, params = {}, deps = {}) {
  const d = { ...DEFAULT_DEPS, ...deps };
  const norm = normalizeCode(code);
  if (!norm.ok) throw new Error(norm.error);

  // 指数没有两融数据，省掉这次请求
  if (norm.kind === 'index') {
    return { code: norm.code, supported: false, days: [], latest: null, finNetSum: 0, fetchedAt: new Date().toISOString() };
  }

  const raw = await d.fetchMargin(norm.code, { days: params.days });
  const days = (raw && raw.days) || [];

  return {
    code: norm.code,
    supported: true,
    name: (raw && raw.name) || '',
    days,
    latest: (raw && raw.latest) || null,
    finNetSum: (raw && raw.finNetSum) || 0,
    fetchedAt: new Date().toISOString(),
  };
}

/**
 * 拉财务主要指标。懒加载。
 *
 * 基金与指数没有财务报表（已实测返回 code 9201），直接返回 supported:false
 * 而不发请求 —— UI 据此说「基金无财务数据」，比空列表清楚。
 *
 * @param {string} code
 * @param {{ periods?: number }} [params]
 */
async function collectFinance(code, params = {}, deps = {}) {
  const d = { ...DEFAULT_DEPS, ...deps };
  const norm = normalizeCode(code);
  if (!norm.ok) throw new Error(norm.error);

  if (norm.kind !== 'stock') {
    return { code: norm.code, supported: false, periods: [], latest: null, fetchedAt: new Date().toISOString() };
  }

  const raw = await d.fetchFinance(norm.code, { periods: params.periods });

  return {
    code: norm.code,
    supported: true,
    periods: (raw && raw.periods) || [],
    latest: (raw && raw.latest) || null,
    fetchedAt: new Date().toISOString(),
  };
}

/**
 * 拉龙虎榜。懒加载。
 *
 * 基金不上龙虎榜（已实测 510300 返回空），指数虽然接口有数据但那是同数字的
 * 股票串过来的历史遗留，一律按不支持处理。
 *
 * @param {string} code
 * @param {{ limit?: number }} [params]
 */
async function collectLhb(code, params = {}, deps = {}) {
  const d = { ...DEFAULT_DEPS, ...deps };
  const norm = normalizeCode(code);
  if (!norm.ok) throw new Error(norm.error);

  if (norm.kind !== 'stock') {
    return {
      code: norm.code,
      supported: false,
      items: [],
      latest: null,
      isRecent: false,
      daysSince: null,
      total: 0,
      fetchedAt: new Date().toISOString(),
    };
  }

  const raw = await d.fetchLhb(norm.code, { limit: params.limit });

  return {
    code: norm.code,
    supported: true,
    items: (raw && raw.items) || [],
    latest: (raw && raw.latest) || null,
    isRecent: Boolean(raw && raw.isRecent),
    daysSince: raw && raw.daysSince != null ? raw.daysSince : null,
    total: (raw && raw.total) || 0,
    fetchedAt: new Date().toISOString(),
  };
}

/** 60 分钟 K 线的周期标识。走东财而非腾讯，见 emKlineClient */
const PERIOD_60MIN = '60min';

/**
 * 拉 K 线并附上均线。
 *
 * 关于根数：调用方传的 `count` 是**要画在屏幕上**的根数，这里会额外多取
 * MA_WARMUP 根做预热，否则最左侧那几根算不出 MA20，均线会从图中间才开始。
 * 返回时用 visibleFrom 标出「从第几根起是要画的」，预热根留着给渲染层算均线。
 *
 * 周期 '60min' 走东财（emKlineClient），日/周/月走腾讯（klineClient）——
 * 两者返回形状一致（bars 里都是 {date, open, close, high, low, volume}），
 * 后面的均线计算与切窗逻辑不用分支。唯一区别是 60min 的 date 带 ' HH:MM'。
 *
 * @param {string} code
 * @param {{ period?: string, count?: number, fq?: string }} [params]
 */
async function collectKline(code, params = {}, deps = {}) {
  const d = { ...DEFAULT_DEPS, ...deps };
  const norm = normalizeCode(code);
  if (!norm.ok) throw new Error(norm.error);

  // 只有「有限且为正」才采信，否则回落到 80；
  // 注意不能写 Math.max(1, n)——那样 count=-5 会变成 1 根，静默画出一根光杆
  const wanted = Math.round(Number(params.count));
  const visibleCount = Number.isFinite(wanted) && wanted > 0 ? wanted : 80;

  const is60 = params.period === PERIOD_60MIN;
  /**
   * 60 分钟接口硬顶 126 根（实测请求 5000 也只回 126），不像日 K 能多取预热。
   * 所以这里请求量取「可见 + 预热」与硬顶的较小值 —— 拿不满时预热根会少，
   * 最左侧几根的 MA20 为 null，渲染层本来就按 null 断线，不会画错。
   */
  const raw = is60
    ? await d.fetchKline60(norm.code, {
        count: Math.min(emKlineClient.MAX_BARS, visibleCount + MA_WARMUP),
      })
    : await d.fetchKline(norm.code, {
        period: params.period,
        fq: params.fq,
        count: visibleCount + MA_WARMUP,
      });

  const bars = raw.bars || [];
  const mas = {};
  for (const p of MA_PERIODS) mas[`ma${p}`] = klineClient.movingAverage(bars, p);

  // 把均线并进每根，渲染层不必再对齐下标
  const withMa = bars.map((bar, i) => {
    const out = { ...bar };
    for (const p of MA_PERIODS) out[`ma${p}`] = mas[`ma${p}`][i];
    return out;
  });

  // 预热根不画，但要保留以便渲染层需要时回溯
  const visibleFrom = Math.max(0, withMa.length - visibleCount);

  // 首根的涨跌要跟它前一根比；最左边那根没有前一根时用接口给的 prec
  const baseClose = visibleFrom > 0 ? withMa[visibleFrom - 1].close : raw.prevClose;

  return {
    code: norm.code,
    period: raw.period,
    fq: raw.fq,
    bars: withMa,
    visibleFrom,
    // 实际可见根数：数据不足时会少于请求值，渲染层缩放要以这个为基准，
    // 不能拿请求值去算，否则可见区会越过数组末尾
    visibleCount: withMa.length - visibleFrom,
    prevClose: raw.prevClose,
    baseClose: baseClose == null ? null : baseClose,
    maPeriods: MA_PERIODS,
    fetchedAt: new Date().toISOString(),
  };
}

/**
 * 算技术指标。懒加载：只在用户展开「技术指标」分组时才请求。
 *
 * 单独拉一份 K 线而不复用 collectKline 的结果：指标要的预热根数
 * （MACD 的 60 根）比画图要的（MA20 的 20 根）多，混在一起会让
 * 图表白白多取 40 根。两者各取所需，接口本身有缓存不心疼。
 *
 * 只返回**最后一根**的指标值 —— UI 是数字面板不是副图，不需要整条序列。
 * 若日后要画 MACD 副图，把 series 一并返回即可，计算部分不用改。
 *
 * @param {string} code
 * @param {{ period?: 'day'|'week'|'month' }} [params]
 * @returns {Promise<object>} 数据不足时各值为 null，不抛错
 */
async function collectIndicators(code, params = {}, deps = {}) {
  const d = { ...DEFAULT_DEPS, ...deps };
  const norm = normalizeCode(code);
  if (!norm.ok) throw new Error(norm.error);

  const period = params.period === 'week' || params.period === 'month' ? params.period : 'day';

  // 60 根预热 + SERIES_LEN 根用于画子图。前复权：指标必须用复权价，
  // 否则除权日会算出假的金叉死叉。
  const raw = await d.fetchKline(norm.code, {
    period,
    fq: 'qfq',
    count: indicators.MACD_WARMUP + SERIES_LEN,
  });

  const bars = raw.bars || [];
  const all = indicators.computeAll(bars);
  const i = bars.length - 1;

  /** 取末根的值；下标越界或无数据时为 null */
  const at = (arr) => (i >= 0 && arr && arr[i] != null ? arr[i] : null);

  const close = i >= 0 ? bars[i].close : null;
  const boll = { up: at(all.boll.up), mid: at(all.boll.mid), low: at(all.boll.low) };

  return {
    code: norm.code,
    period: raw.period,
    /** 末根的日期，让 UI 能说明「截至哪天」——周K 时尤其重要 */
    date: i >= 0 ? bars[i].date || '' : '',
    close,
    barCount: bars.length,
    macd: { dif: at(all.macd.dif), dea: at(all.macd.dea), macd: at(all.macd.macd) },
    rsi: { rsi6: at(all.rsi.rsi6), rsi12: at(all.rsi.rsi12), rsi24: at(all.rsi.rsi24) },
    kdj: { k: at(all.kdj.k), d: at(all.kdj.d), j: at(all.kdj.j) },
    boll: {
      ...boll,
      /**
       * 收盘价在布林带中的位置：0 = 贴下轨，1 = 贴上轨，可超出 [0,1]（触轨外）。
       * 放在服务层算是因为要处理 up===low（横盘无波动）的除零，
       * 渲染层重复这段逻辑容易漏。
       */
      pctB:
        close != null && boll.up != null && boll.low != null && boll.up !== boll.low
          ? (close - boll.low) / (boll.up - boll.low)
          : null,
    },
    periods: all.periods,
    /**
     * 末 SERIES_LEN 根的序列，供渲染层画趋势子图。
     *
     * 与上面的标量字段并存而不是取代它们：摘要文字、超买超卖标注都只要末根值，
     * 让它们去 series 里取末位徒增出错机会。
     *
     * 序列里保留 null —— 预热不足的前几根本就没有值，绘制层据此断线，
     * 用 0 填充会画出一条假的贴零轴走势。
     */
    series: buildSeries(bars, all),
    fetchedAt: new Date().toISOString(),
  };
}

/** 子图画多少根。约 3 个月日线，320px 宽下每根 ~5px，形态可辨 */
const SERIES_LEN = 60;

/**
 * 截出末 SERIES_LEN 根的各指标序列。
 *
 * 不足 SERIES_LEN 根时返回实际长度，不补齐 —— 渲染层按 dates.length 布点，
 * 补 null 只会在图左侧留一段空白。
 */
function buildSeries(bars, all) {
  const n = bars.length;
  const from = Math.max(0, n - SERIES_LEN);
  const cut = (arr) => (Array.isArray(arr) ? arr.slice(from, n) : []);

  return {
    dates: bars.slice(from, n).map((b) => b.date || ''),
    close: bars.slice(from, n).map((b) => (Number.isFinite(b.close) ? b.close : null)),
    dif: cut(all.macd.dif),
    dea: cut(all.macd.dea),
    macd: cut(all.macd.macd),
    rsi6: cut(all.rsi.rsi6),
    rsi12: cut(all.rsi.rsi12),
    rsi24: cut(all.rsi.rsi24),
    k: cut(all.kdj.k),
    d: cut(all.kdj.d),
    j: cut(all.kdj.j),
    up: cut(all.boll.up),
    mid: cut(all.boll.mid),
    low: cut(all.boll.low),
  };
}

/**
 * 拉资金流向。懒加载，同上。
 *
 * 股票、ETF、指数（sh000001 实测有 5 天数据）都能拿到，无需按类型分流。
 * 拿不到时 flowClient 返回空 days，UI 据此显示「暂无数据」即可 ——
 * 新股与长期停牌会走到这条路径。
 *
 * @param {string} code
 * @param {{ days?: number }} [params]
 */
async function collectFlow(code, params = {}, deps = {}) {
  const d = { ...DEFAULT_DEPS, ...deps };
  const norm = normalizeCode(code);
  if (!norm.ok) throw new Error(norm.error);

  const raw = await d.fetchFlow(norm.code, { days: params.days });
  const days = (raw && raw.days) || [];

  return {
    code: norm.code,
    name: (raw && raw.name) || '',
    days,
    latest: flowClient.latestFlow(raw),
    /** 近 N 日主力净额累计（元）。null 值跳过而不当 0，避免缺数据被算成「没流入」 */
    mainSum: days.reduce((s, x) => (x.main == null ? s : s + x.main), 0),
    fetchedAt: new Date().toISOString(),
  };
}

/**
 * 拉多日分时（5 日连续分时视图用）。
 *
 * 与 collectKline 一样是懒加载：只在用户切到该标签时才请求，不挂在 collectDetail 上。
 * @returns {Promise<{ code, days, baseClose, fetchedAt }>} days 按日期升序，空数据时为 []
 */
async function collectMinute5d(code, deps = {}) {
  const d = { ...DEFAULT_DEPS, ...deps };
  const norm = normalizeCode(code);
  if (!norm.ok) throw new Error(norm.error);

  const raw = await d.fetchMultiDayMinute(norm.code);
  const days = (raw && Array.isArray(raw.days) ? raw.days : []).filter(
    (day) => day && Array.isArray(day.points) && day.points.length > 0
  );

  // 首日昨收：整张图的参照虚线。没有就为 null，渲染层不画那条线
  const baseClose = days.length > 0 && days[0].prevClose != null ? days[0].prevClose : null;

  return {
    code: norm.code,
    days,
    baseClose,
    fetchedAt: new Date().toISOString(),
  };
}

module.exports = {
  collectWatchlist,
  collectDetail,
  collectNews,
  collectReports,
  collectKline,
  collectMinute5d,
  collectIndicators,
  collectFlow,
  collectMargin,
  collectFinance,
  collectLhb,
  mergeNewsItems,
  DEFAULT_DEPS,
  MA_PERIODS,
  MA_WARMUP,
  SERIES_LEN,
  PERIOD_60MIN,
};
