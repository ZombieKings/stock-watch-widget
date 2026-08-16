'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  fetchKline,
  parseBar,
  resolveBarsKey,
  movingAverage,
  MAX_BARS,
} = require('./klineClient');

// —— parseBar：字段序是最容易搞错的地方 ——

test('parseBar 按 [日,开,收,高,低,量] 取字段，收在高低之前', () => {
  // 取自实盘：贵州茅台 2026-07-23
  const bar = parseBar(['2026-07-23', '1299.800', '1292.010', '1303.000', '1285.430', '33918.000']);
  assert.equal(bar.date, '2026-07-23');
  assert.equal(bar.open, 1299.8);
  assert.equal(bar.close, 1292.01); // 第 3 段是收盘，不是最高
  assert.equal(bar.high, 1303);
  assert.equal(bar.low, 1285.43);
  assert.equal(bar.volume, 33918);
});

test('parseBar 解析结果满足 low <= min(开,收) <= max(开,收) <= high', () => {
  // 用真实数据反向校验字段没有错位——错位几乎必然打破这个不等式
  const rows = [
    ['2026-08-03', '1350.600', '1358.980', '1363.350', '1346.000', '36147.000'],
    ['2026-08-04', '1350.060', '1328.360', '1350.940', '1328.360', '37450.000'],
    ['2026-08-05', '1328.360', '1306.450', '1333.800', '1303.500', '42689.000'],
    ['2026-08-06', '1310.00', '1308.78', '1314.40', '1300.01', '16127'],
  ];
  for (const row of rows) {
    const b = parseBar(row);
    assert.ok(b.low <= Math.min(b.open, b.close), `${b.date} 低点高于开收最小值`);
    assert.ok(b.high >= Math.max(b.open, b.close), `${b.date} 高点低于开收最大值`);
  }
});

test('parseBar 忽略除权日多出的第 7 段分红对象，不当数字用', () => {
  // 实盘：茅台 2026-06-26 除权，第 7 段是对象
  const bar = parseBar([
    '2026-06-26',
    '1199.000',
    '1168.630',
    '1199.000',
    '1168.100',
    '50066.000',
    { nd: '2025', fh_sh: '280.242', djr: '2026-06-25', cqr: '2026-06-26', FHcontent: '10派280.242元' },
  ]);
  assert.equal(bar.close, 1168.63);
  assert.equal(bar.volume, 50066);
  // 数值字段不能被对象污染
  for (const k of ['open', 'close', 'high', 'low', 'volume']) {
    assert.equal(typeof bar[k], 'number', `${k} 应是数字`);
  }
  assert.equal(bar.dividend.content, '10派280.242元');
  assert.equal(bar.dividend.exDate, '2026-06-26');
});

test('parseBar 无分红时不产生 dividend 字段', () => {
  const bar = parseBar(['2026-08-03', '1350.600', '1358.980', '1363.350', '1346.000', '36147.000']);
  assert.equal(bar.dividend, undefined);
});

test('parseBar 拒绝残缺行与非法日期', () => {
  assert.equal(parseBar(null), null);
  assert.equal(parseBar([]), null);
  assert.equal(parseBar(['2026-08-03', '1', '2', '3', '4']), null); // 只有 5 段
  assert.equal(parseBar(['汇总', '1', '2', '3', '4', '5']), null);
  assert.equal(parseBar(['2026-8-3', '1', '2', '3', '4', '5']), null); // 月日未补零
  assert.equal(parseBar(['2026-08-03', '', '2', '3', '4', '5']), null); // 开盘价空
});

test('parseBar 量缺失时补 0 而非 null，避免量柱 NaN', () => {
  const bar = parseBar(['2026-08-03', '10', '11', '12', '9', '']);
  assert.equal(bar.volume, 0);
});

// —— resolveBarsKey：键名随复权方式变化 ——

test('resolveBarsKey 按复权方式拼键名', () => {
  const node = { qfqday: [], hfqweek: [], month: [] };
  assert.equal(resolveBarsKey(node, 'day', 'qfq'), 'qfqday');
  assert.equal(resolveBarsKey(node, 'week', 'hfq'), 'hfqweek');
  assert.equal(resolveBarsKey(node, 'month', 'none'), 'month');
});

test('resolveBarsKey 在精确键缺失时回落到不带前缀的键', () => {
  // 实盘：代码不存在时返回 { day: [] }，即便请求的是 qfq
  assert.equal(resolveBarsKey({ day: [] }, 'day', 'qfq'), 'day');
});

test('resolveBarsKey 找不到任何匹配返回空串', () => {
  assert.equal(resolveBarsKey({ qt: {} }, 'day', 'qfq'), '');
  assert.equal(resolveBarsKey(null, 'day', 'qfq'), '');
});

test('resolveBarsKey 不把 week 误配给 day', () => {
  // 'qfqweek' 以 'week' 结尾但不以 'day' 结尾，请求 day 时不能命中
  assert.equal(resolveBarsKey({ qfqweek: [] }, 'day', 'qfq'), '');
});

// —— movingAverage：均线错位最难肉眼发现 ——

test('movingAverage 前 period-1 个位置为 null，第 period 个开始有值', () => {
  const bars = [1, 2, 3, 4, 5].map((c) => ({ close: c }));
  const ma = movingAverage(bars, 3);
  assert.deepEqual(ma, [null, null, 2, 3, 4]);
});

