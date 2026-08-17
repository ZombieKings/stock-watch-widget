'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  createConfigStore,
  normalizeConfig,
  normalizeWatchlist,
  isConfigured,
  MIN_REFRESH_MS,
  SECTION_KEYS,
  MODES,
  normalizeMode,
  normalizeAlerts,
  normalizeListHeight,
} = require('./config');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'swconf-'));
}

/**
 * 「所有分组都收起」的期望值，按 SECTION_KEYS 推导。
 *
 * 不硬编码分组名：加新分组时只需在 config.js 登记一处，
 * 否则每加一个数据源都要回来改一批断言。
 */
function allCollapsed(overrides = {}) {
  const out = {};
  for (const key of SECTION_KEYS) out[key] = false;
  return { ...out, ...overrides };
}

test('normalizeConfig 对 null/垃圾输入回落到默认值', () => {
  for (const bad of [null, undefined, 'string', 42, []]) {
    const c = normalizeConfig(bad);
    assert.deepEqual(c.watchlist, []);
    assert.equal(c.selected, '');
    assert.equal(c.refreshMs, 0);
    assert.equal(c.newsLimit, 30);
    assert.equal(c.includeAnnouncements, true);
    assert.equal(c.opacity, 1);
    assert.equal(c.bounds, null);
  }
});

test('关注列表兼容字符串与对象两种写法', () => {
  const list = normalizeWatchlist(['600519', { code: '000858', alias: '五粮液' }]);
  assert.equal(list.length, 2);
  assert.equal(list[0].code, 'sh600519');
  assert.equal(list[0].alias, '');
  assert.equal(list[1].code, 'sz000858');
  assert.equal(list[1].alias, '五粮液');
  assert.equal(list[1].digits, '000858');
});

test('关注列表去重保序，非法项被剔除', () => {
  const list = normalizeWatchlist(['600519', 'sh600519', 'bad', null, { code: '300750' }]);
  assert.deepEqual(list.map((w) => w.code), ['sh600519', 'sz300750']);
});

test('关注列表接受 ETF 并标出 kind/isFund', () => {
  const list = normalizeWatchlist(['510300', '159915', '600519', { code: '161725', alias: '白酒' }]);
  assert.deepEqual(list.map((w) => w.code), ['sh510300', 'sz159915', 'sh600519', 'sz161725']);
  assert.deepEqual(list.map((w) => w.isFund), [true, true, false, true]);
  assert.equal(list[0].kind, 'fund');
  assert.equal(list[2].kind, 'stock');
  assert.equal(list[3].alias, '白酒');
});

test('kind 由代码重新推导，不采信配置文件里存的值', () => {
  // 手改过的配置或旧版本写入的字段可能与代码不符，必须以代码为准
  const list = normalizeWatchlist([
    { code: '510300', kind: 'stock', isFund: false }, // 谎称不是基金
    { code: '600519', kind: 'fund', isFund: true }, // 谎称是基金
  ]);
  assert.equal(list[0].isFund, true, 'ETF 应被纠正为基金');
  assert.equal(list[1].isFund, false, '股票应被纠正为非基金');
});

test('ETF 可以作为 selected 持久化', () => {
  const c = normalizeConfig({ watchlist: ['600519', '510300'], selected: '510300' });
  assert.equal(c.selected, 'sh510300');
  assert.equal(c.watchlist[1].isFund, true);
});

// —— 持仓成本 ——

test('watchlist 条目带 cost/shares 时原样保留', () => {
  const c = normalizeConfig({ watchlist: [{ code: '600519', cost: 1250, shares: 100 }] });
  assert.equal(c.watchlist[0].cost, 1250);
  assert.equal(c.watchlist[0].shares, 100);
});

test('未设持仓时 cost/shares 为 null 而非 undefined', () => {
  const c = normalizeConfig({ watchlist: ['600519'] });
  assert.equal(c.watchlist[0].cost, null);
  assert.equal(c.watchlist[0].shares, null);
});

test('cost 非法值收成 null，不会让盈亏显示 Infinity', () => {
  for (const bad of [0, -5, 'abc', '', null, {}, NaN]) {
    const c = normalizeConfig({ watchlist: [{ code: '600519', cost: bad }] });
    assert.equal(c.watchlist[0].cost, null, `cost=${JSON.stringify(bad)}`);
  }
});

