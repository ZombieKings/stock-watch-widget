'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const {
  parseQuoteLine,
  parseMinuteLines,
  fetchQuotes,
  fetchMinuteLine,
  fetchMultiDayMinute,
  parseMultiDayMinute,
  isIntradayTime,
  dashDate,
} = require('./quoteClient');

/** 真实抓取的贵州茅台行情（2026-08-06 盘中），字段完整 88 段 */
const REAL_LINE =
  'v_sh600519="1~贵州茅台~600519~1301.50~1306.45~1310.00~11131~4592~6525~1301.52~1~1301.51~3~1301.50~1~1301.22~1~1301.20~6~1301.95~3~1302.00~1~1302.01~5~1302.05~1~1302.09~1~~20260806104333~-4.95~-0.38~1314.40~1300.01~1301.50/11131/1451334748~11131~145133~0.09~19.67~~1314.40~1300.01~1.10~16269.81~16269.81~6.99~1437.10~1175.81~0.74~23~1303.85~14.93~19.76~~~0.18~145133.4748~0.0000~0~   A~GP-A~-3.54~-4.43~4.00~30.53~26.78~1539.98~1151.01~0.78~10.15~-1.11~1250081601~1250081601~15.15~-7.67~1250081601~~~-5.13~-0.05~~CNY~0~___D__F__N~1302.59~-13~"';

/** 真实 ETF 行情（沪深300ETF，2026-08-07 收盘后）。78 段有 IOPV */
const ETF_LINE =
  'v_sh510300="1~沪深300ETF华泰柏瑞~510300~4.751~4.709~4.706~9435356~4406295~5029060~4.751~14055~4.750~9203~4.749~2622~4.748~2910~4.747~1576~4.752~10081~4.753~5916~4.754~3997~4.755~14108~4.756~1942~~20260807161452~0.042~0.89~4.764~4.706~4.751/9435356/4474693309~9435356~447469~3.67~~~4.764~4.706~1.23~1221.26~1221.26~0.00~5.180~4.238~0.80~-5678~4.742~~~~~~447469.3309~172.3881~3628~   A~ETF~2.61~2.11~~~~5.095~4.052~1.06~-1.62~-3.85~25705387700~25705387700~-8.55~2.39~25705387700~-0.01~4.7517~16.73~-0.02~4.7111~CNY~0~___D__F__N~4.760~-19893~"';

/** 真实 LOF 行情（白酒基金，同日）。78 段为空，只有 81 段 T-1 净值 */
const LOF_LINE =
  'v_sz161725="51~白酒基金LOF~161725~0.565~0.560~0.563~1189167~682269~506898~0.565~6598~0.564~7354~0.563~4908~0.562~2816~0.561~2962~0.566~14274~0.567~18975~0.568~5285~0.569~1332~0.570~3275~~20260807161424~0.005~0.89~0.567~0.554~0.565/1189167/66664095~1189167~6666~3.38~~~0.567~0.554~2.32~19.88~19.88~0.00~0.616~0.504~1.24~-18503~0.561~~~~~~6666.4095~0.0000~0~ ~LOF~-20.53~-3.09~~~~0.850~0.490~5.02~10.35~-5.99~3517811828~3517811828~-27.30~-29.46~3517811828~0.78~~-25.36~0.00~0.5606~CNY~0~~0.560~7838~"';

test('解析真实行情行，关键字段对得上', () => {
  const q = parseQuoteLine(REAL_LINE);
  assert.equal(q.ok, true);
  assert.equal(q.symbol, 'sh600519');
  assert.equal(q.name, '贵州茅台');
  assert.equal(q.code, '600519');
  assert.equal(q.price, 1301.5);
  assert.equal(q.prevClose, 1306.45);
  assert.equal(q.open, 1310.0);
  assert.equal(q.high, 1314.4);
  assert.equal(q.low, 1300.01);
  assert.equal(q.change, -4.95);
  assert.equal(q.changePct, -0.38);
  assert.equal(q.volume, 11131);
  assert.equal(q.amount, 145133);
  assert.equal(q.turnover, 0.09);
  assert.equal(q.pe, 19.67);
  assert.equal(q.pb, 6.99);
  assert.equal(q.volumeRatio, 0.74);
  assert.equal(q.amplitude, 1.1);
  assert.equal(q.totalMarketCap, 16269.81);
  assert.equal(q.limitUp, 1437.1);
  assert.equal(q.limitDown, 1175.81);
  assert.equal(q.avgPrice, 1303.85);
  assert.equal(q.high52w, 1539.98);
  assert.equal(q.low52w, 1151.01);
  assert.equal(q.currency, 'CNY');
  assert.equal(q.quoteTime, '20260806104333');
});

