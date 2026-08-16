'use strict';

/**
 * 个股新闻与公告客户端。
 *
 * 新闻：新浪财经个股新闻页（GB18030 网页，抓 .datelist 区块）
 *   https://vip.stock.finance.sina.com.cn/corp/go.php/vCB_AllNewsStock/symbol/sh600519.phtml
 *   该页天然按个股过滤，返回近一个月条目，形如：
 *     2026-08-06 07:59  <a href='...'>贵州茅台：8月5日获融资买入…</a><br>
 *
 * 新闻备份源：东方财富搜索接口（JSON）
 *   https://search-api-web.eastmoney.com/search/jsonp?param=<URL 编码的 JSON>
 *   新浪那路是**解析网页 HTML**，页面改版就会静默失效（拿到 0 条而非报错），
 *   这是整个项目最脆的一环。东财这路是结构化 JSON，作为回落更稳。
 *   只在新浪失败或返回空时才用，不并行请求 —— 新浪按个股过滤更干净，
 *   东财是全文搜索，代码出现在「8只个股大宗交易超5000万元」这类汇总文里也会命中。
 *
 * 公告：东方财富公告接口（JSON）
 *   https://np-anotice-stock.eastmoney.com/api/security/ann?...&stock_list=600519
 */

const { fetchText, fetchJson } = require('./http');

const SINA_NEWS_URL = 'https://vip.stock.finance.sina.com.cn/corp/go.php/vCB_AllNewsStock/symbol/';
const EM_ANN_URL = 'https://np-anotice-stock.eastmoney.com/api/security/ann';
const EM_SEARCH_URL = 'https://search-api-web.eastmoney.com/search/jsonp';

/**
 * 命名实体表。新浪标题里中文引号是 `&ldquo;/&rdquo;`、破折号是 `&mdash;`，
 * 不还原会在 UI 里露出裸实体名。
 */
const ENTITIES = {
  nbsp: ' ',
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  ldquo: '“',
  rdquo: '”',
  lsquo: '‘',
  rsquo: '’',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  middot: '·',
  times: '×',
  permil: '‰',
  yen: '¥',
  deg: '°',
};