test('movingAverage 每个值等于「截止当根」的均值，不含未来数据', () => {
  const closes = [10, 20, 30, 40, 50, 60];
  const bars = closes.map((c) => ({ close: c }));
  const ma = movingAverage(bars, 3);
  for (let i = 2; i < closes.length; i += 1) {
    const expect = (closes[i] + closes[i - 1] + closes[i - 2]) / 3;
    assert.equal(ma[i], expect, `第 ${i} 根均线应只用当根及之前的收盘`);
  }
});

test('movingAverage 滑动求和无累积误差', () => {
  // 小数收盘价连续滑动，验证减法没把精度弄丢
  const bars = Array.from({ length: 50 }, (_, i) => ({ close: 10 + (i % 7) * 0.01 }));
  const ma = movingAverage(bars, 5);
  for (let i = 4; i < bars.length; i += 1) {
    const brute = (bars[i].close + bars[i - 1].close + bars[i - 2].close + bars[i - 3].close + bars[i - 4].close) / 5;
    assert.ok(Math.abs(ma[i] - brute) < 1e-9, `第 ${i} 根偏差过大`);
  }
});

test('movingAverage 处理 period 大于根数、非法 period', () => {
  const bars = [{ close: 1 }, { close: 2 }];
  assert.deepEqual(movingAverage(bars, 5), [null, null]);
  assert.deepEqual(movingAverage(bars, 0), [null, null]);
  assert.deepEqual(movingAverage(bars, -1), [null, null]);
  assert.deepEqual(movingAverage([], 5), []);
  assert.deepEqual(movingAverage(null, 5), []);
});

// —— fetchKline：注入 fetch，不打网络 ——

/** 构造腾讯 K 线接口的响应体 */
function mockResponse(body) {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    arrayBuffer: async () => Buffer.from(JSON.stringify(body), 'utf8'),
  };
}

test('fetchKline 拼出正确的 param，并解析 bars 与 prec', async () => {
  let seenUrl = '';
  const res = await fetchKline(
    'sh600519',
    { period: 'week', count: 60, fq: 'qfq' },
    {
      fetchImpl: async (url) => {
        seenUrl = url;
        return mockResponse({
          code: 0,
          msg: '',
          data: {
            sh600519: {
              qfqweek: [
                ['2026-06-18', '1264.676', '1186.976', '1264.676', '1183.196', '178831.000'],
                ['2026-08-06', '1350.600', '1308.78', '1363.350', '1300.01', '132413'],
              ],
              prec: '1263.886',
            },
          },
        });
      },
    }
  );

  assert.match(seenUrl, /param=sh600519,week,,,60,qfq$/);
  assert.equal(res.period, 'week');
  assert.equal(res.prevClose, 1263.886);
  assert.equal(res.bars.length, 2);
  assert.equal(res.bars[0].close, 1186.976);
});

test('fetchKline 根数超服务端上限时收敛到 MAX_BARS，避免 param error', async () => {
  let seenUrl = '';
  await fetchKline(
    'sh600519',
    { count: 5000 },
    {
      fetchImpl: async (url) => {
        seenUrl = url;
        return mockResponse({ code: 0, data: { sh600519: { qfqday: [], prec: '1' } } });
      },
    }
  );
  assert.match(seenUrl, new RegExp(`,${MAX_BARS},qfq$`));
});

test('fetchKline 非法 period/fq/count 回落到默认值', async () => {
  let seenUrl = '';
  await fetchKline(
    'sh600519',
    { period: 'hour', fq: 'xxx', count: NaN },
    {
      fetchImpl: async (url) => {
        seenUrl = url;
        return mockResponse({ code: 0, data: { sh600519: { qfqday: [], prec: '1' } } });
      },
    }
  );
  assert.match(seenUrl, /param=sh600519,day,,,80,qfq$/);
});

test('fetchKline 不复权时 param 末尾为空且能读到 day 键', async () => {
  let seenUrl = '';
  const res = await fetchKline(
    'sh600519',
    { fq: 'none', count: 5 },
    {
      fetchImpl: async (url) => {
        seenUrl = url;
        return mockResponse({
          code: 0,
          data: {
            sh600519: {
              day: [['2026-08-06', '1310.00', '1308.78', '1314.40', '1300.01', '16127']],
              prec: '1297.410',
            },
          },
        });
      },
    }
  );
  assert.match(seenUrl, /,5,$/); // 复权段留空
  assert.equal(res.bars.length, 1);
});

test('fetchKline 遇到 data 为空数组时抛出带 msg 的错误', async () => {
  await assert.rejects(
    fetchKline('sh600519', { count: 80 }, {
      fetchImpl: async () => mockResponse({ code: 0, msg: 'param error', data: [] }),
    }),
    /param error/
  );
});

test('fetchKline 代码不存在时返回空 bars 而非抛错', async () => {
  const res = await fetchKline('sh999999', { count: 5 }, {
    fetchImpl: async () => mockResponse({ code: 0, msg: '', data: { sh999999: { day: [], prec: '0' } } }),
  });
  assert.deepEqual(res.bars, []);
});

test('fetchKline 跳过混在中间的坏行，保留好行', async () => {
  const res = await fetchKline('sh600519', { count: 5 }, {
    fetchImpl: async () =>
      mockResponse({
        code: 0,
        data: {
          sh600519: {
            qfqday: [
              ['2026-08-04', '1350.060', '1328.360', '1350.940', '1328.360', '37450.000'],
              ['坏行'],
              null,
              ['2026-08-05', '1328.360', '1306.450', '1333.800', '1303.500', '42689.000'],
            ],
            prec: '1358.980',
          },
        },
      }),
  });
  assert.equal(res.bars.length, 2);
  assert.deepEqual(res.bars.map((b) => b.date), ['2026-08-04', '2026-08-05']);
});
