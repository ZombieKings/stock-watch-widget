'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const {
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
  MA_WARMUP,
  SERIES_LEN,
  PERIOD_60MIN,
} = require('./stockService');
const { MACD_WARMUP } = require('./indicators');
const emKlineClient = require('./emKlineClient');

/** 造一份最小可用的行情对象 */
function quote(overrides = {}) {
  return {
    symbol: 'sh600519',
    ok: true,
    name: '贵州茅台',
    code: '600519',
    price: 1301.5,
    prevClose: 1306.45,
    change: -4.95,
    changePct: -0.38,
    quoteTime: '20260806104333',
    ...overrides,
  };
}

const CFG = { watchlist: [{ code: 'sh600519', digits: '600519', alias: '' }] };

test('collectWatchlist 正常返回行情，别名优先于真实名称', async () => {
  const cfg = {
    watchlist: [
      { code: 'sh600519', digits: '600519', alias: '' },
      { code: 'sz000858', digits: '000858', alias: '老窖对手' },
    ],
  };
  const deps = {
    fetchQuotes: async () =>
      new Map([
        ['sh600519', quote()],
        ['sz000858', quote({ symbol: 'sz000858', name: '五粮液', code: '000858', price: 120 })],
      ]),
  };

  const r = await collectWatchlist(cfg, deps);
  assert.equal(r.items[0].name, '贵州茅台'); // 无别名 → 用真实名
  assert.equal(r.items[1].name, '老窖对手'); // 有别名 → 用别名
  assert.equal(r.items[1].realName, '五粮液');
  assert.equal(r.error, '');
});

test('collectWatchlist 整体请求失败时逐项带 error，不抛异常', async () => {
  const deps = {
    fetchQuotes: async () => {
      throw new Error('网络不通');
    },
  };
  const r = await collectWatchlist(CFG, deps);
  assert.equal(r.error, '网络不通');
  assert.equal(r.items[0].error, '网络不通');
  assert.equal(r.items[0].code, 'sh600519');
});

test('collectWatchlist 单只无数据时其余仍正常', async () => {
  const cfg = {
    watchlist: [
      { code: 'sh600519', digits: '600519', alias: '' },
      { code: 'sh999999', digits: '999999', alias: '' },
    ],
  };
  const deps = {
    fetchQuotes: async () =>
      new Map([
        ['sh600519', quote()],
        ['sh999999', { symbol: 'sh999999', ok: false, error: '无行情数据' }],
      ]),
  };
  const r = await collectWatchlist(cfg, deps);
  assert.equal(r.items[0].price, 1301.5);
  assert.equal(r.items[1].error, '无行情数据');
});

test('collectWatchlist 空关注列表返回空项', async () => {
  const r = await collectWatchlist({ watchlist: [] }, { fetchQuotes: async () => new Map() });
  assert.deepEqual(r.items, []);
});

test('collectDetail 组装行情+分时，昨收缺失时用快照兜底', async () => {
  const deps = {
    fetchQuotes: async () => new Map([['sh600519', quote()]]),
    // 分时接口没返回昨收
    fetchMinuteLine: async () => ({ date: '20260806', prevClose: null, points: [{ time: '09:30', price: 1310 }] }),
  };
  const d = await collectDetail('600519', deps);
  assert.equal(d.code, 'sh600519');
  assert.equal(d.quote.name, '贵州茅台');
  assert.equal(d.minute.prevClose, 1306.45); // 来自快照
  assert.equal(d.minute.points.length, 1);
  assert.equal(d.quoteTimeText, '10:43:33');
});

test('collectDetail 分时失败不影响行情数字', async () => {
  const deps = {
    fetchQuotes: async () => new Map([['sh600519', quote()]]),
    fetchMinuteLine: async () => {
      throw new Error('分时接口 503');
    },
  };
  const d = await collectDetail('600519', deps);
  assert.equal(d.quote.price, 1301.5); // 行情仍在
  assert.equal(d.minuteError, '分时接口 503');
  assert.deepEqual(d.minute.points, []);
});

test('collectDetail 行情失败时抛出，由上层转成错误提示', async () => {
  const deps = {
    fetchQuotes: async () => {
      throw new Error('行情接口挂了');
    },
    fetchMinuteLine: async () => ({ date: '', prevClose: null, points: [] }),
  };
  await assert.rejects(() => collectDetail('600519', deps), /行情接口挂了/);
});

test('collectDetail 代码非法时抛出提示', async () => {
  await assert.rejects(() => collectDetail('bad', {}), /6 位/);
});

test('collectDetail 行情时间戳不是今天 → 标记休市', async () => {
  const deps = {
    // 上一交易日的收盘快照
    fetchQuotes: async () => new Map([['sh600519', quote({ quoteTime: '20200101150000' })]]),
    fetchMinuteLine: async () => ({ date: '', prevClose: null, points: [] }),
  };
  const d = await collectDetail('600519', deps);
  assert.equal(d.isHoliday, true);
  assert.equal(d.phase, 'closed');
  assert.equal(d.phaseLabel, '休市');
});

test('collectDetail 带出 kind/isFund，供 UI 隐藏市盈市净', async () => {
  const etfQuote = quote({
    symbol: 'sh510300',
    name: '沪深300ETF华泰柏瑞',
    code: '510300',
    price: 4.746,
    // 实测：基金的 pe 是空串（解析成 null），pb 是字面 "0.00"（解析成 0）
    pe: null,
    pb: 0,
  });
  const deps = {
    fetchQuotes: async () => new Map([['sh510300', etfQuote]]),
    fetchMinuteLine: async () => ({ date: '20260807', prevClose: 4.709, points: [] }),
  };
  const d = await collectDetail('510300', deps);
  assert.equal(d.code, 'sh510300');
  assert.equal(d.kind, 'fund');
  assert.equal(d.isFund, true);
  // pb=0 会被 fmtNum 渲染成「0.00」，看着像真实数据，所以 UI 必须靠 isFund 隐藏
  assert.equal(d.quote.pb, 0);

  const stock = await collectDetail('600519', {
    fetchQuotes: async () => new Map([['sh600519', quote()]]),
    fetchMinuteLine: async () => ({ date: '', prevClose: null, points: [] }),
  });
  assert.equal(stock.kind, 'stock');
  assert.equal(stock.isFund, false);
});

test('collectWatchlist 逐项带出 isFund，含无行情的项', async () => {
  const cfg = {
    watchlist: [
      { code: 'sh510300', digits: '510300', kind: 'fund', isFund: true, alias: '' },
      { code: 'sh600519', digits: '600519', kind: 'stock', isFund: false, alias: '' },
      { code: 'sz159915', digits: '159915', kind: 'fund', isFund: true, alias: '' },
    ],
  };
  const deps = {
    fetchQuotes: async () =>
      new Map([
        ['sh510300', quote({ symbol: 'sh510300', name: '沪深300ETF华泰柏瑞', price: 4.746 })],
        ['sh600519', quote()],
        // 第三只没数据，走 error 分支——该分支同样要带上 isFund
        ['sz159915', { symbol: 'sz159915', ok: false, error: '无行情数据' }],
      ]),
  };
  const r = await collectWatchlist(cfg, deps);
  assert.equal(r.items[0].isFund, true);
  assert.equal(r.items[1].isFund, false);
  assert.equal(r.items[2].isFund, true, 'error 分支也要带 isFund');
  assert.equal(r.items[2].error, '无行情数据');
});

// —— 新闻合并 ——

const TODAY = '2026-08-06';

function news(date, time, title) {
  return { date, time, datetime: `${date} ${time}`, title, url: `http://x.com/${title}` };
}

test('mergeNewsItems 合并新闻与公告并按时间倒序', () => {
  const r = mergeNewsItems(
    [news(TODAY, '07:59', '融资买入'), news('2026-08-05', '20:03', '白酒标准')],
    [{ ...news(TODAY, '09:00', '半年报'), isAnnouncement: true }],
    { today: TODAY }
  );
  assert.deepEqual(r.items.map((i) => i.title), ['半年报', '融资买入', '白酒标准']);
  assert.equal(r.items[0].isAnnouncement, true);
});

