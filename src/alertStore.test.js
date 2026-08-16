'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createAlertStore, normalizeFired, isDateValue, FILE_NAME, MAX_ENTRIES } = require('./alertStore');
const { pruneFired, ruleKey } = require('./alertRules');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'swalert-'));
}

function writeRaw(dir, content) {
  fs.writeFileSync(path.join(dir, FILE_NAME), content, 'utf8');
}

const TODAY = '2026-08-13';

// —— isDateValue ——

test('isDateValue 只认 YYYY-MM-DD 字符串', () => {
  assert.equal(isDateValue('2026-08-13'), true);
  for (const bad of ['2026-8-13', '20260813', '', null, undefined, 42, true, {}, new Date()]) {
    assert.equal(isDateValue(bad), false, `isDateValue(${JSON.stringify(bad)})`);
  }
});

// —— normalizeFired ——

test('normalizeFired 保留合法条目', () => {
  const out = normalizeFired({ 'sh600519|price|gte|1300': TODAY });
  assert.deepEqual(out, { 'sh600519|price|gte|1300': TODAY });
});

test('normalizeFired 丢弃值不是日期串的条目', () => {
  // 值坏了会让 fired[key] === today 的比较静默失效，去重形同虚设
  const out = normalizeFired({ a: TODAY, b: true, c: 42, d: null, e: '不是日期', f: {} });
  assert.deepEqual(out, { a: TODAY });
});

test('normalizeFired 丢弃空键', () => {
  assert.deepEqual(normalizeFired({ '': TODAY }), {});
});

test('normalizeFired 非对象输入返回空对象', () => {
  for (const bad of [null, undefined, 'x', 42, []]) {
    assert.deepEqual(normalizeFired(bad), {}, `normalizeFired(${JSON.stringify(bad)})`);
  }
});

test('normalizeFired 超上限时截断，不无限增长', () => {
  const big = {};
  for (let i = 0; i < MAX_ENTRIES + 100; i += 1) big[`k${i}`] = TODAY;
  assert.equal(Object.keys(normalizeFired(big)).length, MAX_ENTRIES);
});

// —— load ——

test('首次 load 返回空游标（文件不存在）', () => {
  const store = createAlertStore(tmpDir());
  assert.deepEqual(store.load(), { fired: {} });
});