test('涨跌幅与昨收自洽——校验字段下标没有错位', () => {
  const q = parseQuoteLine(REAL_LINE);
  // change 应等于 price - prevClose（容忍分位误差）
  assert.ok(Math.abs(q.change - (q.price - q.prevClose)) < 0.02);
  // changePct 应等于 change / prevClose * 100
  assert.ok(Math.abs(q.changePct - (q.change / q.prevClose) * 100) < 0.01);
  // 涨跌停板应为昨收 ±10%（主板）
  assert.ok(Math.abs(q.limitUp - q.prevClose * 1.1) < 0.02);
  assert.ok(Math.abs(q.limitDown - q.prevClose * 0.9) < 0.02);
});

test('振幅自洽——钉住 43/49 两段不再被互换', () => {
  const q = parseQuoteLine(REAL_LINE);
  // 振幅 = (今高 - 今低) / 昨收 * 100。这条恒等式只有 43 段成立，
  // 量比算不出来（要 5 日均量），所以一旦有人把两段调回去，这里就红。
  const amp = ((q.high - q.low) / q.prevClose) * 100;
  assert.ok(Math.abs(q.amplitude - amp) < 0.02, `振幅应约 ${amp.toFixed(2)}，实得 ${q.amplitude}`);
  // 量比是独立量纲，不该等于振幅
  assert.notEqual(q.volumeRatio, q.amplitude);
});

test('股票没有净值与溢价率，基金字段应为空', () => {
  const q = parseQuoteLine(REAL_LINE);
  assert.equal(q.nav, null);
  assert.equal(q.premiumPct, null);
  assert.equal(q.navRealtime, false);
});

test('ETF 走 IOPV：nav 取实时估算净值，navRealtime 为 true', () => {
  const q = parseQuoteLine(ETF_LINE);
  assert.equal(q.ok, true);
  assert.equal(q.name, '沪深300ETF华泰柏瑞');
  assert.equal(q.nav, 4.7517);
  assert.equal(q.navRealtime, true);
  assert.equal(q.premiumPct, -0.01);
  // 溢价率应与 (price-nav)/nav*100 自洽，证明 77/78 两段没错位
  const calc = ((q.price - q.nav) / q.nav) * 100;
  assert.ok(Math.abs(q.premiumPct - calc) < 0.02, `算出 ${calc.toFixed(3)}，接口给 ${q.premiumPct}`);
});

test('LOF 无 IOPV：nav 回落到 T-1 净值，navRealtime 为 false', () => {
  const q = parseQuoteLine(LOF_LINE);
  assert.equal(q.ok, true);
  assert.equal(q.name, '白酒基金LOF');
  assert.equal(q.nav, 0.5606);
  // 关键：这是昨日净值不是实时值，UI 必须能区分，否则会把 T-1 当盘中估值展示
  assert.equal(q.navRealtime, false);
  assert.equal(q.premiumPct, 0.78);
  const calc = ((q.price - q.nav) / q.nav) * 100;
  assert.ok(Math.abs(q.premiumPct - calc) < 0.02, `算出 ${calc.toFixed(3)}，接口给 ${q.premiumPct}`);
});

test('基金没有市盈率，pb 段为字面 0 —— 不能当真实估值用', () => {
  const etf = parseQuoteLine(ETF_LINE);
  // pe 段是空串 → null；pb 段是 "0.00" → 0。渲染层靠 isFund 整块隐藏，
  // 不能只判 null，否则「市净 0.00」会显示成真数据。
  assert.equal(etf.pe, null);
  assert.equal(etf.pb, 0);
});

test('字段数不足视为无数据，而不是抛异常', () => {
  const q = parseQuoteLine('v_sh999999="1~未知~999999~"');
  assert.equal(q.ok, false);
  assert.match(q.error, /无行情数据/);
});