test('mergeNewsItems 标注今日并统计条数', () => {
  const r = mergeNewsItems(
    [news(TODAY, '07:59', 'A'), news(TODAY, '08:00', 'B'), news('2026-08-05', '20:00', 'C')],
    [],
    { today: TODAY }
  );
  assert.equal(r.todayCount, 2);
  assert.equal(r.total, 3);
  assert.equal(r.items.find((i) => i.title === 'A').isToday, true);
  assert.equal(r.items.find((i) => i.title === 'C').isToday, false);
});

test('mergeNewsItems 按日期分组，今日组在最前', () => {
  const r = mergeNewsItems(
    [news(TODAY, '07:59', 'A'), news('2026-08-05', '20:00', 'C'), news(TODAY, '08:00', 'B')],
    [],
    { today: TODAY }
  );
  assert.equal(r.groups.length, 2);
  assert.equal(r.groups[0].date, TODAY);
  assert.equal(r.groups[0].isToday, true);
  assert.deepEqual(r.groups[0].items.map((i) => i.title), ['B', 'A']);
  assert.equal(r.groups[1].date, '2026-08-05');
});

test('mergeNewsItems todayOnly 过滤非今日，但 todayCount 仍反映真实值', () => {
  const r = mergeNewsItems([news(TODAY, '07:59', 'A'), news('2026-08-05', '20:00', 'C')], [], {
    today: TODAY,
    todayOnly: true,
  });
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].title, 'A');
  assert.equal(r.total, 2); // 过滤前的总数
});

test('mergeNewsItems 同日同标题去重', () => {
  const dup = news(TODAY, '07:59', '同一条');
  const r = mergeNewsItems([dup, { ...dup, time: '08:30', datetime: `${TODAY} 08:30` }], [], { today: TODAY });
  assert.equal(r.items.length, 1);
});

test('mergeNewsItems 按 newsLimit 截断', () => {
  const items = Array.from({ length: 10 }, (_, i) => news(TODAY, `09:0${i}`, `新闻${i}`));
  const r = mergeNewsItems(items, [], { today: TODAY, newsLimit: 3 });
  assert.equal(r.items.length, 3);
  assert.equal(r.total, 10);
});

test('mergeNewsItems 丢弃无标题条目与空输入', () => {
  const r = mergeNewsItems([{ date: TODAY, title: '' }, null], null, { today: TODAY });
  assert.deepEqual(r.items, []);
  assert.deepEqual(r.groups, []);
});

/**
 * 造一个 fetchStockNewsWithFallback 的替身。
 *
 * 真实实现内部不抛错，把失败折进 warning 一并返回（新浪失败→东财兜底），
 * 替身也保持这个契约，否则测出来的分支与线上不是同一条。
 */
function newsFeed(items, warning = '', source = 'sina') {
  return async () => ({ items, source: items.length > 0 ? source : '', warning });
}

test('collectNews 新闻挂了但公告成功 → 返回公告并带 warning', async () => {
  const deps = {
    // 两个新闻源都失败时 fetchStockNewsWithFallback 返回空 items + warning
    fetchStockNewsWithFallback: newsFeed([], '新浪新闻：新浪 403；东财新闻返回 0 条', ''),
    fetchAnnouncements: async () => [{ ...news(TODAY, '09:00', '半年报'), isAnnouncement: true }],
  };
  const r = await collectNews('600519', { includeAnnouncements: true }, deps);
  assert.equal(r.items.length, 1);
  assert.equal(r.error, ''); // 不是硬错误
  assert.match(r.warning, /新浪 403/);
});

test('collectNews 新浪挂了走东财兜底 → 有新闻且标出 newsSource', async () => {
  const deps = {
    fetchStockNewsWithFallback: newsFeed(
      [news(TODAY, '15:53', '茅台又涨价了')],
      '新浪新闻：新浪 403',
      'eastmoney'
    ),
    fetchAnnouncements: async () => [],
  };
  const r = await collectNews('600519', { includeAnnouncements: true }, deps);
  assert.equal(r.items.length, 1);
  assert.equal(r.newsSource, 'eastmoney', '要标出实际用了哪个源');
  assert.equal(r.error, '', '备份源拿到数据就不算硬错误');
  // 主源失灵值得提示：两个源的过滤精度不同（东财是全文搜索）
  assert.match(r.warning, /新浪 403/);
});

test('collectNews 新浪正常时 newsSource 为 sina 且无 warning', async () => {
  const deps = {
    fetchStockNewsWithFallback: newsFeed([news(TODAY, '07:59', '融资买入')]),
    fetchAnnouncements: async () => [],
  };
  const r = await collectNews('600519', { includeAnnouncements: true }, deps);
  assert.equal(r.newsSource, 'sina');
  assert.equal(r.warning, '');
  assert.equal(r.error, '');
});

test('collectNews 两个源都挂 → error 非空', async () => {
  const deps = {
    fetchStockNewsWithFallback: newsFeed([], '新浪新闻：新浪 403；东财新闻：东财超时', ''),
    fetchAnnouncements: async () => {
      throw new Error('东财 500');
    },
  };
  const r = await collectNews('600519', { includeAnnouncements: true }, deps);
  assert.match(r.error, /新浪 403/);
  assert.match(r.error, /东财 500/);
  assert.deepEqual(r.items, []);
});

test('collectNews 新闻 dep 直接抛错也不会打挂整个结果', async () => {
  // 真实实现不抛，但注入的替身可能抛 —— allSettled 要能兜住
  const deps = {
    fetchStockNewsWithFallback: async () => {
      throw new Error('替身炸了');
    },
    fetchAnnouncements: async () => [{ ...news(TODAY, '09:00', '半年报'), isAnnouncement: true }],
  };
  const r = await collectNews('600519', { includeAnnouncements: true }, deps);
  assert.equal(r.items.length, 1, '公告仍要返回');
  assert.match(r.warning, /替身炸了/);
});

test('collectNews 关闭公告时不调用公告接口', async () => {
  let annCalled = false;
  const deps = {
    fetchStockNewsWithFallback: newsFeed([news(TODAY, '07:59', 'A')]),
    fetchAnnouncements: async () => {
      annCalled = true;
      return [];
    },
  };
  const r = await collectNews('600519', { includeAnnouncements: false }, deps);
  assert.equal(annCalled, false);
  assert.equal(r.items.length, 1);
});

// —— 基金的新闻路径 ——
//
// 新浪个股新闻页只按 symbol 取「个股」新闻，对基金代码会静默回落成大盘快讯：
// 实测 sh510300 / sz159915 / sh511990 与伪代码 sh999999 返回的内容逐条相同。
// 拿它当「该 ETF 的新闻」展示是在骗人，所以基金只走东财公告。

test('collectNews 基金不请求个股新闻，只拉基金公告', async () => {
  let newsCalled = false;
  let annKind = '';
  const deps = {
    fetchStockNewsWithFallback: async () => {
      newsCalled = true;
      // 大盘快讯，与该 ETF 无关
      return { items: [news(TODAY, '10:01', '快讯：沪指翻红重回3900点')], source: 'sina', warning: '' };
    },
    fetchAnnouncements: async (_digits, opts) => {
      annKind = (opts && opts.kind) || '';
      return [{ ...news(TODAY, '19:00', '2026年第2季度报告'), isAnnouncement: true }];
    },
  };

  const r = await collectNews('510300', { includeAnnouncements: true }, deps);
  assert.equal(newsCalled, false, '基金不该请求个股新闻页');
  assert.equal(annKind, 'fund', '公告要带 kind=fund 以便用 ann_type=FUND');
  assert.equal(r.isFund, true);
  assert.equal(r.kind, 'fund');
  assert.equal(r.newsSupported, false);
  assert.equal(r.items.length, 1);
  assert.match(r.items[0].title, /第2季度报告/);
  assert.equal(r.error, '');
  assert.equal(r.warning, '');
});