test('存取往返一致', () => {
  const dir = tmpDir();
  const store = createAlertStore(dir);
  const key = ruleKey('sh600519', { kind: 'changePct', dir: 'gte', value: 5 });
  store.save({ fired: { [key]: TODAY } });
  assert.deepEqual(createAlertStore(dir).load().fired, { [key]: TODAY });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('坏 JSON 时回落空游标而不抛——丢了游标只会重复提醒一次，抛错会打断行情轮询', () => {
  const dir = tmpDir();
  writeRaw(dir, '{ this is not json');
  const store = createAlertStore(dir);
  assert.doesNotThrow(() => store.load());
  assert.deepEqual(store.load(), { fired: {} });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('文件里缺 fired 字段时回落空游标', () => {
  const dir = tmpDir();
  writeRaw(dir, JSON.stringify({ somethingElse: 1 }));
  assert.deepEqual(createAlertStore(dir).load(), { fired: {} });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('文件里 fired 不是对象时回落空游标', () => {
  const dir = tmpDir();
  for (const bad of ['x', 42, [], null]) {
    writeRaw(dir, JSON.stringify({ fired: bad }));
    assert.deepEqual(createAlertStore(dir).load().fired, {}, `fired=${JSON.stringify(bad)}`);
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test('load 会过滤掉脏条目，只留合法的', () => {
  const dir = tmpDir();
  writeRaw(dir, JSON.stringify({ fired: { good: TODAY, bad: true, alsoBad: 42 } }));
  assert.deepEqual(createAlertStore(dir).load().fired, { good: TODAY });
  fs.rmSync(dir, { recursive: true, force: true });
});

// —— save ——

test('save 会自动建目录', () => {
  const nested = path.join(tmpDir(), 'a', 'b');
  const store = createAlertStore(nested);
  assert.equal(store.save({ fired: { a: TODAY } }), true);
  assert.ok(fs.existsSync(path.join(nested, FILE_NAME)));
});

test('save 落盘前也做规范化——脏条目不该被写进文件', () => {
  const dir = tmpDir();
  const store = createAlertStore(dir);
  store.save({ fired: { good: TODAY, bad: 42 } });
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, FILE_NAME), 'utf8'));
  assert.deepEqual(onDisk.fired, { good: TODAY });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('save 写不进去时返回 false 而不抛', () => {
  // 用一个不可能建成目录的路径（已存在的文件当目录用）
  const dir = tmpDir();
  const asFile = path.join(dir, 'blocker');
  fs.writeFileSync(asFile, 'x', 'utf8');
  const store = createAlertStore(path.join(asFile, 'nested'));
  assert.doesNotThrow(() => store.save({ fired: { a: TODAY } }));
  assert.equal(store.save({ fired: { a: TODAY } }), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('save 空游标是合法操作（清空）', () => {
  const dir = tmpDir();
  const store = createAlertStore(dir);
  store.save({ fired: { a: TODAY } });
  store.save({ fired: {} });
  assert.deepEqual(store.load().fired, {});
  fs.rmSync(dir, { recursive: true, force: true });
});

test('save 输入为空时写出空游标而不抛', () => {
  const dir = tmpDir();
  const store = createAlertStore(dir);
  assert.doesNotThrow(() => store.save(null));
  assert.deepEqual(store.load().fired, {});
  fs.rmSync(dir, { recursive: true, force: true });
});

// —— clear ——

test('clear 清空游标——改完规则想立刻重新收到提醒时用', () => {
  const dir = tmpDir();
  const store = createAlertStore(dir);
  store.save({ fired: { a: TODAY, b: TODAY } });
  assert.equal(store.clear(), true);
  assert.deepEqual(store.load().fired, {});
  fs.rmSync(dir, { recursive: true, force: true });
});

// —— 与 alertRules.pruneFired 的配合 ——

test('跨天流程：load → pruneFired → save，旧条目被清掉', () => {
  const dir = tmpDir();
  const store = createAlertStore(dir);
  // 昨天留下的游标
  store.save({ fired: { a: '2026-08-12', b: '2026-08-12' } });

  const { fired } = store.load();
  const pruned = pruneFired(fired, TODAY);
  store.save({ fired: pruned });

  assert.deepEqual(store.load().fired, {}, '跨天后旧条目应被清空，规则今天能重新提醒');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('同一天流程：今日条目在 prune 后保留', () => {
  const dir = tmpDir();
  const store = createAlertStore(dir);
  store.save({ fired: { a: TODAY, old: '2026-08-01' } });

  const pruned = pruneFired(store.load().fired, TODAY);
  store.save({ fired: pruned });

  assert.deepEqual(store.load().fired, { a: TODAY }, '今日的留下，历史的清掉');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('ruleKey 生成的键能原样存取——键里有 | 分隔符，不能被序列化破坏', () => {
  const dir = tmpDir();
  const store = createAlertStore(dir);
  const key = ruleKey('sh600519', { kind: 'price', dir: 'lte', value: 1.2345 });
  store.save({ fired: { [key]: TODAY } });
  const back = store.load().fired;
  assert.ok(key in back, `键 ${key} 应能原样读回`);
  fs.rmSync(dir, { recursive: true, force: true });
});

// —— 与其它两个 store 的策略对比 ——

test('对照：三个 store 的容错策略各不相同，且都是刻意的', () => {
  const { createConfigStore } = require('./config');
  const { createTradeStore } = require('./tradeStore');

  // config：坏了静默回落默认值，照样能写（可重设的偏好）
  const cfgDir = tmpDir();
  fs.writeFileSync(path.join(cfgDir, 'config.json'), '{ BROKEN', 'utf8');
  assert.doesNotThrow(() => createConfigStore(cfgDir).save({ watchlist: ['600519'] }));

  // trades：坏了拒绝写入（用户手输的不可再生记账数据）
  const trDir = tmpDir();
  fs.writeFileSync(path.join(trDir, 'trades.json'), '{ BROKEN', 'utf8');
  assert.throws(() =>
    createTradeStore(trDir).add('600519', { date: '2026-03-14', side: 'buy', price: 100, shares: 10 })
  );

  // alerts：坏了静默回落，写也静默（完全可再生，丢了最坏重复提醒一次）
  const alDir = tmpDir();
  writeRaw(alDir, '{ BROKEN');
  const alStore = createAlertStore(alDir);
  assert.doesNotThrow(() => alStore.load());
  assert.equal(alStore.save({ fired: { a: TODAY } }), true, '坏文件会被直接覆盖，这是可接受的');

  for (const d of [cfgDir, trDir, alDir]) fs.rmSync(d, { recursive: true, force: true });
});