test('非行情行返回 null', () => {
  assert.equal(parseQuoteLine('garbage without equals'), null);
  assert.equal(parseQuoteLine('v_sh600519=no_quotes_here'), null);
});

test('分时解析：累计量转本分钟增量，均价由累计额算出', () => {
  const lines = [
    '0930 1310.00 177 23187000.00',
    '0931 1306.93 1151 150839127.00',
    '0932 1308.34 1630 213523045.57',
  ];
  const pts = parseMinuteLines(lines, 1306.45);

  assert.equal(pts.length, 3);
  assert.equal(pts[0].time, '09:30');
  assert.equal(pts[0].price, 1310.0);
  assert.equal(pts[0].volume, 177); // 首点增量 = 累计值
  assert.equal(pts[1].volume, 1151 - 177); // 增量相减
  assert.equal(pts[2].volume, 1630 - 1151);
  assert.equal(pts[1].cumVolume, 1151);

  // 均价 = 累计额 / (累计手数 × 100)
  const expectedAvg = 150839127.0 / (1151 * 100);
  assert.ok(Math.abs(pts[1].avgPrice - expectedAvg) < 0.01);

  // 涨跌幅相对昨收
  assert.ok(Math.abs(pts[0].changePct - ((1310 - 1306.45) / 1306.45) * 100) < 0.01);
});

test('分时解析跳过残行与非法时间', () => {
  const pts = parseMinuteLines(['0930 1310.00 177 23187000.00', 'bad', '093x 1 2 3', '0931 1306.93'], 1306.45);
  // 'bad' 与 '093x' 被跳过；'0931 1306.93' 只有 2 段也被跳过
  assert.equal(pts.length, 1);
});

test('分时解析容忍空输入', () => {
  assert.deepEqual(parseMinuteLines(null, 100), []);
  assert.deepEqual(parseMinuteLines([], 100), []);
});

test('无昨收时 changePct 为 null，不产出 NaN', () => {
  const pts = parseMinuteLines(['0930 1310.00 177 23187000.00'], null);
  assert.equal(pts[0].changePct, null);
});

/**
 * 构造假 fetch：返回指定内容并记录请求过的 URL。
 * body 传 Buffer 时原样返回——腾讯行情是 GBK，中文用例必须传 GBK 字节。
 */
function fakeFetch(bodyByUrl, calls = []) {
  return async (url) => {
    calls.push(url);
    const body = typeof bodyByUrl === 'function' ? bodyByUrl(url) : bodyByUrl;
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      arrayBuffer: async () => (Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8')),
    };
  };
}

/** '贵州茅台' 的 GBK 字节（iconv 实测） */
const GBK_MAOTAI = Buffer.from('b9f3d6ddc3a9cca8', 'hex');

/** 把 REAL_LINE 转成 GBK 字节串，模拟腾讯真实响应 */
function realLineAsGbk() {
  const [head, tail] = REAL_LINE.split('贵州茅台');
  return Buffer.concat([Buffer.from(head, 'latin1'), GBK_MAOTAI, Buffer.from(tail, 'latin1'), Buffer.from(';', 'latin1')]);
}

test('fetchQuotes 空列表不发请求', async () => {
  const calls = [];
  const map = await fetchQuotes([], { fetchImpl: fakeFetch('', calls) });
  assert.equal(map.size, 0);
  assert.equal(calls.length, 0);
});

test('fetchQuotes 解码 GBK 并以 symbol 建索引', async () => {
  const map = await fetchQuotes(['sh600519'], { fetchImpl: fakeFetch(realLineAsGbk()) });
  assert.ok(map.has('sh600519'));
  assert.equal(map.get('sh600519').name, '贵州茅台'); // GBK 解码正确
  assert.equal(map.get('sh600519').price, 1301.5);
});