test('collectNews 股票仍照常请求个股新闻，kind 为 stock', async () => {
  let newsCalled = false;
  let annKind = '';
  const deps = {
    fetchStockNewsWithFallback: async (code, digits) => {
      newsCalled = true;
      // 两个参数都要传对：东财那路只吃 6 位数字，传 sh600519 会抛错
      assert.equal(code, 'sh600519');
      assert.equal(digits, '600519');
      return { items: [news(TODAY, '07:59', '融资买入')], source: 'sina', warning: '' };
    },
    fetchAnnouncements: async (_digits, opts) => {
      annKind = (opts && opts.kind) || '';
      return [];
    },
  };

  const r = await collectNews('600519', { includeAnnouncements: true }, deps);
  assert.equal(newsCalled, true);
  assert.equal(annKind, 'stock');
  assert.equal(r.isFund, false);
  assert.equal(r.newsSupported, true);
  assert.equal(r.items.length, 1);
});

test('collectNews 基金公告挂了才算硬错误（没有新闻可兜底）', async () => {
  const deps = {
    fetchStockNewsWithFallback: async () => {
      throw new Error('不该被调用');
    },
    fetchAnnouncements: async () => {
      throw new Error('东财 500');
    },
  };
  const r = await collectNews('510300', { includeAnnouncements: true }, deps);
  assert.match(r.error, /东财 500/);
  // 基金没请求新闻，所以 error 里不该出现「新闻：」前缀
  assert.ok(!r.error.includes('新闻'), `error 不该提新闻: ${r.error}`);
  assert.deepEqual(r.items, []);
});

test('collectNews 基金同时关掉公告时返回空列表而非报错', async () => {
  const deps = {
    fetchStockNews: async () => {
      throw new Error('不该被调用');
    },
    fetchAnnouncements: async () => {
      throw new Error('不该被调用');
    },
  };
  const r = await collectNews('510300', { includeAnnouncements: false }, deps);
  assert.deepEqual(r.items, []);
  assert.equal(r.error, '');
  assert.equal(r.newsSupported, false);
});

// —— collectKline ——

/** 造 n 根收盘价递增的日 K，方便验证均线与切片 */
function makeBars(n, startDay = 1) {
  return Array.from({ length: n }, (_, i) => {
    const day = String(startDay + i).padStart(2, '0');
    const close = 100 + i;
    return { date: `2026-03-${day}`, open: close - 0.5, close, high: close + 1, low: close - 1, volume: 1000 + i };
  });
}

test('collectKline 多取 MA_WARMUP 根做预热，visibleFrom 指向首根可见', async () => {
  let seenCount = 0;
  const deps = {
    fetchKline: async (_code, params) => {
      seenCount = params.count;
      return { code: 'sh600519', period: 'day', fq: 'qfq', prevClose: 99, bars: makeBars(params.count) };
    },
  };
  const r = await collectKline('600519', { period: 'day', count: 60 }, deps);

  assert.equal(seenCount, 60 + MA_WARMUP, '应多取预热根数');
  assert.equal(r.bars.length, 60 + MA_WARMUP);
  assert.equal(r.visibleFrom, MA_WARMUP, '可见区应从预热根之后开始');
  assert.equal(r.bars.length - r.visibleFrom, 60, '可见根数应等于请求根数');
});

test('collectKline 首根可见处已能算出 MA20（预热生效）', async () => {
  const deps = {
    fetchKline: async (_c, params) => ({
      code: 'sh600519', period: 'day', fq: 'qfq', prevClose: 99, bars: makeBars(params.count),
    }),
  };
  const r = await collectKline('600519', { count: 30 }, deps);
  const first = r.bars[r.visibleFrom];
  for (const key of ['ma5', 'ma10', 'ma20']) {
    assert.ok(Number.isFinite(first[key]), `首根可见应有 ${key}，否则均线会从图中间才起头`);
  }
});

test('collectKline 均线值与手算一致，且不含未来数据', async () => {
  const deps = {
    fetchKline: async (_c, params) => ({
      code: 'sh600519', period: 'day', fq: 'qfq', prevClose: 99, bars: makeBars(params.count),
    }),
  };
  const r = await collectKline('600519', { count: 10 }, deps);
  const i = r.bars.length - 1;
  const brute5 = r.bars.slice(i - 4, i + 1).reduce((s, b) => s + b.close, 0) / 5;
  assert.ok(Math.abs(r.bars[i].ma5 - brute5) < 1e-9);
  // 中间某根的 ma5 只能用它自己及之前 4 根
  const j = r.bars.length - 5;
  const bruteJ = r.bars.slice(j - 4, j + 1).reduce((s, b) => s + b.close, 0) / 5;
  assert.ok(Math.abs(r.bars[j].ma5 - bruteJ) < 1e-9);
});

test('collectKline baseClose 取首根可见的前一根收盘，用于首根定色', async () => {
  const deps = {
    fetchKline: async (_c, params) => ({
      code: 'sh600519', period: 'day', fq: 'qfq', prevClose: 55, bars: makeBars(params.count),
    }),
  };
  const r = await collectKline('600519', { count: 10 }, deps);
  assert.equal(r.baseClose, r.bars[r.visibleFrom - 1].close, '应等于前一根收盘，不是接口的 prec');
  assert.notEqual(r.baseClose, 55);
});

test('collectKline 根数不足预热时 visibleFrom 归零，baseClose 回落到 prec', async () => {
  const deps = {
    fetchKline: async () => ({ code: 'sh600519', period: 'day', fq: 'qfq', prevClose: 88, bars: makeBars(3) }),
  };
  const r = await collectKline('600519', { count: 60 }, deps);
  assert.equal(r.visibleFrom, 0, '数据不够时不能切掉任何根');
  assert.equal(r.baseClose, 88, '没有前一根时用接口 prec');
  assert.equal(r.bars.length, 3);
});

test('collectKline 空 bars 不抛错，返回空可见区', async () => {
  const deps = {
    fetchKline: async () => ({ code: 'sh600519', period: 'day', fq: 'qfq', prevClose: null, bars: [] }),
  };
  const r = await collectKline('600519', { count: 60 }, deps);
  assert.equal(r.bars.length, 0);
  assert.equal(r.visibleFrom, 0);
  assert.equal(r.baseClose, null);
});

test('collectKline 非法代码抛错且不发请求', async () => {
  let called = false;
  const deps = { fetchKline: async () => { called = true; return { bars: [] }; } };
  await assert.rejects(() => collectKline('不是代码', {}, deps), /代码/);
  assert.equal(called, false);
});

test('collectKline 透传 period 与 fq 给客户端', async () => {
  let seen = null;
  const deps = {
    fetchKline: async (code, params) => {
      seen = { code, ...params };
      return { code, period: params.period, fq: params.fq, prevClose: 1, bars: makeBars(5) };
    },
  };
  const r = await collectKline('600519', { period: 'week', fq: 'hfq', count: 40 }, deps);
  assert.equal(seen.code, 'sh600519', '应传规范化后的带市场前缀代码');
  assert.equal(seen.period, 'week');
  assert.equal(seen.fq, 'hfq');
  assert.equal(r.period, 'week');
});

test('collectKline 基金代码照常走同一条 K 线路径', async () => {
  // ETF 的 K 线接口与股票完全同构（已实测 510300/159915/161725 日周 K 均正常），
  // 这里只确认代码被规范化成带前缀的形式、均线照常算
  const seen = [];
  const deps = {
    fetchKline: async (code, params) => {
      seen.push(code);
      return { code, period: params.period, fq: params.fq, prevClose: 4.7, bars: makeBars(30) };
    },
  };
  for (const [input, expected] of [
    ['510300', 'sh510300'],
    ['159915', 'sz159915'],
    ['161725', 'sz161725'],
  ]) {
    const r = await collectKline(input, { period: 'day', count: 10 }, deps);
    assert.equal(r.code, expected);
    assert.ok(r.bars.length > 0);
    // 均线要真的算出来了（可见区首根往后都该有 ma20）
    assert.ok(Number.isFinite(r.bars[r.visibleFrom].ma20), `${expected} 应有 ma20`);
  }
  assert.deepEqual(seen, ['sh510300', 'sz159915', 'sz161725']);
});

