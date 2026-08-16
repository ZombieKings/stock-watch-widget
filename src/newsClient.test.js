'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const {
  parseSinaNewsPage,
  stripHtml,
  normalizeAnnTime,
  fetchStockNews,
  fetchStockNewsEm,
  fetchStockNewsWithFallback,
  parseEmSearchNews,
  buildSearchParam,
  fetchAnnouncements,
} = require('./newsClient');

/** 真实抓取的新浪个股新闻页片段（贵州茅台，2026-08-06） */
const REAL_HTML = `
<html><body>
  <div class="nav"><a href="http://finance.sina.com.cn/">财经首页</a></div>
  <div class="datelist"><ul>
    &nbsp;&nbsp;&nbsp;&nbsp;2026-08-06&nbsp;07:59&nbsp;&nbsp;<a target='_blank' href='https://finance.sina.com.cn/stock/aiassist/lr/2026-08-06/doc-a.shtml'>贵州茅台：8月5日获融资买入4.82亿元</a> <br>
    &nbsp;&nbsp;&nbsp;&nbsp;2026-08-05&nbsp;21:58&nbsp;&nbsp;<a target='_blank' href='https://finance.sina.com.cn/wm/2026-08-05/doc-b.shtml'>段永平点评茅台：供需持续紧俏，价格 &ldquo;小步慢跑&rdquo;较好</a> <br>
    &nbsp;&nbsp;&nbsp;&nbsp;2026-08-05&nbsp;20:03&nbsp;&nbsp;<a target='_blank' href='https://finance.sina.com.cn/stock/relnews/cn/2026-08-05/doc-c.shtml'>三项白酒质量要求相关标准发布</a> <br>
  </ul></div>
  <div class="footer"><a href="http://ad.sina.com.cn/">广告</a></div>
</body></html>`;

test('解析新浪新闻页，抓到日期时间标题链接', () => {
  const items = parseSinaNewsPage(REAL_HTML);
  assert.equal(items.length, 3);

  assert.deepEqual(items[0], {
    date: '2026-08-06',
    time: '07:59',
    datetime: '2026-08-06 07:59',
    title: '贵州茅台：8月5日获融资买入4.82亿元',
    url: 'https://finance.sina.com.cn/stock/aiassist/lr/2026-08-06/doc-a.shtml',
  });
  assert.equal(items[1].title, '段永平点评茅台：供需持续紧俏，价格 “小步慢跑”较好');
  assert.equal(items[2].date, '2026-08-05');
});

test('只抓 datelist 区块，不把导航/广告链接当新闻', () => {
  const items = parseSinaNewsPage(REAL_HTML);
  assert.ok(items.every((it) => !it.title.includes('财经首页')));
  assert.ok(items.every((it) => !it.title.includes('广告')));
});

test('页面结构异常时返回空数组，不抛错', () => {
  assert.deepEqual(parseSinaNewsPage(''), []);
  assert.deepEqual(parseSinaNewsPage(null), []);
  assert.deepEqual(parseSinaNewsPage('<html><body>no datelist here</body></html>'), []);
});

test('标题里嵌套标签被清理', () => {
  const html = `<div class="datelist"><ul>2026-08-06&nbsp;10:00&nbsp;&nbsp;<a href='http://x.com/1'>茅台<em>大涨</em>了</a></ul></div>`;
  const items = parseSinaNewsPage(html);
  assert.equal(items[0].title, '茅台大涨了');
});

test('stripHtml 清理标签与实体', () => {
  assert.equal(stripHtml('<b>茅台</b>&nbsp;涨了'), '茅台 涨了');
  assert.equal(stripHtml('a&amp;b &lt;tag&gt; &quot;q&quot;'), 'a&b <tag> "q"');
  assert.equal(stripHtml('  多   空格  '), '多 空格');
  assert.equal(stripHtml(null), '');
});

test('stripHtml 还原中文引号与破折号（新浪标题常见）', () => {
  assert.equal(stripHtml('价格 &ldquo;小步慢跑&rdquo;较好'), '价格 “小步慢跑”较好');
  assert.equal(stripHtml('营收&mdash;利润&hellip;'), '营收—利润…');
  assert.equal(stripHtml('A&middot;B'), 'A·B');
});

test('stripHtml 还原数字实体，未知命名实体不留残渣', () => {
  assert.equal(stripHtml('&#20013;&#22269;'), '中国');
  assert.equal(stripHtml('&#x4e2d;&#x56fd;'), '中国');
  assert.equal(stripHtml('前&zzz;后'), '前后');
});

test('东财公告时间戳截到分钟', () => {
  const r = normalizeAnnTime('2026-07-17 21:26:22:243');
  assert.deepEqual(r, { date: '2026-07-17', time: '21:26', datetime: '2026-07-17 21:26' });
});

