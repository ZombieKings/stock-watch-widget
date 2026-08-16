'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createTradeStore, FILE_NAME, VERSION, makeId } = require('./tradeStore');
const { MAX_TRADES } = require('./trades');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'swtrade-'));
}

function buy(date, price, shares) {
  return { date, side: 'buy', price, shares };
}
function sell(date, price, shares) {
  return { date, side: 'sell', price, shares };
}

/** 直接往磁盘写一份账本，用于构造「文件已存在」的场景 */
function writeRaw(dir, content) {
  fs.writeFileSync(path.join(dir, FILE_NAME), content, 'utf8');
}

function readRaw(dir) {
  return fs.readFileSync(path.join(dir, FILE_NAME), 'utf8');
}

// —— load ——

test('首次 load 返回空账本（文件不存在）', () => {
  const store = createTradeStore(tmpDir());
  const book = store.load();
  assert.deepEqual(book.trades, {});
  assert.equal(book.loadError, '', '文件不存在不算错误——首次运行必须能写');
});

test('存取往返一致', () => {
  const dir = tmpDir();
  const store = createTradeStore(dir);
  store.add('600519', buy('2026-03-14', 1620.5, 100));
  const back = createTradeStore(dir).listFor('sh600519');
  assert.equal(back.length, 1);
  assert.equal(back[0].price, 1620.5);
  assert.equal(back[0].shares, 100);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('落盘的文件带 version', () => {
  const dir = tmpDir();
  createTradeStore(dir).add('600519', buy('2026-03-14', 100, 10));
  const onDisk = JSON.parse(readRaw(dir));
  assert.equal(onDisk.version, VERSION);
  assert.ok(onDisk.trades, '流水挂在 trades 键下');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('load 把代码键规范化（600519 → sh600519）', () => {
  const dir = tmpDir();
  writeRaw(dir, JSON.stringify({ version: 1, trades: { 600519: [buy('2026-03-14', 100, 10)] } }));
  const book = createTradeStore(dir).load();
  assert.ok(book.trades.sh600519, '键应被规范化');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('load 丢弃非法代码键', () => {
  const dir = tmpDir();
  writeRaw(
    dir,
    JSON.stringify({ version: 1, trades: { 600519: [buy('2026-03-14', 100, 10)], 垃圾: [buy('2026-03-14', 1, 1)] } })
  );
  const book = createTradeStore(dir).load();
  assert.deepEqual(Object.keys(book.trades), ['sh600519']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('load 丢弃非法流水条目但保留合法的，且不算 loadError', () => {
  // 单条格式不对（手改过文件、旧版本字段）时剩下的仍然可用可写；
  // 只有整个文件解析不了才算失败
  const dir = tmpDir();
  writeRaw(
    dir,
    JSON.stringify({
      version: 1,
      trades: { sh600519: [buy('2026-03-14', 100, 10), { date: 'bad', side: 'buy', price: 1, shares: 1 }] },
    })
  );
  const store = createTradeStore(dir);
  const book = store.load();
  assert.equal(book.trades.sh600519.length, 1);
  assert.equal(book.loadError, '', '单条非法不该锁定写入');
  // 仍然可以写
  assert.doesNotThrow(() => store.add('600519', buy('2026-04-01', 110, 10)));
  fs.rmSync(dir, { recursive: true, force: true });
});

// —— 核心不变量：读失败后禁止写入 ——

test('坏 JSON 时返回空账本并置 loadError', () => {
  const dir = tmpDir();
  writeRaw(dir, '{ this is not json');
  const store = createTradeStore(dir);
  const book = store.load();
  assert.deepEqual(book.trades, {});
  assert.ok(book.loadError, '必须报出读取失败');
  assert.ok(store.loadError, 'store 上也要能查到');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('回归：loadError 状态下 add 拒绝写入，原文件一字不改', () => {
  // 这是本文件最重要的不变量。config 的策略是「坏了就用默认值覆盖」，
  // 但流水是用户手输的不可再生数据 —— 拿空账本覆盖一个可能只坏了
  // 一个字节的文件，等于把用户的记账数据删了
  const dir = tmpDir();
  const broken = '{ "version": 1, "trades": { "sh600519": [ BROKEN';
  writeRaw(dir, broken);
  const store = createTradeStore(dir);

  assert.throws(() => store.add('600519', buy('2026-03-14', 100, 10)), /拒绝写入/);
  assert.equal(readRaw(dir), broken, '原文件必须一字不改');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('回归：loadError 状态下 remove 拒绝写入', () => {
  const dir = tmpDir();
  const broken = '{ BROKEN';
  writeRaw(dir, broken);
  const store = createTradeStore(dir);
  assert.throws(() => store.remove('600519', 't1'), /拒绝写入/);
  assert.equal(readRaw(dir), broken);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('回归：loadError 状态下 replaceFor 拒绝写入', () => {
  const dir = tmpDir();
  const broken = 'not json at all';
  writeRaw(dir, broken);
  const store = createTradeStore(dir);
  assert.throws(() => store.replaceFor('600519', [buy('2026-03-14', 100, 10)]), /拒绝写入/);
  assert.equal(readRaw(dir), broken);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('拒绝写入的错误信息里带文件路径——用户得知道去哪修', () => {
  const dir = tmpDir();
  writeRaw(dir, '{ BROKEN');
  const store = createTradeStore(dir);
  try {
    store.add('600519', buy('2026-03-14', 100, 10));
    assert.fail('应该抛错');
  } catch (err) {
    assert.ok(err.message.includes(FILE_NAME), `错误信息应含文件名：${err.message}`);
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test('文件修好后恢复可写', () => {
  const dir = tmpDir();
  writeRaw(dir, '{ BROKEN');
  const store = createTradeStore(dir);
  assert.throws(() => store.add('600519', buy('2026-03-14', 100, 10)));

  // 修好文件
  writeRaw(dir, JSON.stringify({ version: 1, trades: {} }));
  // add 内部会先 load（刷新 loadError），所以不必显式重读
  assert.doesNotThrow(() => store.add('600519', buy('2026-03-14', 100, 10)));
  assert.equal(store.loadError, '');
  fs.rmSync(dir, { recursive: true, force: true });
});

// —— add ——

test('add 返回加完之后的完整状态', () => {
  const dir = tmpDir();
  const store = createTradeStore(dir);
  const r = store.add('600519', buy('2026-03-14', 100, 100));
  assert.equal(r.trades.length, 1);
  assert.equal(r.summary.shares, 100);
  assert.equal(r.summary.avgCost, 100);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('add 生成的 id 唯一', () => {
  const dir = tmpDir();
  const store = createTradeStore(dir);
  store.add('600519', buy('2026-03-14', 100, 10));
  store.add('600519', buy('2026-03-15', 110, 10));
  store.add('600519', buy('2026-03-16', 120, 10));
  const ids = store.listFor('600519').map((t) => t.id);
  assert.equal(new Set(ids).size, 3, `id 必须互不相同：${ids.join(', ')}`);
  assert.ok(ids.every(Boolean), 'id 不能为空');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('add 非法流水时抛错且不写文件', () => {
  const dir = tmpDir();
  const store = createTradeStore(dir);
  assert.throws(() => store.add('600519', { date: 'bad', side: 'buy', price: 1, shares: 1 }), /格式不正确/);
  assert.equal(store.listFor('600519').length, 0, '不该写进去');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('add 非法代码时抛错', () => {
  const store = createTradeStore(tmpDir());
  assert.throws(() => store.add('垃圾代码', buy('2026-03-14', 100, 10)));
});

test('add 超上限时抛错，已有流水不受影响', () => {
  const dir = tmpDir();
  const many = [];
  for (let i = 0; i < MAX_TRADES; i += 1) many.push({ ...buy('2026-03-14', 100, 1), id: `t${i}` });
  writeRaw(dir, JSON.stringify({ version: 1, trades: { sh600519: many } }));

  const store = createTradeStore(dir);
  assert.throws(() => store.add('600519', buy('2026-04-01', 110, 1)), /上限/);
  assert.equal(store.listFor('600519').length, MAX_TRADES, '已有流水必须还在');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('add 会自动建目录', () => {
  const nested = path.join(tmpDir(), 'a', 'b', 'c');
  const store = createTradeStore(nested);
  store.add('600519', buy('2026-03-14', 100, 10));
  assert.ok(fs.existsSync(path.join(nested, FILE_NAME)));
});

test('add 不影响其它股票的流水', () => {
  const dir = tmpDir();
  const store = createTradeStore(dir);
  store.add('600519', buy('2026-03-14', 100, 10));
  store.add('000858', buy('2026-03-15', 200, 20));
  assert.equal(store.listFor('600519').length, 1);
  assert.equal(store.listFor('000858').length, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

// —— remove ——

test('remove 删掉指定的那一笔', () => {
  const dir = tmpDir();
  const store = createTradeStore(dir);
  store.add('600519', buy('2026-03-14', 100, 10));
  const second = store.add('600519', buy('2026-03-15', 110, 10));
  const targetId = second.trades[1].id;

  const r = store.remove('600519', targetId);
  assert.equal(r.trades.length, 1);
  assert.equal(r.trades[0].date, '2026-03-14');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('remove 不存在的 id 不报错也不改动内容（幂等）', () => {
  // 界面上重复点删除按钮不该报错
  const dir = tmpDir();
  const store = createTradeStore(dir);
  store.add('600519', buy('2026-03-14', 100, 10));
  const before = store.listFor('600519');
  const r = store.remove('600519', 'no-such-id');
  assert.equal(r.trades.length, before.length);
  assert.deepEqual(r.trades, before);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('remove 删空后该代码的键被去掉——否则文件里留一堆空数组', () => {
  const dir = tmpDir();
  const store = createTradeStore(dir);
  const r = store.add('600519', buy('2026-03-14', 100, 10));
  store.remove('600519', r.trades[0].id);
  const onDisk = JSON.parse(readRaw(dir));
  assert.ok(!('sh600519' in onDisk.trades), '空数组的键应被删掉');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('remove 返回的 summary 反映删除后的状态', () => {
  const dir = tmpDir();
  const store = createTradeStore(dir);
  store.add('600519', buy('2026-03-14', 100, 100));
  const second = store.add('600519', buy('2026-03-15', 200, 100));
  assert.equal(second.summary.avgCost, 150);

  const r = store.remove('600519', second.trades[1].id);
  assert.equal(r.summary.avgCost, 100, '删掉第二笔后成本回到 100');
  fs.rmSync(dir, { recursive: true, force: true });
});

// —— replaceFor ——

test('replaceFor 整段替换', () => {
  const dir = tmpDir();
  const store = createTradeStore(dir);
  store.add('600519', buy('2026-03-14', 100, 10));
  const r = store.replaceFor('600519', [buy('2026-05-01', 200, 20), buy('2026-06-01', 300, 30)]);
  assert.equal(r.trades.length, 2);
  assert.equal(r.trades[0].date, '2026-05-01');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('replaceFor 给缺 id 的条目补 id', () => {
  const dir = tmpDir();
  const store = createTradeStore(dir);
  const r = store.replaceFor('600519', [buy('2026-03-14', 100, 10)]);
  assert.ok(r.trades[0].id, '新增行应被补上 id');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('replaceFor 保留已有条目的 id', () => {
  const dir = tmpDir();
  const store = createTradeStore(dir);
  const added = store.add('600519', buy('2026-03-14', 100, 10));
  const oldId = added.trades[0].id;
  const r = store.replaceFor('600519', [{ ...added.trades[0] }, buy('2026-04-01', 110, 10)]);
  assert.equal(r.trades[0].id, oldId, '已有条目的 id 不该被换掉');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('replaceFor 丢弃非法条目而不整次拒绝——用户可能留着一行没填完', () => {
  const dir = tmpDir();
  const store = createTradeStore(dir);
  const r = store.replaceFor('600519', [
    buy('2026-03-14', 100, 10),
    { date: '', side: '', price: '', shares: '' }, // 空白行
  ]);
  assert.equal(r.trades.length, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('replaceFor 传空数组等于清空该股票的流水', () => {
  const dir = tmpDir();
  const store = createTradeStore(dir);
  store.add('600519', buy('2026-03-14', 100, 10));
  const r = store.replaceFor('600519', []);
  assert.equal(r.trades.length, 0);
  assert.equal(r.summary.avgCost, null);
  const onDisk = JSON.parse(readRaw(dir));
  assert.ok(!('sh600519' in onDisk.trades));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('replaceFor 不影响其它股票', () => {
  const dir = tmpDir();
  const store = createTradeStore(dir);
  store.add('600519', buy('2026-03-14', 100, 10));
  store.add('000858', buy('2026-03-15', 200, 20));
  store.replaceFor('600519', []);
  assert.equal(store.listFor('000858').length, 1, '另一只的流水必须还在');
  fs.rmSync(dir, { recursive: true, force: true });
});

// —— listFor / summaryFor ——

test('listFor 无记录时返回空数组而非 undefined', () => {
  const store = createTradeStore(tmpDir());
  assert.deepEqual(store.listFor('600519'), []);
});

test('listFor 非法代码返回空数组而不抛', () => {
  // 读操作宽容、写操作严格：界面上切到一只代码有问题的股票不该整块崩掉
  const store = createTradeStore(tmpDir());
  assert.deepEqual(store.listFor('垃圾'), []);
  assert.deepEqual(store.listFor(null), []);
});

test('listFor 接受 6 位与带前缀两种写法', () => {
  const dir = tmpDir();
  const store = createTradeStore(dir);
  store.add('600519', buy('2026-03-14', 100, 10));
  assert.equal(store.listFor('600519').length, 1);
  assert.equal(store.listFor('sh600519').length, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('summaryFor 同时给出流水与回放结果', () => {
  const dir = tmpDir();
  const store = createTradeStore(dir);
  store.add('600519', buy('2026-03-14', 100, 100));
  store.add('600519', sell('2026-04-01', 120, 50));
  const r = store.summaryFor('600519');
  assert.equal(r.trades.length, 2);
  assert.equal(r.summary.shares, 50);
  assert.equal(r.summary.realized, 1000);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('summaryFor 无记录时给出零值 summary', () => {
  const store = createTradeStore(tmpDir());
  const r = store.summaryFor('600519');
  assert.deepEqual(r.trades, []);
  assert.equal(r.summary.shares, 0);
  assert.equal(r.summary.avgCost, null);
});

// —— allDerived ——

test('allDerived 给出各股票的推导持仓', () => {
  const dir = tmpDir();
  const store = createTradeStore(dir);
  store.add('600519', buy('2026-03-14', 1620.5, 100));
  store.add('600519', buy('2026-05-20', 1700, 100));
  store.add('000858', buy('2026-03-15', 150, 200));

  const d = store.allDerived();
  assert.deepEqual(d.sh600519, { cost: 1660.25, shares: 200 });
  assert.deepEqual(d.sz000858, { cost: 150, shares: 200 });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('allDerived 里已清仓的股票 cost 为 null', () => {
  const dir = tmpDir();
  const store = createTradeStore(dir);
  store.add('600519', buy('2026-03-14', 100, 100));
  store.add('600519', sell('2026-04-01', 120, 100));
  const d = store.allDerived();
  assert.deepEqual(d.sh600519, { cost: null, shares: null });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('allDerived 空账本返回空对象', () => {
  assert.deepEqual(createTradeStore(tmpDir()).allDerived(), {});
});

// —— realizedAll ——

test('realizedAll 汇总各股票的已实现盈亏', () => {
  const dir = tmpDir();
  const store = createTradeStore(dir);
  store.add('600519', buy('2026-03-14', 100, 100));
  store.add('600519', sell('2026-04-01', 120, 100)); // +2000
  store.add('000858', buy('2026-03-15', 200, 100));
  store.add('000858', sell('2026-05-01', 180, 100)); // -2000

  const r = store.realizedAll();
  assert.equal(r.byCode.sh600519, 2000);
  assert.equal(r.byCode.sz000858, -2000);
  assert.equal(r.total, 0, '一盈一亏刚好抵平');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('realizedAll 的 byMonth 跨股票累加同月', () => {
  const dir = tmpDir();
  const store = createTradeStore(dir);
  store.add('600519', buy('2026-01-01', 100, 100));
  store.add('600519', sell('2026-04-01', 110, 100)); // +1000 于 2026-04
  store.add('000858', buy('2026-01-01', 200, 100));
  store.add('000858', sell('2026-04-15', 250, 100)); // +5000 于 2026-04

  const r = store.realizedAll();
  assert.equal(r.byMonth['2026-04'], 6000, '同月跨股票要累加');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('realizedAll 空账本返回零值', () => {
  const r = createTradeStore(tmpDir()).realizedAll();
  assert.equal(r.total, 0);
  assert.deepEqual(r.byCode, {});
  assert.deepEqual(r.byMonth, {});
});

test('realizedAll 的 total 不带浮点尾巴', () => {
  const dir = tmpDir();
  const store = createTradeStore(dir);
  store.add('600519', buy('2026-01-01', 0.1, 3));
  store.add('600519', sell('2026-02-01', 0.3, 3));
  const r = store.realizedAll();
  assert.equal(String(r.total), '0.6');
  fs.rmSync(dir, { recursive: true, force: true });
});

// —— makeId ——

test('makeId 产出的 id 互不相同', () => {
  const ids = new Set();
  for (let i = 0; i < 200; i += 1) ids.add(makeId());
  assert.equal(ids.size, 200);
});

test('makeId 产出的是非空字符串', () => {
  const id = makeId();
  assert.equal(typeof id, 'string');
  assert.ok(id.length > 1);
});

// —— 与 configStore 的策略对比 ——

test('对照：configStore 坏文件时静默回落，tradeStore 则拒绝写入', () => {
  // 两者的容错策略故意相反，这条测试把这个设计意图钉在代码里：
  // 配置是可重设的偏好，流水是不可再生的记账数据
  const { createConfigStore } = require('./config');

  const cfgDir = tmpDir();
  fs.writeFileSync(path.join(cfgDir, 'config.json'), '{ BROKEN', 'utf8');
  const cfgStore = createConfigStore(cfgDir);
  assert.doesNotThrow(() => cfgStore.save({ watchlist: ['600519'] }), 'config 坏了照样能写');

  const trDir = tmpDir();
  writeRaw(trDir, '{ BROKEN');
  const trStore = createTradeStore(trDir);
  assert.throws(() => trStore.add('600519', buy('2026-03-14', 100, 10)), '流水坏了必须拒绝写');

  fs.rmSync(cfgDir, { recursive: true, force: true });
  fs.rmSync(trDir, { recursive: true, force: true });
});