test('collectKline count 非法时回落到 80', async () => {
  const seen = [];
  const deps = {
    fetchKline: async (_c, params) => {
      seen.push(params.count);
      return { code: 'sh600519', period: 'day', fq: 'qfq', prevClose: 1, bars: [] };
    },
  };
  for (const bad of [undefined, null, 0, -5, NaN, 'abc']) {
    await collectKline('600519', { count: bad }, deps);
  }
  assert.ok(seen.every((c) => c === 80 + MA_WARMUP), `应全部回落到 80+预热，实际 ${seen}`);
});

test('collectKline 保留除权日的 dividend 字段', async () => {
  const bars = makeBars(3);
  bars[1].dividend = { content: '10派280.242元', exDate: '2026-06-26' };
  const deps = { fetchKline: async () => ({ code: 'sh600519', period: 'day', fq: 'qfq', prevClose: 1, bars }) };
  const r = await collectKline('600519', { count: 10 }, deps);
  assert.equal(r.bars[1].dividend.content, '10派280.242元');
});

test('collectKline 均线只加在 bar 上，不改动原始 OHLC', async () => {
  const deps = {
    fetchKline: async (_c, params) => ({
      code: 'sh600519', period: 'day', fq: 'qfq', prevClose: 1, bars: makeBars(params.count),
    }),
  };
  const r = await collectKline('600519', { count: 25 }, deps);
  const b = r.bars[r.bars.length - 1];
  assert.equal(b.close, 100 + r.bars.length - 1);
  assert.ok(b.low <= Math.min(b.open, b.close));
  assert.ok(b.high >= Math.max(b.open, b.close));
});

// —— collectMinute5d ——

/** 造一天的分时点 */
function day5(date, prevClose, prices) {
  return {
    date,
    prevClose,
    points: prices.map((price, i) => ({
      time: `09:${String(30 + i).padStart(2, '0')}`,
      price,
      avgPrice: price,
      volume: 100,
      cumVolume: 100 * (i + 1),
      cumAmount: 100 * (i + 1) * price * 100,
      changePct: ((price - prevClose) / prevClose) * 100,
    })),
  };
}

test('collectMinute5d 归一化代码并透传 days，baseClose 取首日昨收', async () => {
  let seenCode = '';
  const deps = {
    fetchMultiDayMinute: async (code) => {
      seenCode = code;
      return {
        days: [day5('2026-08-05', 31.81, [32, 33]), day5('2026-08-06', 33.15, [33.8, 34.3])],
      };
    },
  };
  // 传裸代码，应被归一成带市场前缀的形式
  const r = await collectMinute5d('603738', deps);

  assert.equal(seenCode, 'sh603738');
  assert.equal(r.code, 'sh603738');
  assert.equal(r.days.length, 2);
  assert.equal(r.baseClose, 31.81, 'baseClose 应是首日（最早那天）的昨收');
  assert.ok(r.fetchedAt, '应带抓取时间戳');
});

test('collectMinute5d 丢掉没有点的天', async () => {
  const deps = {
    fetchMultiDayMinute: async () => ({
      days: [
        { date: '2026-08-04', prevClose: 30, points: [] },
        day5('2026-08-05', 31.81, [32]),
        { date: '2026-08-06', prevClose: 33, points: null },
      ],
    }),
  };
  const r = await collectMinute5d('sh603738', deps);
  assert.equal(r.days.length, 1);
  assert.equal(r.days[0].date, '2026-08-05');
  assert.equal(r.baseClose, 31.81);
});

test('collectMinute5d 空数据时返回 days: [] 与 baseClose: null，不抛错', async () => {
  const deps = { fetchMultiDayMinute: async () => ({ days: [] }) };
  const r = await collectMinute5d('sh603738', deps);
  assert.deepEqual(r.days, []);
  assert.equal(r.baseClose, null);
});

test('collectMinute5d 首日缺昨收时 baseClose 为 null，不退化成 0', async () => {
  const deps = {
    fetchMultiDayMinute: async () => ({
      days: [{ date: '2026-08-05', prevClose: null, points: day5('x', 10, [10]).points }],
    }),
  };
  const r = await collectMinute5d('sh603738', deps);
  assert.equal(r.baseClose, null, '退化成 0 会把整条曲线压到画布底部');
});

test('collectMinute5d 代码非法时抛错', async () => {
  const deps = { fetchMultiDayMinute: async () => ({ days: [] }) };
  await assert.rejects(() => collectMinute5d('不是代码', deps));
  await assert.rejects(() => collectMinute5d('', deps));
});

// —— 持仓盈亏接入 ——

test('collectWatchlist 带成本价时算出 position', async () => {
  const cfg = {
    watchlist: [
      { code: 'sh600519', digits: '600519', alias: '', cost: 1250, shares: 100 },
      { code: 'sz000858', digits: '000858', alias: '', cost: null, shares: null },
    ],
  };
  const deps = {
    fetchQuotes: async () =>
      new Map([
        ['sh600519', quote({ price: 1300, change: 10 })],
        ['sz000858', quote({ symbol: 'sz000858', code: '000858', price: 120 })],
      ]),
  };

  const r = await collectWatchlist(cfg, deps);
  assert.equal(r.items[0].position.profit, 5000);
  assert.equal(r.items[0].position.marketValue, 130000);
  assert.equal(r.items[0].position.todayProfit, 1000);
  assert.equal(r.items[1].position, null, '未设成本价的条目 position 为 null');
});

test('collectWatchlist 行情失败时 position 为 null，不抛异常', async () => {
  const cfg = { watchlist: [{ code: 'sh600519', digits: '600519', alias: '', cost: 1250, shares: 100 }] };
  const deps = {
    fetchQuotes: async () => {
      throw new Error('网络不通');
    },
  };
  const r = await collectWatchlist(cfg, deps);
  assert.equal(r.items[0].position, null);
  assert.equal(r.items[0].cost, 1250, '成本价仍要带回，界面可显示「成本 x，暂无行情」');
  assert.equal(r.summary, null);
});

test('collectWatchlist 返回持仓汇总', async () => {
  const cfg = {
    watchlist: [
      { code: 'sh600519', digits: '600519', alias: '', cost: 100, shares: 100 },
      { code: 'sz000858', digits: '000858', alias: '', cost: 50, shares: 200 },
    ],
  };
  const deps = {
    fetchQuotes: async () =>
      new Map([
        ['sh600519', quote({ price: 110 })],
        ['sz000858', quote({ symbol: 'sz000858', code: '000858', price: 60 })],
      ]),
  };
  const r = await collectWatchlist(cfg, deps);
  assert.equal(r.summary.counted, 2);
  assert.equal(r.summary.costValue, 20000);
  assert.equal(r.summary.marketValue, 23000);
  assert.equal(r.summary.profit, 3000);
});

test('collectWatchlist 无人设成本价时 summary 为 null', async () => {
  const deps = { fetchQuotes: async () => new Map([['sh600519', quote()]]) };
  const r = await collectWatchlist(CFG, deps);
  assert.equal(r.summary, null);
});

// —— 持仓覆盖表（交易流水推导出的持仓）——

test('holdings 覆盖表取代手填的 cost/shares', async () => {
  const cfg = { watchlist: [{ code: 'sh600519', digits: '600519', alias: '', cost: 1000, shares: 50 }] };
  const deps = { fetchQuotes: async () => new Map([['sh600519', quote({ price: 1300 })]]) };

  // 流水推导出的持仓：成本 1250、数量 100
  const r = await collectWatchlist(cfg, deps, { sh600519: { cost: 1250, shares: 100 } });
  assert.equal(r.items[0].cost, 1250, '应用覆盖表的成本价，不用手填的 1000');
  assert.equal(r.items[0].shares, 100);
  assert.equal(r.items[0].position.costValue, 125000);
  assert.equal(r.items[0].position.marketValue, 130000);
});

test('不传 holdings 时行为与改造前完全一致', async () => {
  const cfg = { watchlist: [{ code: 'sh600519', digits: '600519', alias: '', cost: 1250, shares: 100 }] };
  const deps = { fetchQuotes: async () => new Map([['sh600519', quote({ price: 1300, change: 10 })]]) };

  const withNull = await collectWatchlist(cfg, deps, null);
  const without = await collectWatchlist(cfg, deps);
  assert.deepEqual(withNull.items[0].position, without.items[0].position);
  assert.equal(without.items[0].cost, 1250);
});