test('cost/shares 接受字符串（设置界面存的是输入框原文）', () => {
  const c = normalizeConfig({ watchlist: [{ code: '600519', cost: '1250.5', shares: '200' }] });
  assert.equal(c.watchlist[0].cost, 1250.5);
  assert.equal(c.watchlist[0].shares, 200);
});

test('shares 为 0 视作未填——只显示比例不显示金额', () => {
  const c = normalizeConfig({ watchlist: [{ code: '600519', cost: 10, shares: 0 }] });
  assert.equal(c.watchlist[0].cost, 10);
  assert.equal(c.watchlist[0].shares, null);
});

test('只填 shares 不填 cost 时 shares 仍保留（用户可能分两次填）', () => {
  const c = normalizeConfig({ watchlist: [{ code: '600519', shares: 100 }] });
  assert.equal(c.watchlist[0].cost, null);
  assert.equal(c.watchlist[0].shares, 100);
});

test('持仓能落盘并读回', () => {
  const dir = tmpDir();
  const store = createConfigStore(dir);
  store.save({ watchlist: [{ code: '600519', cost: 1250, shares: 100 }] });
  const back = store.load().watchlist[0];
  assert.equal(back.cost, 1250);
  assert.equal(back.shares, 100);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('回归：patch 其他字段不会冲掉持仓', () => {
  // saveSettings 之外的 patch（选股、bounds、折叠态）都不该碰 watchlist
  const dir = tmpDir();
  const store = createConfigStore(dir);
  store.save({ watchlist: [{ code: '600519', cost: 1250, shares: 100 }], selected: 'sh600519' });
  store.patch({ selected: 'sh600519', collapsed: true });
  store.patch({ bounds: { x: 1, y: 2, width: 340, height: 580 } });
  const back = store.load().watchlist[0];
  assert.equal(back.cost, 1250, '持仓成本必须还在');
  assert.equal(back.shares, 100);
  fs.rmSync(dir, { recursive: true, force: true });
});

// —— 折叠模式 ——

test('collapsed 缺省为 false', () => {
  assert.equal(normalizeConfig({}).collapsed, false);
  assert.equal(normalizeConfig(null).collapsed, false);
});

test('collapsed 只认布尔值，脏数据回落到 false', () => {
  assert.equal(normalizeConfig({ collapsed: true }).collapsed, true);
  assert.equal(normalizeConfig({ collapsed: false }).collapsed, false);
  // 手改过的配置里可能是字符串或数字，'false' 若被当真值会导致启动即折叠
  for (const bad of ['true', 'false', 1, 0, null, {}, []]) {
    assert.equal(normalizeConfig({ collapsed: bad }).collapsed, false, `collapsed=${JSON.stringify(bad)}`);
  }
});

test('折叠态能随配置落盘并读回（经 mode）', () => {
  // 注意写的是 mode 而不是 collapsed —— 后者自 三态改造 起是 mode 的投影，
  // 单独 patch 它不生效（这正是「两个字段各自独立写会漂移」要防的事）
  const dir = tmpDir();
  const store = createConfigStore(dir);
  store.save({ watchlist: ['600519'], mode: 'collapsed' });
  assert.equal(store.load().collapsed, true);
  assert.equal(store.load().mode, 'collapsed');
  store.patch({ mode: 'expanded' });
  assert.equal(store.load().collapsed, false);
  assert.equal(store.load().mode, 'expanded');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('折叠态下 patch bounds 不影响 collapsed', () => {
  // 主进程的 persistBounds 只 patch bounds，collapsed 必须保持
  const dir = tmpDir();
  const store = createConfigStore(dir);
  store.save({ watchlist: ['600519'], collapsed: true, bounds: { x: 0, y: 0, width: 340, height: 580 } });
  store.patch({ bounds: { x: 500, y: 200, width: 340, height: 580 } });
  const c = store.load();
  assert.equal(c.collapsed, true);
  assert.equal(c.bounds.x, 500);
  assert.equal(c.bounds.height, 580);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('selected 不在关注列表内时回落到首个', () => {
  const c = normalizeConfig({ watchlist: ['600519', '000858'], selected: '300750' });
  assert.equal(c.selected, 'sh600519');
});

test('selected 在列表内时保留', () => {
  const c = normalizeConfig({ watchlist: ['600519', '000858'], selected: '000858' });
  assert.equal(c.selected, 'sz000858');
});

test('关注列表为空时 selected 为空串', () => {
  assert.equal(normalizeConfig({ watchlist: [], selected: '600519' }).selected, '');
});

test('refreshMs：0 表示自动，正数被夹到下限以上', () => {
  assert.equal(normalizeConfig({ refreshMs: 0 }).refreshMs, 0);
  assert.equal(normalizeConfig({ refreshMs: -5 }).refreshMs, 0);
  assert.equal(normalizeConfig({ refreshMs: 'abc' }).refreshMs, 0);
  // 用户填 100ms 会把接口打爆，夹到下限
  assert.equal(normalizeConfig({ refreshMs: 100 }).refreshMs, MIN_REFRESH_MS);
  assert.equal(normalizeConfig({ refreshMs: 5000 }).refreshMs, 5000);
});

test('newsLimit 与 opacity 被夹在合法区间', () => {
  assert.equal(normalizeConfig({ newsLimit: 1 }).newsLimit, 5);
  assert.equal(normalizeConfig({ newsLimit: 9999 }).newsLimit, 200);
  assert.equal(normalizeConfig({ opacity: 0 }).opacity, 0.3);
  assert.equal(normalizeConfig({ opacity: 5 }).opacity, 1);
  assert.equal(normalizeConfig({ opacity: 0.6 }).opacity, 0.6);
});

test('布尔项非布尔值时用默认值', () => {
  assert.equal(normalizeConfig({ includeAnnouncements: 'yes' }).includeAnnouncements, true);
  assert.equal(normalizeConfig({ includeAnnouncements: false }).includeAnnouncements, false);
  assert.equal(normalizeConfig({ todayOnly: 1 }).todayOnly, false);
  assert.equal(normalizeConfig({ todayOnly: true }).todayOnly, true);
});

test('autoHide 默认关，且只认严格布尔', () => {
  // 默认关：这个功能会让窗口主动从视野里消失，而它没有任务栏入口可确认，
  // 没预期到的用户会以为挂件崩了
  assert.equal(normalizeConfig({}).autoHide, false);
  assert.equal(normalizeConfig(null).autoHide, false);
  assert.equal(normalizeConfig({ autoHide: true }).autoHide, true);
  // 手改过的配置里的字符串不能当真值 —— 那会让窗口莫名开始自己往屏幕外躲
  assert.equal(normalizeConfig({ autoHide: 'false' }).autoHide, false);
  assert.equal(normalizeConfig({ autoHide: 'true' }).autoHide, false);
  assert.equal(normalizeConfig({ autoHide: 1 }).autoHide, false);
});

test('autoHide 能被 patch 单独改，不连带丢掉别的字段', () => {
  // 与 sections/alerts 不同，autoHide 是标量，浅合并就够；这条盯着它别被漏进
  // 某个需要深合并的分支里
  const n = normalizeConfig({ autoHide: true, todayOnly: true, opacity: 0.8 });
  assert.equal(n.autoHide, true);
  assert.equal(n.todayOnly, true);
  assert.equal(n.opacity, 0.8);
});

test('bounds 字段不全时整体丢弃', () => {
  assert.equal(normalizeConfig({ bounds: { x: 1, y: 2 } }).bounds, null);
  assert.equal(normalizeConfig({ bounds: 'nope' }).bounds, null);
  assert.deepEqual(normalizeConfig({ bounds: { x: 1, y: 2, width: 3, height: 4 } }).bounds, {
    x: 1,
    y: 2,
    width: 3,
    height: 4,
  });
});

test('isConfigured 要求至少一只有效股票', () => {
  assert.equal(isConfigured(null), false);
  assert.equal(isConfigured({ watchlist: [] }), false);
  assert.equal(isConfigured({ watchlist: ['bad'] }), false);
  assert.equal(isConfigured({ watchlist: ['600519'] }), true);
});

test('store 首次 load 返回默认配置（文件不存在）', () => {
  const store = createConfigStore(tmpDir());
  const cfg = store.load();
  assert.deepEqual(cfg.watchlist, []);
});

test('store 存取往返一致', () => {
  const store = createConfigStore(tmpDir());
  const saved = store.save({ watchlist: ['600519', '000858'], selected: '000858', refreshMs: 5000 });
  assert.equal(saved.selected, 'sz000858');

  const loaded = store.load();
  assert.deepEqual(loaded.watchlist.map((w) => w.code), ['sh600519', 'sz000858']);
  assert.equal(loaded.selected, 'sz000858');
  assert.equal(loaded.refreshMs, 5000);
});

test('store 遇到损坏 JSON 回落默认值而不是崩', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'config.json'), '{ this is not json', 'utf8');
  const store = createConfigStore(dir);
  assert.deepEqual(store.load().watchlist, []);
});

test('patch 只改指定字段，其余保留', () => {
  const store = createConfigStore(tmpDir());
  store.save({ watchlist: ['600519', '000858'], selected: '600519', newsLimit: 50 });

  const patched = store.patch({ selected: '000858' });
  assert.equal(patched.selected, 'sz000858');
  assert.equal(patched.newsLimit, 50); // 未受影响
  assert.equal(patched.watchlist.length, 2);
});

test('save 会自动建目录', () => {
  const nested = path.join(tmpDir(), 'a', 'b', 'c');
  const store = createConfigStore(nested);
  store.save({ watchlist: ['600519'] });
  assert.ok(fs.existsSync(path.join(nested, 'config.json')));
});

// —— sections（可折叠分组的展开态）——

test('normalizeConfig 补齐 sections 默认值：所有分组都收起', () => {
  const c = normalizeConfig({});
  assert.deepEqual(c.sections, allCollapsed());
});

test('normalizeConfig 保留合法的 sections 值', () => {
  const c = normalizeConfig({ sections: { indicators: true, flow: false } });
  assert.equal(c.sections.indicators, true);
  assert.equal(c.sections.flow, false);
});

test('normalizeConfig 丢弃 sections 里的未知键与非布尔值', () => {
  const c = normalizeConfig({
    sections: { indicators: 'yes', flow: 1, 未登记的分组: true },
  });
  // 非布尔回落到默认，未登记的键不落盘
  assert.deepEqual(c.sections, allCollapsed());
});

test('normalizeConfig 的 sections 不是对象时回落到默认', () => {
  for (const bad of [null, 'x', 42, []]) {
    assert.deepEqual(normalizeConfig({ sections: bad }).sections, allCollapsed());
  }
});

test('旧版配置文件（无 sections 字段）能正常读出', () => {
  const c = normalizeConfig({ watchlist: [{ code: 'sh600519' }], selected: 'sh600519', collapsed: true });
  assert.deepEqual(c.sections, allCollapsed());
  assert.equal(c.collapsed, true, '其它字段不受影响');
});

test('SECTION_KEYS 里每个分组都有默认值，且默认全为收起', () => {
  // 漏登记默认值会让 normalizeSections 写入 undefined，配置落盘后再读出变成缺键
  const c = normalizeConfig({});
  for (const key of SECTION_KEYS) {
    assert.equal(typeof c.sections[key], 'boolean', `${key} 应有布尔默认值`);
    assert.equal(c.sections[key], false, `${key} 默认应收起（每个分组都要额外发一次请求）`);
  }
});

test('patch 深合并 sections：改一个分组不会重置另一个', () => {
  const store = createConfigStore(tmpDir());
  store.save({ watchlist: [{ code: 'sh600519' }], sections: { indicators: true, flow: true } });

  // 只提交 flow —— 浅合并会让 indicators 掉回默认的 false
  const after = store.patch({ sections: { flow: false } });
  assert.equal(after.sections.flow, false);
  assert.equal(after.sections.indicators, true, 'indicators 应保持展开');

  // 落盘后重读也要一致，不能只是内存里对
  assert.equal(store.load().sections.indicators, true);
});

test('patch 不带 sections 时保留原有展开态', () => {
  const store = createConfigStore(tmpDir());
  store.save({ watchlist: [{ code: 'sh600519' }], sections: { indicators: true, flow: true } });
  const after = store.patch({ selected: 'sh600519' });
  assert.deepEqual(after.sections, allCollapsed({ indicators: true, flow: true }));
});

// —— mode（三态窗口）——

test('mode 缺省为 expanded', () => {
  assert.equal(normalizeConfig({}).mode, 'expanded');
  assert.equal(normalizeConfig(null).mode, 'expanded');
});

test('mode 只认三个登记值，脏数据回落 expanded', () => {
  for (const m of MODES) assert.equal(normalizeConfig({ mode: m }).mode, m);
  for (const bad of ['garbage', '', 'Expanded', 1, 0, null, {}, [], true]) {
    assert.equal(normalizeConfig({ mode: bad }).mode, 'expanded', `mode=${JSON.stringify(bad)}`);
  }
});

test('旧配置只有 collapsed:true 时 mode 推导为 collapsed', () => {
  // 兼容性核心：装过旧版的用户升级后，启动态必须与升级前一致
  const c = normalizeConfig({ watchlist: ['600519'], collapsed: true });
  assert.equal(c.mode, 'collapsed');
  assert.equal(c.collapsed, true);
});

test('旧配置只有 collapsed:false 时 mode 推导为 expanded', () => {
  const c = normalizeConfig({ watchlist: ['600519'], collapsed: false });
  assert.equal(c.mode, 'expanded');
  assert.equal(c.collapsed, false);
});

test('两个字段都没有（更旧的配置）时回落 expanded', () => {
  const c = normalizeConfig({ watchlist: ['600519'], selected: 'sh600519' });
  assert.equal(c.mode, 'expanded');
  assert.equal(c.collapsed, false);
});

test('mode 与 collapsed 冲突时以 mode 为准', () => {
  // 手改过的配置会出现这种输入，采信新字段而不是猜
  assert.equal(normalizeConfig({ mode: 'expanded', collapsed: true }).mode, 'expanded');
  assert.equal(normalizeConfig({ mode: 'collapsed', collapsed: false }).mode, 'collapsed');
  assert.equal(normalizeConfig({ mode: 'list', collapsed: true }).mode, 'list');
});

test('collapsed 始终是 mode 的投影，不采信原值', () => {
  // 两个字段各自独立读写会漂移，只保一个方向的推导就不会
  assert.equal(normalizeConfig({ mode: 'expanded', collapsed: true }).collapsed, false);
  assert.equal(normalizeConfig({ mode: 'collapsed', collapsed: false }).collapsed, true);
  assert.equal(normalizeConfig({ mode: 'list', collapsed: true }).collapsed, false);
});

test('mode=list 落盘后 collapsed 写的是 false——旧版读到会展开，是合理降级', () => {
  const dir = tmpDir();
  const store = createConfigStore(dir);
  store.save({ watchlist: ['600519'], mode: 'list' });
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
  assert.equal(onDisk.mode, 'list');
  assert.equal(onDisk.collapsed, false, '旧版本没有列表模式，展开比折叠更接近用户想看的');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('mode 能落盘并读回三种值', () => {
  const dir = tmpDir();
  const store = createConfigStore(dir);
  for (const m of MODES) {
    store.patch({ mode: m });
    assert.equal(store.load().mode, m, `mode=${m}`);
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test('normalizeMode 可单独调用（main.js 启动时用它读初始模式）', () => {
  assert.equal(normalizeMode({ mode: 'list' }), 'list');
  assert.equal(normalizeMode({ collapsed: true }), 'collapsed');
  assert.equal(normalizeMode({}), 'expanded');
  assert.equal(normalizeMode(null), 'expanded');
});

test('回归：patch({mode}) 不冲掉 watchlist 持仓', () => {
  const dir = tmpDir();
  const store = createConfigStore(dir);
  store.save({ watchlist: [{ code: '600519', cost: 1250, shares: 100 }], selected: 'sh600519' });
  store.patch({ mode: 'list' });
  const back = store.load();
  assert.equal(back.mode, 'list');
  assert.equal(back.watchlist[0].cost, 1250, '持仓必须还在');
  assert.equal(back.watchlist[0].shares, 100);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('回归：patch({mode}) 不冲掉分组展开态', () => {
  const store = createConfigStore(tmpDir());
  store.save({ watchlist: ['600519'], sections: { indicators: true, lhb: true } });
  const after = store.patch({ mode: 'collapsed' });
  assert.equal(after.mode, 'collapsed');
  assert.deepEqual(after.sections, allCollapsed({ indicators: true, lhb: true }));
});

test('非展开态下 patch bounds 不影响 mode', () => {
  // 主进程的 persistBounds 只 patch bounds，mode 必须保持
  const dir = tmpDir();
  const store = createConfigStore(dir);
  store.save({ watchlist: ['600519'], mode: 'list', bounds: { x: 0, y: 0, width: 340, height: 580 } });
  store.patch({ bounds: { x: 500, y: 200, width: 340, height: 580 } });
  const c = store.load();
  assert.equal(c.mode, 'list');
  assert.equal(c.bounds.x, 500);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('config 的 MODES 与 windowLayout 的 MODES 是同一份约定', () => {
  // 两边各留一份三元素数组（config 不该依赖窗口几何模块），靠这条测试盯着不漂移。
  // 顺序也要一致：windowLayout.nextMode 按数组顺序轮换，两边不同会让
  // 「配置里存的模式」与「轮换到的下一个模式」对不上
  const layoutModes = require('./windowLayout').MODES;
  assert.deepEqual(MODES, layoutModes);
});

// —— alerts（价格预警）——

/** 造一条规则 */
function alertRule(kind, dir, value) {
  return { kind, dir, value };
}

test('normalizeConfig 补齐 alerts 默认值：总开关开、无规则', () => {
  const c = normalizeConfig({});
  assert.equal(c.alerts.enabled, true);
  assert.deepEqual(c.alerts.rules, {});
});

test('alerts 不是对象时回落到默认', () => {
  for (const bad of [null, 'x', 42, []]) {
    const c = normalizeConfig({ alerts: bad });
    assert.equal(c.alerts.enabled, true, `alerts=${JSON.stringify(bad)}`);
    assert.deepEqual(c.alerts.rules, {});
  }
});

test('alerts.enabled 只认布尔，脏数据回落 true', () => {
  assert.equal(normalizeConfig({ alerts: { enabled: false } }).alerts.enabled, false);
  for (const bad of ['false', 0, null, {}]) {
    assert.equal(
      normalizeConfig({ alerts: { enabled: bad } }).alerts.enabled,
      true,
      `enabled=${JSON.stringify(bad)}`
    );
  }
});

test('normalizeAlerts 规范化代码键（600519 → sh600519）', () => {
  const a = normalizeAlerts({ rules: { 600519: [alertRule('changePct', 'gte', 5)] } });
  assert.ok(a.rules.sh600519, '键应被规范化');
  assert.equal(a.rules.sh600519.length, 1);
});

test('normalizeAlerts 丢弃非法代码键', () => {
  const a = normalizeAlerts({
    rules: { 600519: [alertRule('price', 'gte', 1)], 垃圾: [alertRule('price', 'gte', 1)] },
  });
  assert.deepEqual(Object.keys(a.rules), ['sh600519']);
});

test('normalizeAlerts 删掉空规则数组的键——否则配置文件单调膨胀', () => {
  const a = normalizeAlerts({
    rules: {
      sh600519: [alertRule('changePct', 'gte', 5)],
      sz000858: [],
      sz300750: [{ kind: 'bad' }], // 全部非法 → 空
    },
  });
  assert.deepEqual(Object.keys(a.rules), ['sh600519']);
});

test('normalizeAlerts 保留不在 watchlist 里的孤儿规则', () => {
  // 用户可能先删股票再加回来，规则留着比丢掉更符合预期。
  // 孤儿规则不参与匹配（evaluateAlerts 只遍历行情 items）
  const c = normalizeConfig({
    watchlist: ['600519'],
    alerts: { rules: { sz000858: [alertRule('changePct', 'gte', 5)] } },
  });
  assert.ok(c.alerts.rules.sz000858, '不在关注列表里的规则也要留着');
});

test('alerts 规则的校验委托给 alertRules（非法 kind/dir 被丢弃）', () => {
  const a = normalizeAlerts({
    rules: { sh600519: [alertRule('bad', 'gte', 5), alertRule('price', 'bad', 5), alertRule('price', 'gte', 5)] },
  });
  assert.equal(a.rules.sh600519.length, 1, '只留合法那条');
});

test('alerts 能落盘并读回', () => {
  const dir = tmpDir();
  const store = createConfigStore(dir);
  store.save({
    watchlist: ['600519'],
    alerts: { enabled: false, rules: { sh600519: [alertRule('changePct', 'lte', -5)] } },
  });
  const back = store.load();
  assert.equal(back.alerts.enabled, false);
  assert.equal(back.alerts.rules.sh600519[0].value, -5);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('回归：patch({alerts:{enabled:false}}) 不冲掉 rules', () => {
  // 与 sections 那个已修的坑同源，但更贵：浅合并会把整个 rules 换成 {}，
  // 用户配的所有预警规则静默消失
  const dir = tmpDir();
  const store = createConfigStore(dir);
  store.save({
    watchlist: ['600519'],
    alerts: { enabled: true, rules: { sh600519: [alertRule('changePct', 'gte', 5)] } },
  });

  const after = store.patch({ alerts: { enabled: false } });
  assert.equal(after.alerts.enabled, false);
  assert.ok(after.alerts.rules.sh600519, '规则必须还在');
  // 落盘后重读也要一致，不能只是内存里对
  assert.ok(store.load().alerts.rules.sh600519);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('patch 传 alerts.rules 时整体替换——否则删不掉规则', () => {
  // 做成合并语义的话「删掉某只股票的全部规则」就表达不出来了
  const dir = tmpDir();
  const store = createConfigStore(dir);
  store.save({
    watchlist: ['600519', '000858'],
    alerts: {
      rules: { sh600519: [alertRule('changePct', 'gte', 5)], sz000858: [alertRule('price', 'lte', 100)] },
    },
  });

  // 只提交 sh600519 → sz000858 的规则应被删掉
  const after = store.patch({ alerts: { rules: { sh600519: [alertRule('changePct', 'gte', 8)] } } });
  assert.equal(after.alerts.rules.sh600519[0].value, 8);
  assert.ok(!after.alerts.rules.sz000858, '整体替换语义下未提交的键应消失');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('patch 不带 alerts 时保留原有规则', () => {
  const dir = tmpDir();
  const store = createConfigStore(dir);
  store.save({ watchlist: ['600519'], alerts: { rules: { sh600519: [alertRule('changePct', 'gte', 5)] } } });
  const after = store.patch({ selected: 'sh600519' });
  assert.ok(after.alerts.rules.sh600519, '规则必须还在');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('回归：patch({mode}) 不冲掉预警规则', () => {
  const dir = tmpDir();
  const store = createConfigStore(dir);
  store.save({ watchlist: ['600519'], alerts: { rules: { sh600519: [alertRule('price', 'lte', 1300)] } } });
  store.patch({ mode: 'list' });
  assert.ok(store.load().alerts.rules.sh600519);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('回归：patch({sections}) 不冲掉 alerts，反之亦然', () => {
  const dir = tmpDir();
  const store = createConfigStore(dir);
  store.save({
    watchlist: ['600519'],
    sections: { indicators: true },
    alerts: { rules: { sh600519: [alertRule('price', 'lte', 1300)] } },
  });

  store.patch({ sections: { flow: true } });
  let c = store.load();
  assert.ok(c.alerts.rules.sh600519, 'patch sections 不该动 alerts');
  assert.equal(c.sections.indicators, true);

  store.patch({ alerts: { enabled: false } });
  c = store.load();
  assert.equal(c.sections.indicators, true, 'patch alerts 不该动 sections');
  assert.equal(c.sections.flow, true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('旧版配置文件（无 alerts 字段）能正常读出', () => {
  const c = normalizeConfig({ watchlist: [{ code: 'sh600519' }], selected: 'sh600519', collapsed: true });
  assert.equal(c.alerts.enabled, true);
  assert.deepEqual(c.alerts.rules, {});
  assert.equal(c.mode, 'collapsed', '其它字段不受影响');
});

// —— listHeight（列表模式手动缩放）——

test('listHeight 缺省为 null——表示「从未手动调过，按行数自动定高」', () => {
  assert.equal(normalizeConfig({}).listHeight, null);
  assert.equal(normalizeConfig(null).listHeight, null);
});

test('listHeight 保留合法的手动高度', () => {
  assert.equal(normalizeConfig({ listHeight: 300 }).listHeight, 300);
  assert.equal(normalizeConfig({ listHeight: '450' }).listHeight, 450);
  assert.equal(normalizeConfig({ listHeight: 138.6 }).listHeight, 139, '取整');
});

test('listHeight 非法值收成 null 而非某个默认数字', () => {
  // null 的语义是「按行数自动定高」。给默认值等于替用户做了「他调过高度」
  // 的决定，自动定高就永久失效了
  for (const bad of ['abc', '', NaN, {}, [], -100, 0, 10, 9999, true]) {
    assert.equal(normalizeConfig({ listHeight: bad }).listHeight, null, `listHeight=${JSON.stringify(bad)}`);
  }
});

test('normalizeListHeight 可单独调用', () => {
  assert.equal(normalizeListHeight(300), 300);
  assert.equal(normalizeListHeight(null), null);
  assert.equal(normalizeListHeight(10), null, '低于粗筛下限');
  assert.equal(normalizeListHeight(5000), null, '高于任何屏幕');
});

test('listHeight 与 bounds.height 是两个独立字段', () => {
  // 混用会让列表态的紧凑高度（4 行 = 138px）冲掉展开态高度：
  // safeExpandedHeight 会判 138 非法并回落到 580，用户拖的展开高度就丢了
  const c = normalizeConfig({
    bounds: { x: 0, y: 0, width: 340, height: 640 },
    listHeight: 138,
  });
  assert.equal(c.bounds.height, 640, '展开高度不受影响');
  assert.equal(c.listHeight, 138);
});

test('listHeight 能落盘并读回', () => {
  const dir = tmpDir();
  const store = createConfigStore(dir);
  store.save({ watchlist: ['600519'], mode: 'list', listHeight: 300 });
  assert.equal(store.load().listHeight, 300);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('回归：patch bounds 不冲掉 listHeight', () => {
  // 主进程的 persistBounds 在列表态会同时 patch 两者，但在展开态只 patch bounds，
  // 那时 listHeight 必须保持
  const dir = tmpDir();
  const store = createConfigStore(dir);
  store.save({ watchlist: ['600519'], listHeight: 300 });
  store.patch({ bounds: { x: 500, y: 200, width: 340, height: 640 } });
  assert.equal(store.load().listHeight, 300, '列表高度必须还在');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('回归：patch listHeight 不冲掉 bounds 与持仓', () => {
  const dir = tmpDir();
  const store = createConfigStore(dir);
  store.save({
    watchlist: [{ code: '600519', cost: 1250, shares: 100 }],
    bounds: { x: 100, y: 100, width: 340, height: 640 },
  });
  store.patch({ listHeight: 300 });
  const c = store.load();
  assert.equal(c.listHeight, 300);
  assert.equal(c.bounds.height, 640);
  assert.equal(c.watchlist[0].cost, 1250);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('旧版配置文件（无 listHeight 字段）能正常读出', () => {
  const c = normalizeConfig({ watchlist: ['600519'], mode: 'list' });
  assert.equal(c.listHeight, null, '按行数自动定高，与改造前行为一致');
  assert.equal(c.mode, 'list');
});

test('config 的 listHeight 粗筛与 windowLayout 的 safeListHeight 不冲突', () => {
  // 两层校验：config 只挡明显坏的值（<60 或 >4000），精确的下限
  // （LIST_MIN_H）由 windowLayout 负责。config 放得更松是对的 ——
  // 它不该知道列表一行有多高
  const { safeListHeight, LIST_MIN_H } = require('./windowLayout');
  // config 放过的值，windowLayout 可能仍然拒绝（比如 60 < LIST_MIN_H 时）
  assert.equal(normalizeListHeight(LIST_MIN_H), LIST_MIN_H, 'config 该放过合法的列表高度');
  assert.equal(safeListHeight(LIST_MIN_H), LIST_MIN_H, 'windowLayout 也该接受');
  // 两层都拒绝的值
  assert.equal(normalizeListHeight(10), null);
  assert.equal(safeListHeight(10), null);
});