test('公告时间格式异常时保留原串，不产出 undefined', () => {
  const r = normalizeAnnTime('not-a-date');
  assert.equal(r.date, '');
  assert.equal(r.datetime, 'not-a-date');
});

/**
 * 假 fetch。body 可以是字符串（按 UTF-8 编码）或 Buffer（原样返回）。
 * 新浪返回 GBK，故涉及中文的用例要传 GBK 字节，才能真正走通解码路径。
 */
function fakeFetch(body, calls = []) {
  return async (url) => {
    const payload = typeof body === 'function' ? body(url) : body;
    calls.push(url);
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      arrayBuffer: async () => (Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'utf8')),
    };
  };
}

/** 常用词的 GBK 字节（由 iconv 实测得出），用于拼装 GBK 响应体 */
const GBK_HEX = {
  新闻: 'd0c2cec5',
  旧闻: 'bec9cec5',
  贵州茅台: 'b9f3d6ddc3a9cca8',
};

/** 模板拼装：ASCII 部分按 latin1，中文部分查 GBK 字节表 */
function gbk(strings, ...values) {
  const parts = [];
  strings.forEach((s, i) => {
    parts.push(Buffer.from(s, 'latin1'));
    if (i < values.length) {
      const hex = GBK_HEX[values[i]];
      if (!hex) throw new Error(`GBK_HEX 缺少词条: ${values[i]}`);
      parts.push(Buffer.from(hex, 'hex'));
    }
  });
  return Buffer.concat(parts);
}

test('fetchStockNews 解码 GBK 响应并按时间倒序返回', async () => {
  // 故意给乱序输入，验证排序生效；中文用 GBK 字节，验证解码
  const html = gbk`<div class="datelist"><ul>
    2026-08-04&nbsp;09:00&nbsp;&nbsp;<a href='http://x.com/old'>${'旧闻'}</a><br>
    2026-08-06&nbsp;07:59&nbsp;&nbsp;<a href='http://x.com/new'>${'新闻'}</a><br>
  </ul></div>`;
  const items = await fetchStockNews('sh600519', { fetchImpl: fakeFetch(html) });
  assert.equal(items.length, 2);
  assert.equal(items[0].title, '新闻'); // GBK 正确解码 + 排序正确
  assert.equal(items[1].title, '旧闻');
});

test('fetchStockNews 请求 URL 带上完整代码', async () => {
  const calls = [];
  await fetchStockNews('sh600519', { fetchImpl: fakeFetch(REAL_HTML, calls) });
  assert.ok(calls[0].includes('sh600519.phtml'));
});

test('fetchAnnouncements 解析东财响应并拼出详情链接', async () => {
  const payload = {
    data: {
      list: [
        {
          art_code: 'AN202607171827064564',
          display_time: '2026-07-17 21:26:22:243',
          title: '贵州茅台:2026年半年度报告',
        },
      ],
    },
  };
  const items = await fetchAnnouncements('600519', { fetchImpl: fakeFetch(JSON.stringify(payload)) });
  assert.equal(items.length, 1);
  assert.equal(items[0].title, '贵州茅台:2026年半年度报告');
  assert.equal(items[0].date, '2026-07-17');
  assert.equal(items[0].isAnnouncement, true);
  assert.ok(items[0].url.includes('AN202607171827064564'));
});

test('fetchAnnouncements 遇到空/异常响应返回空数组', async () => {
  assert.deepEqual(await fetchAnnouncements('600519', { fetchImpl: fakeFetch('{}') }), []);
  assert.deepEqual(await fetchAnnouncements('600519', { fetchImpl: fakeFetch('{"data":{"list":null}}') }), []);
});

// —— 基金公告的 ann_type ——
//
// 实测：ETF 510300 与 LOF 161725 用 ann_type=A 都返回 0 条，
// 必须换成 FUND 才拿到基金季报、高管变更等公告。'F'/'ETF'/'ALL' 均无效。

test('fetchAnnouncements 股票用 ann_type=A', async () => {
  const calls = [];
  await fetchAnnouncements('600519', { fetchImpl: fakeFetch('{}', calls) });
  assert.ok(calls[0].includes('ann_type=A'), `实际 URL: ${calls[0]}`);
  assert.ok(!calls[0].includes('ann_type=FUND'));
});

test('fetchAnnouncements 基金用 ann_type=FUND', async () => {
  const calls = [];
  await fetchAnnouncements('510300', { kind: 'fund', fetchImpl: fakeFetch('{}', calls) });
  assert.ok(calls[0].includes('ann_type=FUND'), `实际 URL: ${calls[0]}`);
});