test('覆盖表里没有的股票回落到手填值——只有部分股票记了流水时', async () => {
  const cfg = {
    watchlist: [
      { code: 'sh600519', digits: '600519', alias: '', cost: 1250, shares: 100 },
      { code: 'sz000858', digits: '000858', alias: '', cost: 150, shares: 200 },
    ],
  };
  const deps = {
    fetchQuotes: async () =>
      new Map([
        ['sh600519', quote({ price: 1300 })],
        ['sz000858', quote({ symbol: 'sz000858', code: '000858', price: 160 })],
      ]),
  };

  // 只有 600519 记了流水
  const r = await collectWatchlist(cfg, deps, { sh600519: { cost: 1000, shares: 50 } });
  assert.equal(r.items[0].cost, 1000, '有流水的用推导值');
  assert.equal(r.items[1].cost, 150, '没流水的回落到手填值');
});

test('覆盖表里 cost 为 null（流水显示已清仓）时不回落到手填成本', async () => {
  // 这是 holdingFor 用 `in` 判断而非真值判断的原因：清仓后界面不该
  // 还挂着按旧成本算的浮动盈亏 —— 那笔盈亏已经落到「已实现」里了
  const cfg = { watchlist: [{ code: 'sh600519', digits: '600519', alias: '', cost: 1250, shares: 100 }] };
  const deps = { fetchQuotes: async () => new Map([['sh600519', quote({ price: 1300 })]]) };

  const r = await collectWatchlist(cfg, deps, { sh600519: { cost: null, shares: null } });
  assert.equal(r.items[0].cost, null, '已清仓，不该显示手填的旧成本');
  assert.equal(r.items[0].position, null, '界面据此整块隐藏浮动盈亏');
  assert.equal(r.summary, null);
});

test('覆盖表在行情失败时同样生效（成本价仍要带回）', async () => {
  const cfg = { watchlist: [{ code: 'sh600519', digits: '600519', alias: '', cost: 1000, shares: 50 }] };
  const deps = {
    fetchQuotes: async () => {
      throw new Error('网络不通');
    },
  };
  const r = await collectWatchlist(cfg, deps, { sh600519: { cost: 1250, shares: 100 } });
  assert.equal(r.items[0].cost, 1250);
  assert.equal(r.items[0].shares, 100);
  assert.equal(r.items[0].position, null, '拿不到现价算不出盈亏');
});

test('覆盖表参与持仓汇总', async () => {
  const cfg = {
    watchlist: [
      { code: 'sh600519', digits: '600519', alias: '', cost: null, shares: null },
      { code: 'sz000858', digits: '000858', alias: '', cost: 50, shares: 200 },
    ],
  };
  const deps = {
    fetchQuotes: async () =>
      new Map([
        ['sh600519', quote({ price: 110 })],
        ['sz000858', quote({ symbol: 'sz000858', code: '000858', price: 60 })],
      ]),
  };
  // 600519 手上没填持仓，但有流水
  const r = await collectWatchlist(cfg, deps, { sh600519: { cost: 100, shares: 100 } });
  assert.equal(r.summary.counted, 2, '流水推导出的持仓也要计入汇总');
  assert.equal(r.summary.costValue, 20000);
  assert.equal(r.summary.marketValue, 23000);
});

test('契约：derivePosition 的输出可直接作为 holdings 的值', async () => {
  // main.js 的 holdingsFor 靠这个契约把流水推导的持仓喂进来。
  // 形状对不上会让盈亏静默算错，所以在这里跨模块验一次
  const { derivePosition } = require('./trades');
  const derived = derivePosition([
    { date: '2026-03-14', side: 'buy', price: 1620.5, shares: 100 },
    { date: '2026-05-20', side: 'buy', price: 1700, shares: 100 },
  ]);

  const cfg = { watchlist: [{ code: 'sh600519', digits: '600519', alias: '', cost: null, shares: null }] };
  const deps = { fetchQuotes: async () => new Map([['sh600519', quote({ price: 1750 })]]) };

  const r = await collectWatchlist(cfg, deps, { sh600519: derived });
  assert.equal(r.items[0].cost, 1660.25, '加权平均成本');
  assert.equal(r.items[0].shares, 200);
  assert.equal(r.items[0].position.marketValue, 350000);
  assert.equal(r.items[0].position.profit, 17950, '(1750 - 1660.25) × 200');
});

test('collectDetail 传入 holding 时算出 position', async () => {
  const deps = {
    fetchQuotes: async () => new Map([['sh600519', quote({ price: 1300, change: -5 })]]),
    fetchMinuteLine: async () => ({ date: '2026-08-06', prevClose: 1305, points: [] }),
  };
  const d = await collectDetail('sh600519', deps, { cost: 1250, shares: 200 });
  assert.equal(d.position.profitPct, 4);
  assert.equal(d.position.profit, 10000);
  assert.equal(d.position.todayProfit, -1000);
});

test('collectDetail 未传 holding 时 position 为 null', async () => {
  const deps = {
    fetchQuotes: async () => new Map([['sh600519', quote()]]),
    fetchMinuteLine: async () => ({ date: '2026-08-06', prevClose: 1305, points: [] }),
  };
  assert.equal((await collectDetail('sh600519', deps)).position, null);
  assert.equal((await collectDetail('sh600519', deps, null)).position, null);
  assert.equal((await collectDetail('sh600519', deps, {})).position, null);
});

test('collectDetail 停牌（现价 0）时 position 为 null，不显示亏损 100%', async () => {
  const deps = {
    fetchQuotes: async () => new Map([['sh600519', quote({ price: 0 })]]),
    fetchMinuteLine: async () => ({ date: '2026-08-06', prevClose: 1305, points: [] }),
  };
  const d = await collectDetail('sh600519', deps, { cost: 1250, shares: 100 });
  assert.equal(d.position, null);
});

// —— collectIndicators ——

test('collectIndicators 取足 MACD 预热根数，且用前复权', async () => {
  let seen = null;
  const deps = {
    fetchKline: async (_code, params) => {
      seen = params;
      return { code: 'sh600519', period: 'day', fq: 'qfq', prevClose: 99, bars: makeBars(params.count) };
    },
  };
  await collectIndicators('600519', {}, deps);

  assert.ok(seen.count >= MACD_WARMUP, `应至少取 ${MACD_WARMUP} 根，实得 ${seen.count}`);
  // 除权日会让未复权价算出假金叉，指标必须用 qfq
  assert.equal(seen.fq, 'qfq', '指标必须用前复权价');
  assert.equal(seen.period, 'day');
});

test('collectIndicators 只返回末根的值，并附带该根日期', async () => {
  const deps = {
    fetchKline: async (_c, params) => ({
      code: 'sh600519', period: 'day', fq: 'qfq', prevClose: 99, bars: makeBars(params.count),
    }),
  };
  const r = await collectIndicators('600519', {}, deps);

  // makeBars 收盘价单调递增，末根 close = 100 + (n-1)
  assert.equal(r.close, 100 + (r.barCount - 1));
  assert.ok(typeof r.date === 'string' && r.date.length > 0, '应给出截至日期');
  // 单调上涨 → 快线在慢线上方
  assert.ok(r.macd.dif > 0, `单调上涨 dif 应为正，实得 ${r.macd.dif}`);
  assert.equal(r.rsi.rsi6, 100, '单调上涨 RSI 应为 100');
  // makeBars 的 high = close+1，9 日窗口内 low = close-9，
  // 故 RSV = (close-low)/(high-low) = 9/10 = 90，K 收敛到 90 而非 100。
  // 收盘恰好触及当日最高时 K 才趋近 100（见 indicators.test.js）。
  assert.ok(Math.abs(r.kdj.k - 90) < 0.01, `K 应收敛到 90，实得 ${r.kdj.k}`);
});