test('fetchQuotes 一次响应含多只股票时全部入表', async () => {
  // 第二只用纯 ASCII 名，避免再拼 GBK 字节；解析逻辑与编码无关
  const second = `v_sz000858="1~WLY~000858~120.00${'~1'.repeat(60)}";`;
  const body = Buffer.concat([realLineAsGbk(), Buffer.from(`\n${second}\n`, 'latin1')]);
  const map = await fetchQuotes(['sh600519', 'sz000858'], { fetchImpl: fakeFetch(body) });
  assert.equal(map.size, 2);
  assert.equal(map.get('sh600519').name, '贵州茅台');
  assert.equal(map.get('sz000858').code, '000858');
});

test('fetchQuotes 超过批量上限时分批请求', async () => {
  const calls = [];
  const codes = Array.from({ length: 30 }, (_, i) => `sh${String(600000 + i)}`);
  await fetchQuotes(codes, { fetchImpl: fakeFetch('', calls) });
  assert.equal(calls.length, 2); // 25 + 5
  assert.ok(calls[0].includes('sh600000'));
  assert.ok(calls[1].includes('sh600025'));
});

test('fetchMinuteLine 取出 qt 里的昨收作为基准线', async () => {
  const qtRow = Array.from({ length: 60 }, () => '');
  qtRow[4] = '1306.45'; // 昨收在第 5 段
  const payload = {
    data: {
      sh600519: {
        data: { date: '20260806', data: ['0930 1310.00 177 23187000.00', '0931 1306.93 1151 150839127.00'] },
        qt: { sh600519: qtRow },
      },
    },
  };
  const r = await fetchMinuteLine('sh600519', { fetchImpl: fakeFetch(JSON.stringify(payload)) });
  assert.equal(r.date, '20260806');
  assert.equal(r.prevClose, 1306.45);
  assert.equal(r.points.length, 2);
});

test('fetchMinuteLine 遇到空响应返回空结构而非抛错', async () => {
  const r = await fetchMinuteLine('sh600519', { fetchImpl: fakeFetch('{"data":{}}') });
  assert.deepEqual(r, { date: '', prevClose: null, points: [] });
});

// —— 多日分时（5 日视图） ——

test('isIntradayTime 只认连续竞价时段，盘后固定价交易点被排除', () => {
  for (const t of ['0930', '1000', '1130', '1300', '1459', '1500']) {
    assert.equal(isIntradayTime(t), true, `${t} 应属于连续竞价`);
  }
  // 1506-1530 是盘后固定价交易，价格恒等于收盘价，留着会拖出一条平线
  for (const t of ['1506', '1520', '1530']) {
    assert.equal(isIntradayTime(t), false, `${t} 属于盘后，应排除`);
  }
  // 午休与开盘前
  for (const t of ['0915', '0925', '1131', '1259']) {
    assert.equal(isIntradayTime(t), false, `${t} 不在交易时段`);
  }
  assert.equal(isIntradayTime('abcd'), false);
  assert.equal(isIntradayTime(''), false);
});

test('dashDate 把 YYYYMMDD 转成 YYYY-MM-DD', () => {
  assert.equal(dashDate('20260805'), '2026-08-05');
  assert.equal(dashDate('2026-08-05'), '2026-08-05'); // 已带分隔符原样返回
  assert.equal(dashDate(''), '');
});

/**
 * 接口的真实形状（实测 sh603738）：日期倒序、YYYYMMDD、每天带自己的 prec。
 * 累计量每天从 0 重算——这里第 2 天的量刻意小于第 1 天，用来验证没有跨天相减。
 */
const RAW_DAYS = [
  {
    date: '20260806', // 倒序：今天在前
    prec: 33.15,
    data: ['0930 33.80 10722 36240360.00', '0931 34.36 36257 123581731.00'],
  },
  {
    date: '20260805',
    prec: 31.81,
    data: [
      '0930 31.02 9542 29599284.00',
      '1130 32.00 20000 63000000.00',
      '1300 32.50 25000 79000000.00',
      '1500 33.15 487280 1587441334.00',
      '1506 33.15 487289 1587470000.00', // 盘后，应被丢掉
      '1530 33.15 487318 1587500000.00', // 盘后，应被丢掉
    ],
  },
];

test('parseMultiDayMinute 反转日序，返回按日期升序', () => {
  const days = parseMultiDayMinute(RAW_DAYS);
  assert.equal(days.length, 2);
  assert.equal(days[0].date, '2026-08-05'); // 最早那天在前
  assert.equal(days[1].date, '2026-08-06');
});