test('fetchAnnouncements kind 缺省或未知时回落到 A', async () => {
  for (const kind of [undefined, 'stock', 'index', 'weird']) {
    const calls = [];
    await fetchAnnouncements('600519', { kind, fetchImpl: fakeFetch('{}', calls) });
    assert.ok(calls[0].includes('ann_type=A'), `kind=${kind} 应用 A`);
  }
});

test('fetchAnnouncements 基金公告照常解析出条目', async () => {
  const payload = {
    data: {
      list: [
        {
          art_code: 'AN202607301900123456',
          display_time: '2026-07-30 19:00:11:100',
          title: '招商中证白酒指数证券投资基金2026年第2季度报告',
        },
      ],
    },
  };
  const items = await fetchAnnouncements('161725', {
    kind: 'fund',
    fetchImpl: fakeFetch(JSON.stringify(payload)),
  });
  assert.equal(items.length, 1);
  assert.match(items[0].title, /第2季度报告/);
  assert.equal(items[0].isAnnouncement, true);
  assert.ok(items[0].url.includes('161725'));
});

// —— 东财搜索（新浪的备份源）——
//
// 新浪那路是解析网页 HTML，页面改版会静默失效（拿到 0 条而非报错），
// 是整个项目最脆的一环。这组测试盯住备份源本身与回落时机。

/** 东财搜索接口的真实响应片段（600519，2026-08-08） */
const REAL_EM_SEARCH = {
  code: 0,
  msg: 'OK',
  result: {
    cmsArticleWebOld: [
      {
        date: '2026-08-08 15:53:07',
        image: '',
        code: '202608083835835634',
        title: '茅台又涨价了！自营店多款产品调价，飞天茅台涨至1753元/瓶',
        content: '据了解，7月17日，贵州茅台（600519.SH）曾发布公告称…',
        mediaName: '红星资本局',
        url: 'http://finance.eastmoney.com/a/202608083835835634.html',
      },
      {
        date: '2026-08-03 18:43:00',
        code: '202608033829918487',
        title: '8只个股大宗交易超5000万元',
        content: '成交量（万股） 成交额（万元）…',
        mediaName: '证券时报网',
        url: 'http://finance.eastmoney.com/a/202608033829918487.html',
      },
    ],
  },
  hitsTotal: 556,
};

test('parseEmSearchNews：解析真实响应，时间截到分钟与新浪对齐', () => {
  const items = parseEmSearchNews(REAL_EM_SEARCH);
  assert.equal(items.length, 2);
  const first = items[0];
  assert.equal(first.date, '2026-08-08');
  assert.equal(first.time, '15:53', '秒要截掉——两个源的条目会进同一个排序去重');
  assert.equal(first.datetime, '2026-08-08 15:53');
  assert.match(first.title, /茅台又涨价了/);
  assert.equal(first.media, '红星资本局');
  assert.equal(first.source, 'eastmoney', '标出来源，便于 UI 区分');
});

test('parseEmSearchNews：按时间倒序', () => {
  const items = parseEmSearchNews(REAL_EM_SEARCH);
  for (let i = 1; i < items.length; i += 1) {
    assert.ok(items[i - 1].datetime >= items[i].datetime, '必须倒序');
  }
});

test('parseEmSearchNews：条目形状与新浪那路一致（date/time/datetime/title/url）', () => {
  // 两个源的结果要进同一个 mergeNewsItems，字段缺一个就会在排序或去重时出错
  const em = parseEmSearchNews(REAL_EM_SEARCH)[0];
  const sina = parseSinaNewsPage(REAL_HTML)[0];
  for (const key of ['date', 'time', 'datetime', 'title', 'url']) {
    assert.equal(typeof em[key], typeof sina[key], `${key} 类型应一致`);
  }
});

test('parseEmSearchNews：剥掉 <em> 高亮标签', () => {
  const json = {
    result: {
      cmsArticleWebOld: [
        { date: '2026-08-08 15:53:07', title: '茅台涨至<em>1</em>7<em>5</em>3元', url: 'http://x' },
      ],
    },
  };
  assert.equal(parseEmSearchNews(json)[0].title, '茅台涨至1753元');
});

test('parseEmSearchNews：空响应与畸形响应给空数组', () => {
  for (const bad of [{}, { result: {} }, { result: { cmsArticleWebOld: null } }, null, undefined]) {
    assert.deepEqual(parseEmSearchNews(bad), []);
  }
});

test('parseEmSearchNews：跳过无标题或日期格式不对的条目', () => {
  const json = {
    result: {
      cmsArticleWebOld: [
        { date: '2026-08-08 15:53:07', title: '', url: 'http://a' },
        { date: '坏日期', title: '有标题', url: 'http://b' },
        { date: '2026-08-08 10:00:00', title: '正常', url: 'http://c' },
      ],
    },
  };
  const items = parseEmSearchNews(json);
  assert.equal(items.length, 1);
  assert.equal(items[0].title, '正常');
});