test('collectIndicators 的 pctB：收盘价在布林带中的相对位置', async () => {
  const deps = {
    fetchKline: async (_c, params) => ({
      code: 'sh600519', period: 'day', fq: 'qfq', prevClose: 99, bars: makeBars(params.count),
    }),
  };
  const r = await collectIndicators('600519', {}, deps);
  const manual = (r.close - r.boll.low) / (r.boll.up - r.boll.low);
  assert.ok(Math.abs(r.boll.pctB - manual) < 1e-9, `pctB 应为 ${manual}，实得 ${r.boll.pctB}`);
  assert.ok(r.boll.pctB > 0.5, '单调上涨时收盘应在中轨之上');
  // 顺带钉住：pctB 挂在 boll 下，不在顶层
  assert.equal(r.pctB, undefined);
});

test('collectIndicators 横盘无波动时 pctB 为 null 而非 NaN', async () => {
  const flat = Array.from({ length: 100 }, (_, i) => ({
    date: `2026-03-${String((i % 28) + 1).padStart(2, '0')}`,
    open: 50, close: 50, high: 50, low: 50, volume: 100,
  }));
  const deps = {
    fetchKline: async () => ({ code: 'sh600519', period: 'day', fq: 'qfq', prevClose: 50, bars: flat }),
  };
  const r = await collectIndicators('600519', {}, deps);
  // 上下轨重合 → 除零。必须是 null，不能是 NaN（NaN 会在 UI 显示成 "NaN"）
  assert.equal(r.boll.pctB, null);
});

test('collectIndicators 数据不足时各值为 null 而不抛错', async () => {
  const deps = {
    fetchKline: async () => ({ code: 'sh600519', period: 'day', fq: 'qfq', prevClose: 99, bars: makeBars(3) }),
  };
  const r = await collectIndicators('600519', {}, deps);
  assert.equal(r.barCount, 3);
  assert.equal(r.rsi.rsi6, null);
  assert.equal(r.boll.mid, null);
  assert.equal(r.kdj.k, null);
});

test('collectIndicators 空 bars 不抛错', async () => {
  const deps = {
    fetchKline: async () => ({ code: 'sh600519', period: 'day', fq: 'qfq', prevClose: null, bars: [] }),
  };
  const r = await collectIndicators('600519', {}, deps);
  assert.equal(r.barCount, 0);
  assert.equal(r.close, null);
  assert.equal(r.date, '');
  assert.equal(r.macd.dif, null);
});

test('collectIndicators 非法 period 回落到 day', async () => {
  let seen = '';
  const deps = {
    fetchKline: async (_c, params) => {
      seen = params.period;
      return { code: 'sh600519', period: 'day', fq: 'qfq', prevClose: 99, bars: makeBars(params.count) };
    },
  };
  await collectIndicators('600519', { period: 'hour' }, deps);
  assert.equal(seen, 'day');
});

test('collectIndicators 接受 week/month', async () => {
  for (const p of ['week', 'month']) {
    let seen = '';
    const deps = {
      fetchKline: async (_c, params) => {
        seen = params.period;
        return { code: 'sh600519', period: p, fq: 'qfq', prevClose: 99, bars: makeBars(params.count) };
      },
    };
    await collectIndicators('600519', { period: p }, deps);
    assert.equal(seen, p);
  }
});

test('collectIndicators 非法代码抛出可读错误', async () => {
  await assert.rejects(() => collectIndicators('不存在的代码', {}, {}), /代码/);
});

// —— collectIndicators.series（画趋势子图用）——

/** 造一个只按 count 返回递增 bars 的 deps */
function barDeps() {
  return {
    fetchKline: async (_c, params) => ({
      code: 'sh600519', period: 'day', fq: 'qfq', prevClose: 99, bars: makeBars(params.count),
    }),
  };
}

test('series 返回 SERIES_LEN 根，各字段等长', async () => {
  const r = await collectIndicators('600519', {}, barDeps());
  const s = r.series;

  assert.equal(s.dates.length, SERIES_LEN);
  for (const key of ['close', 'dif', 'dea', 'macd', 'rsi6', 'rsi12', 'rsi24', 'k', 'd', 'j', 'up', 'mid', 'low']) {
    assert.equal(s[key].length, SERIES_LEN, `${key} 长度应与 dates 一致`);
  }
});

test('series 末位与标量字段同源，不会出现两套数', async () => {
  const r = await collectIndicators('600519', {}, barDeps());
  const s = r.series;
  const last = (a) => a[a.length - 1];

  assert.equal(last(s.dif), r.macd.dif);
  assert.equal(last(s.dea), r.macd.dea);
  assert.equal(last(s.macd), r.macd.macd);
  assert.equal(last(s.rsi6), r.rsi.rsi6);
  assert.equal(last(s.k), r.kdj.k);
  assert.equal(last(s.j), r.kdj.j);
  assert.equal(last(s.up), r.boll.up);
  assert.equal(last(s.close), r.close);
  assert.equal(last(s.dates), r.date);
});

test('series 取的是末尾 60 根而非开头', async () => {
  const r = await collectIndicators('600519', {}, barDeps());
  // makeBars 的 close = 100 + i，末根 = 100 + (barCount-1)
  assert.equal(r.series.close[r.series.close.length - 1], 100 + (r.barCount - 1));
  // 首位应是 barCount-60 那根，不是第 0 根
  assert.equal(r.series.close[0], 100 + (r.barCount - SERIES_LEN));
});

test('K 线不足 60 根时返回实际长度，不补 null 占位', async () => {
  const deps = {
    fetchKline: async () => ({
      code: 'sh600519', period: 'day', fq: 'qfq', prevClose: 99, bars: makeBars(25),
    }),
  };
  const r = await collectIndicators('600519', {}, deps);
  assert.equal(r.series.dates.length, 25);
  assert.equal(r.series.close.length, 25);
});

test('预热不足的前段在 series 里保留 null，不用 0 填充', async () => {
  const deps = {
    fetchKline: async () => ({
      code: 'sh600519', period: 'day', fq: 'qfq', prevClose: 99, bars: makeBars(30),
    }),
  };
  const r = await collectIndicators('600519', {}, deps);
  const s = r.series;

  // RSI/KDJ/BOLL 有明确的预热窗口，不足时给 null。
  // 0 会被画成贴零轴（或贴底）的假走势，绘制层必须能区分「没有值」和「值为 0」。
  assert.equal(s.rsi24[0], null, 'rsi24 预热不足应为 null');
  assert.equal(s.up[0], null, 'boll 上轨预热不足应为 null');
  assert.equal(s.k[0], null, 'kdj 预热不足应为 null');
  for (const key of ['rsi6', 'rsi12', 'rsi24', 'k', 'd', 'j', 'up', 'mid', 'low']) {
    assert.ok(
      s[key].some((v) => v === null),
      `${key} 在 30 根输入下应含 null`
    );
  }
});

test('MACD 前段不是 null 而是 EMA 种子值，绘制层不能当缺数据', async () => {
  const deps = {
    fetchKline: async () => ({
      code: 'sh600519', period: 'day', fq: 'qfq', prevClose: 99, bars: makeBars(30),
    }),
  };
  const r = await collectIndicators('600519', {}, deps);

  // ema 以 values[0] 为种子递推，不像 RSI 那样留 null 预热窗口。
  // 快慢线共用同一个种子，所以 dif[0] 恒为 0，dea[0] 也是 0 —— 这是真实的 0，
  // 不是缺数据。正常路径下预热 60 根，种子痕迹早已衰减，落不到可见的 60 根里。
  assert.equal(r.series.dif[0], 0, 'dif[0] 应为真实的 0（快慢线同种子）');
  assert.equal(
    r.series.dea.filter((v) => v === null).length,
    0,
    'MACD 三条序列没有 null 预热段'
  );
});

test('无 K 线数据时 series 各字段为空数组而非 undefined', async () => {
  const deps = {
    fetchKline: async () => ({ code: 'sh600519', period: 'day', fq: 'qfq', prevClose: 99, bars: [] }),
  };
  const r = await collectIndicators('600519', {}, deps);
  assert.deepEqual(r.series.dates, []);
  assert.deepEqual(r.series.dif, []);
  assert.deepEqual(r.series.close, []);
});