/** HTML 实体与标签清理 */
function stripHtml(s) {
  return String(s == null ? '' : s)
    .replace(/<[^>]*>/g, '')
    // 命名实体：查表，未收录的整体去掉，避免残留 &xxx;
    .replace(/&([a-zA-Z]+);/g, (match, name) => {
      const key = name.toLowerCase();
      return Object.prototype.hasOwnProperty.call(ENTITIES, key) ? ENTITIES[key] : '';
    })
    // 数字实体：十进制与十六进制都还原
    .replace(/&#(\d+);/g, (_m, code) => safeCodePoint(Number(code)))
    .replace(/&#[xX]([0-9a-fA-F]+);/g, (_m, hex) => safeCodePoint(parseInt(hex, 16)))
    .replace(/\s+/g, ' ')
    .trim();
}

/** 码点转字符；越界码点丢弃而不是抛 RangeError */
function safeCodePoint(code) {
  if (!Number.isInteger(code) || code < 0 || code > 0x10ffff) return '';
  try {
    return String.fromCodePoint(code);
  } catch {
    return '';
  }
}

/**
 * 解析新浪个股新闻页的 .datelist 区块。
 *
 * 逐条匹配「日期 + 时间 + <a> 链接」三元组。页面用 &nbsp; 做缩进和分隔，
 * 所以不能按空白切分，只能靠日期时间的正则锚点。
 *
 * @returns {Array<{ date: string, time: string, datetime: string, title: string, url: string }>}
 */
function parseSinaNewsPage(html) {
  const text = String(html == null ? '' : html);

  // 缩小到 datelist 区块，避免抓到导航栏和推广位的链接
  const start = text.indexOf('datelist');
  const region = start >= 0 ? text.slice(start) : text;
  const end = region.indexOf('</div>');
  const block = end >= 0 ? region.slice(0, end) : region;

  const items = [];
  // (\d{4}-\d{2}-\d{2}) &nbsp; (\d{2}:\d{2}) &nbsp;&nbsp; <a ... href='URL' ...>TITLE</a>
  const re = /(\d{4}-\d{2}-\d{2})(?:&nbsp;|\s)+(\d{2}:\d{2})(?:&nbsp;|\s)*<a[^>]*href=['"]([^'"]+)['"][^>]*>([\s\S]*?)<\/a>/g;

  let m;
  while ((m = re.exec(block)) !== null) {
    const [, date, time, url, rawTitle] = m;
    const title = stripHtml(rawTitle);
    if (!title) continue;
    items.push({ date, time, datetime: `${date} ${time}`, title, url: url.trim() });
  }
  return items;
}

/**
 * 拉个股新闻。
 * @param {string} code 形如 sh600519
 * @returns {Promise<Array>} 按时间倒序（新浪原始顺序已是倒序，此处再兜一次）
 */
async function fetchStockNews(code, opts = {}) {
  const url = `${SINA_NEWS_URL}${encodeURIComponent(code)}.phtml`;
  const html = await fetchText(url, {
    ...opts,
    encoding: 'gbk',
    headers: { Referer: 'https://finance.sina.com.cn/', ...(opts.headers || {}) },
  });
  const items = parseSinaNewsPage(html);
  return items.sort((a, b) => (a.datetime < b.datetime ? 1 : a.datetime > b.datetime ? -1 : 0));
}

/**
 * 东财搜索接口的 param 是一段 URL 编码的 JSON，字段名不能省。
 * @param {string} keyword 一般传 6 位代码
 * @param {number} pageSize
 */
function buildSearchParam(keyword, pageSize) {
  return JSON.stringify({
    uid: '',
    keyword: String(keyword),
    // 只要资讯，不要股票/基金等其它类型的命中
    type: ['cmsArticleWebOld'],
    client: 'web',
    clientVersion: 'curr',
    clientType: 'web',
    param: {
      cmsArticleWebOld: {
        searchScope: 'default',
        sort: 'default',
        pageIndex: 1,
        pageSize,
        // 接口会把命中的关键词用这两个标签包起来，给空串免去后续剥标签
        preTag: '',
        postTag: '',
      },
    },
  });
}

/**
 * 拉个股新闻（东方财富搜索，新浪的备份源）。
 *
 * 用途见文件头注释：新浪那路是解析网页，最容易因改版静默失效。
 *
 * 注意这是**全文搜索**而非按个股过滤：代码出现在汇总类文章里也会命中
 * （已见「8只个股大宗交易超5000万元」这种）。因此只作回落，且返回项带
 * `source: 'eastmoney'`，便于日后需要时在 UI 上区分。
 *
 * @param {string} digits 6 位纯数字代码
 * @param {{ pageSize?: number }} [opts]
 * @returns {Promise<Array>} 按时间倒序
 */
async function fetchStockNewsEm(digits, opts = {}) {
  const code = String(digits || '').trim();
  if (!/^\d{6}$/.test(code)) throw new Error(`东财新闻接口需要 6 位代码，收到：${digits}`);

  const { pageSize = 20 } = opts;
  const query = new URLSearchParams({ cb: '', param: buildSearchParam(code, pageSize) });

  const json = await fetchJson(`${EM_SEARCH_URL}?${query.toString()}`, {
    ...opts,
    headers: { Referer: 'https://so.eastmoney.com/', ...(opts.headers || {}) },
  });

  return parseEmSearchNews(json);
}

/**
 * 解析东财搜索响应。抽出来单测，免得为测字段名发真实请求。
 *
 * date 形如 '2026-08-08 15:53:07'，截到分钟与新浪那路对齐 —— 两个源的条目
 * 会进同一个 mergeNewsItems 排序去重，格式必须一致。
 */
function parseEmSearchNews(json) {
  const list =
    json && json.result && Array.isArray(json.result.cmsArticleWebOld)
      ? json.result.cmsArticleWebOld
      : [];

  const items = [];
  for (const it of list) {
    if (!it || typeof it !== 'object') continue;
    const title = stripHtml(it.title);
    if (!title) continue;

    const m = String(it.date || '').match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})/);
    if (!m) continue;

    items.push({
      date: m[1],
      time: m[2],
      datetime: `${m[1]} ${m[2]}`,
      title,
      url: String(it.url || '').trim(),
      /** 媒体名，如「红星资本局」。新浪那路拿不到，UI 可选展示 */
      media: String(it.mediaName || '').trim(),
      source: 'eastmoney',
    });
  }

  return items.sort((a, b) => (a.datetime < b.datetime ? 1 : a.datetime > b.datetime ? -1 : 0));
}