test('buildSearchParam：只请求资讯类型，preTag/postTag 给空串', () => {
  const p = JSON.parse(buildSearchParam('600519', 20));
  assert.deepEqual(p.type, ['cmsArticleWebOld'], '只要资讯，不要股票/基金的命中');
  assert.equal(p.keyword, '600519');
  assert.equal(p.param.cmsArticleWebOld.pageSize, 20);
  // 给空串免去后续剥 <em> 标签
  assert.equal(p.param.cmsArticleWebOld.preTag, '');
  assert.equal(p.param.cmsArticleWebOld.postTag, '');
});

test('fetchStockNewsEm：拒绝带前缀的代码', async () => {
  let called = false;
  const spy = async () => {
    called = true;
  };
  await assert.rejects(() => fetchStockNewsEm('sh600519', { fetchImpl: spy }), /需要 6 位代码/);
  assert.equal(called, false);
});

test('fetchStockNewsEm：带 Referer 且 param 是 URL 编码的 JSON', async () => {
  const calls = [];
  await fetchStockNewsEm('600519', {
    fetchImpl: fakeFetch(JSON.stringify(REAL_EM_SEARCH), calls),
  });
  assert.match(calls[0], /search-api-web\.eastmoney\.com/);
  assert.match(decodeURIComponent(calls[0]), /"keyword":"600519"/);
});

// —— 回落逻辑 ——

test('fetchStockNewsWithFallback：新浪有数据时不碰东财', async () => {
  let emCalled = false;
  const r = await fetchStockNewsWithFallback('sh600519', '600519', {
    fetchImpl: async (url) => {
      if (url.includes('eastmoney')) emCalled = true;
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () => Buffer.from(REAL_HTML, 'utf8'),
      };
    },
  });
  assert.ok(r.items.length > 0);
  assert.equal(r.source, 'sina');
  assert.equal(r.warning, '');
  assert.equal(emCalled, false, '主源正常就不该打备份源');
});

test('fetchStockNewsWithFallback：新浪抛错 → 走东财，warning 说明原因', async () => {
  const r = await fetchStockNewsWithFallback('sh600519', '600519', {
    fetchImpl: async (url) => {
      if (url.includes('sina')) throw new Error('HTTP 403');
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () => Buffer.from(JSON.stringify(REAL_EM_SEARCH), 'utf8'),
      };
    },
  });
  assert.equal(r.source, 'eastmoney');
  assert.equal(r.items.length, 2);
  assert.match(r.warning, /403/, '要说清主源为何失败');
});

test('fetchStockNewsWithFallback：新浪返回 0 条也要回落——改版时不会报错只会空', async () => {
  // 这是最需要兜底的那种失败：只判异常会漏掉它
  const r = await fetchStockNewsWithFallback('sh600519', '600519', {
    fetchImpl: async (url) => {
      const body = url.includes('sina')
        ? '<html><body>页面改版了，没有 datelist</body></html>'
        : JSON.stringify(REAL_EM_SEARCH);
      return { ok: true, status: 200, arrayBuffer: async () => Buffer.from(body, 'utf8') };
    },
  });
  assert.equal(r.source, 'eastmoney');
  assert.equal(r.items.length, 2);
  assert.match(r.warning, /0 条/);
});

test('fetchStockNewsWithFallback：两个源都失败时给空 items 且不抛错', async () => {
  const r = await fetchStockNewsWithFallback('sh600519', '600519', {
    fetchImpl: async () => {
      throw new Error('网络不可达');
    },
  });
  assert.deepEqual(r.items, []);
  assert.equal(r.source, '');
  assert.match(r.warning, /网络不可达/);
});

test('fetchStockNewsWithFallback：两个源都返回空时 warning 提到两者', async () => {
  const r = await fetchStockNewsWithFallback('sh600519', '600519', {
    fetchImpl: async (url) => {
      const body = url.includes('sina') ? '<html></html>' : JSON.stringify({ result: {} });
      return { ok: true, status: 200, arrayBuffer: async () => Buffer.from(body, 'utf8') };
    },
  });
  assert.deepEqual(r.items, []);
  assert.match(r.warning, /新浪/);
  assert.match(r.warning, /东财/);
});

test('fetchStockNewsWithFallback：digits 非法时新浪成功仍能返回', async () => {
  // 主源不需要 digits，它只用 code —— 备份源参数不对不该拖累主源
  const r = await fetchStockNewsWithFallback('sh600519', '', {
    fetchImpl: fakeFetch(REAL_HTML),
  });
  assert.equal(r.source, 'sina');
  assert.ok(r.items.length > 0);
});