test('取数根数够画满 60 根子图（预热 + 序列）', async () => {
  let seen = 0;
  const deps = {
    fetchKline: async (_c, params) => {
      seen = params.count;
      return { code: 'sh600519', period: 'day', fq: 'qfq', prevClose: 99, bars: makeBars(params.count) };
    },
  };
  await collectIndicators('600519', {}, deps);
  assert.ok(seen >= MACD_WARMUP + SERIES_LEN, `应取至少 ${MACD_WARMUP + SERIES_LEN} 根，实得 ${seen}`);
});

// —— collectFlow ——

/** 造 n 天资金流，主力净额 = 大单 + 超大单（与真实口径一致） */
function makeFlowDays(n) {
  return Array.from({ length: n }, (_, i) => {
    const large = (i + 1) * 1e7;
    const huge = (i + 1) * 5e6;
    return {
      date: `2026-08-${String(i + 3).padStart(2, '0')}`,
      main: large + huge,
      small: -1e5,
      medium: -(large + huge) + 1e5,
      large,
      huge,
      mainPct: 1.5,
      close: 100 + i,
      changePct: 0.5,
    };
  });
}

test('collectFlow 返回 latest 与 mainSum', async () => {
  const deps = {
    fetchFlow: async () => ({ code: 'sh600519', name: '贵州茅台', days: makeFlowDays(5) }),
  };
  const r = await collectFlow('600519', { days: 5 }, deps);

  assert.equal(r.name, '贵州茅台');
  assert.equal(r.days.length, 5);
  assert.equal(r.latest.date, '2026-08-07', 'latest 应是最后一天');
  assert.equal(r.latest.consistent, true);
  // 1.5e7 + 3e7 + 4.5e7 + 6e7 + 7.5e7
  assert.equal(r.mainSum, makeFlowDays(5).reduce((s, d) => s + d.main, 0));
});

test('collectFlow 的 mainSum 跳过 null，不把缺数据当 0 累加', async () => {
  const days = makeFlowDays(3);
  days[1].main = null;
  const deps = { fetchFlow: async () => ({ code: 'sh600519', name: 'X', days }) };
  const r = await collectFlow('600519', {}, deps);
  assert.equal(r.mainSum, days[0].main + days[2].main);
  assert.ok(Number.isFinite(r.mainSum), 'null 参与运算会变 NaN，必须跳过');
});

test('collectFlow 空数据时 latest 为 null，mainSum 为 0', async () => {
  const deps = { fetchFlow: async () => ({ code: 'sh600519', name: '', days: [] }) };
  const r = await collectFlow('600519', {}, deps);
  assert.equal(r.latest, null);
  assert.equal(r.mainSum, 0);
  assert.deepEqual(r.days, []);
});

test('collectFlow 上游返回 null 时不抛错', async () => {
  const deps = { fetchFlow: async () => null };
  const r = await collectFlow('600519', {}, deps);
  assert.equal(r.latest, null);
  assert.equal(r.name, '');
  assert.deepEqual(r.days, []);
});

test('collectFlow 透传 days 参数', async () => {
  let seen = null;
  const deps = {
    fetchFlow: async (_c, params) => {
      seen = params;
      return { code: 'sh600519', name: 'X', days: makeFlowDays(2) };
    },
  };
  await collectFlow('600519', { days: 10 }, deps);
  assert.equal(seen.days, 10);
});

test('collectFlow 归一化代码后再请求', async () => {
  let seen = '';
  const deps = {
    fetchFlow: async (code) => {
      seen = code;
      return { code, name: 'X', days: [] };
    },
  };
  const r = await collectFlow('600519', {}, deps);
  assert.equal(seen, 'sh600519', '应补上交易所前缀');
  assert.equal(r.code, 'sh600519');
});

test('collectFlow 非法代码抛出可读错误', async () => {
  await assert.rejects(() => collectFlow('%%%', {}, {}), /代码/);
});

// —— 60 分钟 K 线 ——
//
// 走东财而非腾讯，且服务端硬顶 126 根。日 K 那套「多取预热根」的做法在这里
// 会顶到上限，所以请求量必须夹住，否则接口只回 126 根却按更多根去切窗。

/** 造 n 根 60 分钟 K，date 带时间部分 */
function bars60(n) {
  const out = [];
  const slots = ['10:30', '11:30', '14:00', '15:00'];
  for (let i = 0; i < n; i += 1) {
    const day = 3 + Math.floor(i / 4);
    out.push({
      date: `2026-08-${String(day).padStart(2, '0')} ${slots[i % 4]}`,
      open: 1300 + i,
      close: 1301 + i,
      high: 1305 + i,
      low: 1299 + i,
      volume: 1000 + i,
    });
  }
  return out;
}

test('collectKline：period=60min 走 fetchKline60，不碰腾讯那路', async () => {
  let tencentCalled = false;
  let emParams = null;
  const deps = {
    fetchKline: async () => {
      tencentCalled = true;
      return { bars: [], prevClose: null };
    },
    fetchKline60: async (_code, params) => {
      emParams = params;
      return { code: 'sh600519', period: '60min', fq: 'qfq', prevClose: 1306.45, bars: bars60(60) };
    },
  };

  const r = await collectKline('600519', { period: PERIOD_60MIN, count: 48 }, deps);
  assert.equal(tencentCalled, false, '60 分钟不该走腾讯 K 线接口');
  assert.ok(emParams, '应调用 fetchKline60');
  assert.equal(r.period, '60min');
});

test('collectKline：60min 的请求根数夹到接口硬顶 126', async () => {
  // 可见 48 + 预热 20 = 68，不到上限，原样请求
  let asked = 0;
  const deps = {
    fetchKline60: async (_c, p) => {
      asked = p.count;
      return { period: '60min', bars: bars60(68), prevClose: null };
    },
  };
  await collectKline('600519', { period: PERIOD_60MIN, count: 48 }, deps);
  assert.equal(asked, 48 + MA_WARMUP);

  // 可见 120 + 预热 20 = 140 > 126，必须夹住：多要也只回 126 根
  await collectKline('600519', { period: PERIOD_60MIN, count: 120 }, deps);
  assert.equal(asked, emKlineClient.MAX_BARS);
});

test('collectKline：60min 也照常算均线，date 带时间不影响', async () => {
  const deps = {
    fetchKline60: async () => ({ period: '60min', bars: bars60(40), prevClose: 1300 }),
  };
  const r = await collectKline('600519', { period: PERIOD_60MIN, count: 20 }, deps);
  const last = r.bars[r.bars.length - 1];
  assert.ok(Number.isFinite(last.ma5), 'MA5 应算出来');
  assert.ok(Number.isFinite(last.ma20), 'MA20 应算出来');
  // 前 4 根不足 5 根，MA5 必须是 null 而不是 0
  assert.equal(r.bars[3].ma5, null);
});

test('collectKline：60min 数据不足时 visibleCount 按实际给，不越界', async () => {
  const deps = {
    fetchKline60: async () => ({ period: '60min', bars: bars60(10), prevClose: 1300 }),
  };
  const r = await collectKline('600519', { period: PERIOD_60MIN, count: 48 }, deps);
  assert.equal(r.bars.length, 10);
  assert.equal(r.visibleFrom, 0, '不足一屏时从头画');
  assert.equal(r.visibleCount, 10, '不能报 48，否则渲染层会切过数组末尾');
});

test('collectKline：60min 无数据（代码不存在）时给空 bars 而不抛错', async () => {
  const deps = {
    fetchKline60: async () => ({ period: '60min', bars: [], prevClose: null }),
  };
  const r = await collectKline('600519', { period: PERIOD_60MIN }, deps);
  assert.deepEqual(r.bars, []);
  assert.equal(r.visibleCount, 0);
});

test('collectKline：日/周 K 仍走腾讯，不受 60min 分支影响', async () => {
  let em60Called = false;
  const deps = {
    fetchKline: async (_c, p) => ({ period: p.period, bars: [], prevClose: null }),
    fetchKline60: async () => {
      em60Called = true;
      return { period: '60min', bars: [] };
    },
  };
  await collectKline('600519', { period: 'day', count: 90 }, deps);
  await collectKline('600519', { period: 'week', count: 26 }, deps);
  assert.equal(em60Called, false);
});