test('parseMultiDayMinute 丢掉盘后固定价交易点，末点是 15:00', () => {
  const days = parseMultiDayMinute(RAW_DAYS);
  const full = days[0]; // 2026-08-05
  assert.equal(full.points.length, 4); // 6 行去掉 2 个盘后点
  assert.equal(full.points[full.points.length - 1].time, '15:00');
  assert.ok(
    full.points.every((p) => p.time <= '15:00'),
    '不应残留 15:00 之后的点'
  );
});

test('parseMultiDayMinute 累计量按天独立重置，首点增量不为负', () => {
  const days = parseMultiDayMinute(RAW_DAYS);
  // 8-06 的累计量(10722)远小于 8-05 的末值(487280)。若整片一起算，
  // 8-06 首点增量会是 10722-487280 = 一个巨大的负数
  const firstOf0806 = days[1].points[0];
  assert.equal(firstOf0806.cumVolume, 10722);
  assert.equal(firstOf0806.volume, 10722, '每天第一个点的增量应等于它自己的累计量');
  for (const day of days) {
    for (const p of day.points) {
      assert.ok(p.volume >= 0, `${day.date} ${p.time} 增量为负，说明跨天相减了`);
    }
  }
});

test('parseMultiDayMinute 涨跌幅按各自当日昨收算', () => {
  const days = parseMultiDayMinute(RAW_DAYS);
  assert.equal(days[0].prevClose, 31.81);
  assert.equal(days[1].prevClose, 33.15);
  // 8-06 首点 33.80 相对当日昨收 33.15
  const pct = ((33.8 - 33.15) / 33.15) * 100;
  assert.ok(Math.abs(days[1].points[0].changePct - pct) < 1e-9);
});

test('parseMultiDayMinute 容忍今日未走完与末行缺小数位', () => {
  // 实测：当天最后一行的成交额少了 '.00'（'1701384239' 而非 '...39.00'）
  const days = parseMultiDayMinute([
    { date: '20260806', prec: 33.15, data: ['0930 33.80 10722 36240360.00', '1403 34.31 488767 1701384239'] },
  ]);
  assert.equal(days.length, 1);
  assert.equal(days[0].points.length, 2);
  const last = days[0].points[1];
  assert.equal(last.time, '14:03');
  assert.equal(last.cumAmount, 1701384239);
  assert.ok(Number.isFinite(last.avgPrice), '缺小数位不应让均价变成 null');
});

test('parseMultiDayMinute 跳过无点的天与畸形输入', () => {
  const days = parseMultiDayMinute([
    { date: '20260806', prec: 1, data: [] }, // 空
    { date: '20260805', prec: 1, data: ['1506 10.00 1 1.00'] }, // 只有盘后点
    null,
    { date: '20260804', prec: 1, data: ['0930 10.00 1 1000.00'] },
  ]);
  assert.equal(days.length, 1);
  assert.equal(days[0].date, '2026-08-04');
  assert.deepEqual(parseMultiDayMinute(null), []);
  assert.deepEqual(parseMultiDayMinute(undefined), []);
});

test('fetchMultiDayMinute 打对 URL 并解析出 5 天结构', async () => {
  const calls = [];
  const payload = { code: 0, msg: '', data: { sh603738: { data: RAW_DAYS } } };
  const r = await fetchMultiDayMinute('sh603738', {
    fetchImpl: fakeFetch(JSON.stringify(payload), calls),
  });
  assert.ok(calls[0].includes('/appstock/app/day/query?code=sh603738'));
  assert.equal(r.days.length, 2);
  assert.equal(r.days[0].date, '2026-08-05');
});

test('fetchMultiDayMinute 代码不存在或空响应时返回 days: []，不抛错', async () => {
  const empty = await fetchMultiDayMinute('sh999999', { fetchImpl: fakeFetch('{"data":{}}') });
  assert.deepEqual(empty, { days: [] });

  // data 不是数组（接口偶发形状）
  const bad = await fetchMultiDayMinute('sh603738', {
    fetchImpl: fakeFetch('{"data":{"sh603738":{"data":{}}}}'),
  });
  assert.deepEqual(bad, { days: [] });
});