/**
 * 拉个股新闻，新浪优先、东财兜底。
 *
 * 回落条件是「抛错**或**返回 0 条」：新浪页面改版时不会报错，只会解析出 0 条，
 * 只判异常会漏掉最需要兜底的那种失败。
 *
 * @param {string} code 形如 'sh600519'
 * @param {string} digits 6 位代码（东财那路要）
 * @returns {Promise<{ items: Array, source: 'sina'|'eastmoney'|'', warning: string }>}
 *          两个源都失败时 items 为 []，warning 说明原因；不抛错
 */
async function fetchStockNewsWithFallback(code, digits, opts = {}) {
  const notes = [];

  try {
    const items = await fetchStockNews(code, opts);
    if (items.length > 0) return { items, source: 'sina', warning: '' };
    notes.push('新浪新闻返回 0 条');
  } catch (err) {
    notes.push(`新浪新闻：${err && err.message ? err.message : err}`);
  }

  try {
    const items = await fetchStockNewsEm(digits, opts);
    if (items.length > 0) {
      // 主源失灵而备份源有数据，值得让用户知道 —— 两个源的过滤精度不一样
      return { items, source: 'eastmoney', warning: notes.join('；') };
    }
    notes.push('东财新闻返回 0 条');
  } catch (err) {
    notes.push(`东财新闻：${err && err.message ? err.message : err}`);
  }

  return { items: [], source: '', warning: notes.join('；') };
}

/** 东财 display_time 形如 `2026-07-17 21:26:22:243`，截到分钟 */
function normalizeAnnTime(raw) {
  const s = String(raw == null ? '' : raw).trim();
  const m = s.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})/);
  return m ? { date: m[1], time: m[2], datetime: `${m[1]} ${m[2]}` } : { date: '', time: '', datetime: s };
}

/**
 * 拉公告（东方财富）。
 *
 * ann_type 必须跟标的类型对上：A 股用 'A'，场内基金用 'FUND'。
 * 已实测：ETF 510300 与 LOF 161725 用 ann_type=A 都返回 0 条，换成 FUND
 * 才拿到基金季报、高管变更等真实公告。'F' / 'ETF' / 'ALL' 均无效。
 *
 * @param {string} digits 6 位纯数字代码
 * @param {{ pageSize?: number, kind?: 'fund'|'index'|'stock' }} [opts]
 */
async function fetchAnnouncements(digits, opts = {}) {
  const { pageSize = 10, kind = 'stock' } = opts;
  const params = new URLSearchParams({
    sr: '-1',
    page_size: String(pageSize),
    page_index: '1',
    ann_type: kind === 'fund' ? 'FUND' : 'A',
    client_source: 'web',
    stock_list: String(digits),
  });

  const json = await fetchJson(`${EM_ANN_URL}?${params.toString()}`, {
    ...opts,
    headers: { Referer: 'https://data.eastmoney.com/', ...(opts.headers || {}) },
  });

  const list = json && json.data && Array.isArray(json.data.list) ? json.data.list : [];
  return list.map((it) => {
    const t = normalizeAnnTime(it.display_time || it.notice_date);
    return {
      ...t,
      title: stripHtml(it.title),
      // 公告详情页可由 art_code 拼出
      url: it.art_code ? `https://data.eastmoney.com/notices/detail/${digits}/${it.art_code}.html` : '',
      isAnnouncement: true,
    };
  });
}

module.exports = {
  fetchStockNews,
  fetchStockNewsEm,
  fetchStockNewsWithFallback,
  fetchAnnouncements,
  parseSinaNewsPage,
  parseEmSearchNews,
  buildSearchParam,
  stripHtml,
  normalizeAnnTime,
  SINA_NEWS_URL,
  EM_ANN_URL,
  EM_SEARCH_URL,
};