// —— 交易日历接入 collectDetail ——

test('collectDetail：日历说不开市 → isHoliday 为真，phaseSource 标 calendar', async () => {
  const deps = {
    fetchQuotes: async () => new Map([['sh600519', quote()]]),
    fetchMinuteLine: async () => ({ date: '', prevClose: null, points: [] }),
  };
  const calendar = { isTradingDay: async () => false };
  const r = await collectDetail('600519', deps, null, calendar);
  assert.equal(r.isHoliday, true);
  assert.equal(r.phaseLabel, '休市');
  assert.equal(r.phaseSource, 'calendar');
});

test('collectDetail：不传日历时行为与接入前一致', async () => {
  const deps = {
    fetchQuotes: async () => new Map([['sh600519', quote()]]),
    fetchMinuteLine: async () => ({ date: '', prevClose: null, points: [] }),
  };
  const r = await collectDetail('600519', deps, null, null);
  assert.equal(typeof r.phase, 'string');
  assert.ok(r.phase.length > 0);
  assert.equal(typeof r.isHoliday, 'boolean');
});

test('collectDetail：日历查询抛错不影响行情展示', async () => {
  const deps = {
    fetchQuotes: async () => new Map([['sh600519', quote()]]),
    fetchMinuteLine: async () => ({ date: '', prevClose: null, points: [] }),
  };
  const calendar = {
    isTradingDay: async () => {
      throw new Error('深交所接口挂了');
    },
  };
  const r = await collectDetail('600519', deps, null, calendar);
  assert.equal(r.quote.price, 1301.5, '行情数字照常返回');
  assert.notEqual(r.phaseSource, 'calendar', '日历失败就不该采信它');
});

// —— 研报 ——

test('collectReports：股票正常返回，带评级分布', async () => {
  const deps = {
    fetchReports: async (digits) => {
      assert.equal(digits, '600519', '要传 6 位代码，接口不吃前缀');
      return {
        digits,
        items: [{ title: 'A', rating: '买入', date: '2026-07-23' }],
        total: 114,
        summary: { counts: [['买入', 1]], top: '买入', total: 1 },
      };
    },
  };
  const r = await collectReports('600519', {}, deps);
  assert.equal(r.supported, true);
  assert.equal(r.items.length, 1);
  assert.equal(r.total, 114);
  assert.equal(r.summary.top, '买入');
});

test('collectReports：基金与指数直接返回 supported:false，不发请求', async () => {
  // 实测 ETF 返回 hits=0，白发一次请求不如省掉
  let called = false;
  const deps = {
    fetchReports: async () => {
      called = true;
      return { items: [], total: 0, summary: { counts: [], top: '', total: 0 } };
    },
  };
  for (const code of ['510300', 'sh000001']) {
    const r = await collectReports(code, {}, deps);
    assert.equal(r.supported, false, `${code} 不该支持研报`);
    assert.deepEqual(r.items, []);
  }
  assert.equal(called, false, '不该发请求');
});

// —— 融资融券 ——

test('collectMargin：股票正常返回', async () => {
  const deps = {
    fetchMargin: async (code) => {
      assert.equal(code, 'sh600519');
      return {
        code,
        name: '贵州茅台',
        days: [{ date: '2026-08-07', finBalance: 17544302364, finNet: 17663935 }],
        latest: { date: '2026-08-07', finBalance: 17544302364, finNet: 17663935 },
        finNetSum: 17663935,
      };
    },
  };
  const r = await collectMargin('600519', {}, deps);
  assert.equal(r.supported, true);
  assert.equal(r.latest.finBalance, 17544302364);
  assert.equal(r.finNetSum, 17663935);
});

test('collectMargin：指数直接返回 supported:false，不发请求', async () => {
  let called = false;
  const deps = {
    fetchMargin: async () => {
      called = true;
      return { days: [], latest: null, finNetSum: 0 };
    },
  };
  const r = await collectMargin('sh000001', {}, deps);
  assert.equal(r.supported, false);
  assert.equal(called, false);
});

test('collectMargin：ETF 仍要发请求——它可能是两融标的', async () => {
  // 实测 510300 有两融数据，不能按 kind 预先排除
  let called = false;
  const deps = {
    fetchMargin: async () => {
      called = true;
      return {
        days: [{ date: '2026-08-07', finBalance: 2808681697 }],
        latest: { finBalance: 2808681697 },
        finNetSum: 0,
      };
    },
  };
  const r = await collectMargin('510300', {}, deps);
  assert.equal(called, true, 'ETF 不该被跳过');
  assert.equal(r.supported, true);
});

test('collectMargin：非两融标的返回空 days（不是错误）', async () => {
  const deps = { fetchMargin: async () => ({ days: [], latest: null, finNetSum: 0 }) };
  const r = await collectMargin('002913', {}, deps);
  assert.equal(r.supported, true, '发过请求就算 supported，只是没数据');
  assert.deepEqual(r.days, []);
  assert.equal(r.latest, null);
});

// —— 财务指标 ——

test('collectFinance：股票正常返回', async () => {
  const deps = {
    fetchFinance: async (code) => {
      assert.equal(code, 'sh600519');
      return {
        code,
        periods: [{ reportDate: '2026-03-31', reportName: '2026一季报', eps: 21.76, roe: 10.57 }],
        latest: { reportDate: '2026-03-31', reportName: '2026一季报', eps: 21.76, roe: 10.57 },
      };
    },
  };
  const r = await collectFinance('600519', {}, deps);
  assert.equal(r.supported, true);
  assert.equal(r.latest.eps, 21.76);
});

test('collectFinance：基金与指数不发请求（实测返回 9201）', async () => {
  let called = false;
  const deps = {
    fetchFinance: async () => {
      called = true;
      return { periods: [], latest: null };
    },
  };
  for (const code of ['510300', 'sh000001']) {
    const r = await collectFinance(code, {}, deps);
    assert.equal(r.supported, false);
  }
  assert.equal(called, false);
});

// —— 龙虎榜 ——

test('collectLhb：股票正常返回，带新鲜度', async () => {
  const deps = {
    fetchLhb: async (code) => {
      assert.equal(code, 'sz002913');
      return {
        code,
        items: [{ date: '2026-08-07', netAmount: -39650924.93 }],
        latest: { date: '2026-08-07', netAmount: -39650924.93 },
        isRecent: true,
        daysSince: 3,
        total: 13,
      };
    },
  };
  const r = await collectLhb('002913', {}, deps);
  assert.equal(r.supported, true);
  assert.equal(r.isRecent, true);
  assert.equal(r.daysSince, 3);
  assert.equal(r.total, 13);
});

test('collectLhb：陈年记录 isRecent 透传为假', async () => {
  const deps = {
    fetchLhb: async () => ({
      items: [{ date: '2013-01-28' }],
      latest: { date: '2013-01-28' },
      isRecent: false,
      daysSince: 4943,
      total: 1,
    }),
  };
  const r = await collectLhb('600519', {}, deps);
  assert.equal(r.isRecent, false, 'UI 靠这个决定摘要说不说话');
  assert.equal(r.items.length, 1, '记录仍要返回');
});

test('collectLhb：基金与指数不发请求', async () => {
  let called = false;
  const deps = {
    fetchLhb: async () => {
      called = true;
      return { items: [], latest: null, isRecent: false, daysSince: null, total: 0 };
    },
  };
  for (const code of ['510300', 'sh000001']) {
    const r = await collectLhb(code, {}, deps);
    assert.equal(r.supported, false);
    assert.equal(r.isRecent, false);
  }
  assert.equal(called, false);
});

test('新增的四个 collect 都对非法代码抛错', async () => {
  for (const fn of [collectMargin, collectFinance, collectLhb, collectReports]) {
    await assert.rejects(() => fn('%%%', {}, {}), /代码/, `${fn.name} 应校验代码`);
  }
});
