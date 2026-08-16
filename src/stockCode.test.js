'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const {
  normalizeCode,
  normalizeCodeList,
  exchangeLabel,
  classifyCode,
  kindLabel,
} = require('./stockCode');

test('纯数字代码按首位推断交易所', () => {
  assert.equal(normalizeCode('600519').code, 'sh600519'); // 沪主板
  assert.equal(normalizeCode('000858').code, 'sz000858'); // 深主板
  assert.equal(normalizeCode('300750').code, 'sz300750'); // 创业板
  assert.equal(normalizeCode('688111').code, 'sh688111'); // 科创板
  assert.equal(normalizeCode('830799').code, 'bj830799'); // 北交所
});

test('显式交易所标记优先于首位推断', () => {
  // 000001 首位是 0 会猜深市，但用户写了 sh 就该听用户的（sh000001 是上证指数）
  assert.equal(normalizeCode('sh000001').code, 'sh000001');
  assert.equal(normalizeCode('SH600519').code, 'sh600519');
  assert.equal(normalizeCode('600519.SH').code, 'sh600519');
  assert.equal(normalizeCode('000858.sz').code, 'sz000858');
});

test('带空白与杂字符也能提取代码', () => {
  assert.equal(normalizeCode('  600519  ').code, 'sh600519');
  assert.equal(normalizeCode('贵州茅台600519').code, 'sh600519');
});

test('非法输入返回 ok:false 且带提示', () => {
  for (const bad of ['', '   ', null, undefined, 'abc', '123', '12345']) {
    const r = normalizeCode(bad);
    assert.equal(r.ok, false, `应拒绝: ${JSON.stringify(bad)}`);
    assert.match(r.error, /6 位/);
  }
});

// —— 场内基金（ETF / LOF）——

test('ETF 代码按首位路由到正确交易所', () => {
  // 沪市 5xxxxx
  assert.equal(normalizeCode('510300').code, 'sh510300'); // 沪深300ETF
  assert.equal(normalizeCode('510050').code, 'sh510050'); // 上证50ETF
  assert.equal(normalizeCode('588000').code, 'sh588000'); // 科创50ETF
  assert.equal(normalizeCode('518880').code, 'sh518880'); // 黄金ETF
  assert.equal(normalizeCode('513050').code, 'sh513050'); // 跨境ETF
  assert.equal(normalizeCode('511990').code, 'sh511990'); // 货币ETF
  assert.equal(normalizeCode('501018').code, 'sh501018'); // 沪市LOF
  // 深市 15xxxx / 16xxxx / 18xxxx
  assert.equal(normalizeCode('159915').code, 'sz159915'); // 创业板ETF
  assert.equal(normalizeCode('159919').code, 'sz159919'); // 沪深300ETF嘉实
  assert.equal(normalizeCode('161725').code, 'sz161725'); // 白酒LOF
  assert.equal(normalizeCode('184688').code, 'sz184688'); // 封闭式
});

test('classifyCode 认出场内基金', () => {
  assert.equal(classifyCode('510300', 'sh'), 'fund');
  assert.equal(classifyCode('588000', 'sh'), 'fund');
  assert.equal(classifyCode('159915', 'sz'), 'fund');
  assert.equal(classifyCode('161725', 'sz'), 'fund');
  assert.equal(classifyCode('184688', 'sz'), 'fund');
});

test('classifyCode 不把股票当基金', () => {
  assert.equal(classifyCode('600519', 'sh'), 'stock');
  assert.equal(classifyCode('000858', 'sz'), 'stock');
  assert.equal(classifyCode('300750', 'sz'), 'stock');
  assert.equal(classifyCode('688111', 'sh'), 'stock');
  assert.equal(classifyCode('830799', 'bj'), 'stock');
});

test('深市可转债与债券不能被当成基金', () => {
  // 12xxxx 是可转债，10/11xxxx 是国债与企业债。
  // 若把深市放宽成 /^1\d{5}$/ 就会全部误判，进而去请求基金公告
  for (const d of ['123123', '127045', '128095', '100001', '110059', '113050']) {
    assert.equal(classifyCode(d, 'sz'), 'stock', `${d} 不该是基金`);
    assert.equal(normalizeCode(d).isFund, false, `${d} isFund 应为 false`);
  }
});

test('classifyCode 认出指数，且必须连交易所一起判', () => {
  assert.equal(classifyCode('000001', 'sh'), 'index'); // 上证指数
  assert.equal(classifyCode('000300', 'sh'), 'index'); // 沪深300
  assert.equal(classifyCode('399997', 'sz'), 'index'); // 中证白酒
  // 同样的 000001 在深市是平安银行，绝不能判成指数
  assert.equal(classifyCode('000001', 'sz'), 'stock');
  assert.equal(classifyCode('000858', 'sz'), 'stock');
  // 反过来，399xxx 在沪市不是指数段
  assert.equal(classifyCode('399997', 'sh'), 'stock');
});

test('normalizeCode 带出 kind 与 isFund', () => {
  const etf = normalizeCode('510300');
  assert.equal(etf.kind, 'fund');
  assert.equal(etf.isFund, true);

  const stock = normalizeCode('600519');
  assert.equal(stock.kind, 'stock');
  assert.equal(stock.isFund, false);

  const index = normalizeCode('sh000300');
  assert.equal(index.kind, 'index');
  assert.equal(index.isFund, false);
});

test('显式交易所前缀参与类型判定', () => {
  // 159915 若被硬写成 sh，就不在沪市基金段里了，此时不该再判成基金
  assert.equal(normalizeCode('sh159915').kind, 'stock');
  assert.equal(normalizeCode('sz159915').kind, 'fund');
  assert.equal(normalizeCode('510300.sh').isFund, true);
});

test('ETF 代码走批量规范化', () => {
  const r = normalizeCodeList(['510300', '159915', '600519', '510300']);
  assert.deepEqual(r.codes, ['sh510300', 'sz159915', 'sh600519']);
  assert.equal(r.errors.length, 0);
});

test('kindLabel 中文标签', () => {
  assert.equal(kindLabel('fund'), '基金');
  assert.equal(kindLabel('index'), '指数');
  assert.equal(kindLabel('stock'), ''); // 股票不打标
  assert.equal(kindLabel(undefined), '');
});

test('批量规范化去重保序，非法项进 errors 不打断', () => {
  const r = normalizeCodeList(['600519', 'sh600519', '000858', 'bad', '300750']);
  assert.deepEqual(r.codes, ['sh600519', 'sz000858', 'sz300750']);
  assert.equal(r.errors.length, 1);
  assert.equal(r.errors[0].input, 'bad');
});

test('批量输入非数组时返回空结果', () => {
  assert.deepEqual(normalizeCodeList(null).codes, []);
  assert.deepEqual(normalizeCodeList('600519').codes, []);
});

test('交易所中文标签', () => {
  assert.equal(exchangeLabel('sh'), '沪');
  assert.equal(exchangeLabel('sz'), '深');
  assert.equal(exchangeLabel('bj'), '京');
  assert.equal(exchangeLabel('xx'), '');
});
