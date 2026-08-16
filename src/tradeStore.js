'use strict';

/**
 * 交易流水的落盘。存于 %APPDATA%/StockWatchWidget/trades.json。
 *
 * 与 config.js 分开存，四条理由：
 *   1. 写放大 —— config.patch 是「读全量 → 合并 → 写全量」，折叠一个分组都要
 *      重写整个文件。流水攒到几百笔后每次开合都要连带序列化一遍
 *   2. 爆炸半径 —— config.json 坏了会丢关注列表 + 窗口位置 + 预警规则；
 *      流水单独存则互不牵连，反过来也成立
 *   3. 生命周期 —— 配置是可重设的偏好，流水是**用户手输的不可再生记账数据**
 *   4. 备份粒度 —— 用户会想备份流水，不会想备份窗口坐标
 *
 * **容错策略与 configStore 故意相反**，这是本文件最重要的一点：
 * config 遇到坏 JSON 静默回落默认值（那些都是可重设的偏好），
 * 流水遇到坏 JSON 必须**保留原文件并拒绝写入** —— 静默用空账本覆盖掉
 * 可能只坏了一个字节的记账数据是不可接受的。见 load / assertWritable。
 */

const fs = require('fs');
const path = require('path');
const { normalizeCode } = require('./stockCode');
const { normalizeTrades, normalizeTradeBook, replayTrades, MAX_TRADES } = require('./trades');

const FILE_NAME = 'trades.json';

/**
 * 文件格式版本。
 *
 * 现在没有用处，但流水是会跟着用户很多年的数据，留一个版本号比将来靠
 * 字段探测去猜格式便宜得多。
 */
const VERSION = 1;

/** 生成一个够用的唯一 id。流水量级在百这个数量级，时间戳 + 随机后缀足够 */
function makeId() {
  return `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 创建流水存储。
 * @param {string} userDataDir 一般传 app.getPath('userData')
 */
function createTradeStore(userDataDir) {
  const filePath = path.join(userDataDir, FILE_NAME);

  /**
   * 上次读取是否失败（文件存在但内容坏了）。
   *
   * 置位后所有写操作都会拒绝 —— 见 assertWritable。文件不存在**不算**失败：
   * 首次运行本来就没有文件，那时必须能写。
   */
  let loadError = '';

  /**
   * 读流水。
   *
   * 三种情况分开处理：
   *   文件不存在  → 空账本，loadError 清空（首次运行，必须能写）
   *   内容坏了    → 空账本 + 置 loadError（界面显示错误，且后续写入被拒）
   *   正常        → 规范化后的账本，loadError 清空
   *
   * 「规范化丢弃了一些条目」不算 loadError：那是单条流水格式不对（用户手改过
   * 文件、或旧版本写入的字段），剩下的仍然可用可写。只有**整个文件解析不了**
   * 才算失败 —— 那时我们对文件内容一无所知，不能拿空账本去覆盖。
   */
  function load() {
    let text;
    try {
      text = fs.readFileSync(filePath, 'utf8');
    } catch {
      // ENOENT 与权限问题都走这里。前者是正常的首次运行；后者写也会失败，
      // 到时由 save 自己报错，不必在这里提前拦
      loadError = '';
      return { version: VERSION, trades: {}, loadError: '' };
    }

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      loadError = `流水文件无法解析：${err && err.message}`;
      return { version: VERSION, trades: {}, loadError };
    }

    loadError = '';
    // 代码键在这里校验（trades.js 不认识股票代码格式，保持纯粹）
    const src = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    const raw = src.trades && typeof src.trades === 'object' ? src.trades : {};
    const byCode = {};
    for (const [key, list] of Object.entries(raw)) {
      const r = normalizeCode(key);
      if (!r.ok) continue;
      byCode[r.code] = list;
    }

    return { version: VERSION, trades: normalizeTradeBook(byCode), loadError: '' };
  }

  /**
   * 写之前必须过这一关。
   *
   * 读失败时抛错而不是静默跳过：调用方（IPC handler）会把错误原样返回给界面，
   * 用户看到「流水文件读取失败，未做任何修改」比看到「保存成功但数据没了」好得多。
   */
  function assertWritable() {
    if (loadError) {
      throw new Error(`${loadError}。为避免覆盖原文件，已拒绝写入 —— 请先修复或备份后删除 ${filePath}`);
    }
  }

  function writeBook(trades) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify({ version: VERSION, trades }, null, 2), 'utf8');
  }

  /** 某只股票的流水。代码非法或无记录时返回空数组 */
  function listFor(code) {
    const r = normalizeCode(code);
    if (!r.ok) return [];
    return load().trades[r.code] || [];
  }

  /** 某只股票的流水 + 回放结果。IPC 的主力返回形状 */
  function summaryFor(code) {
    const trades = listFor(code);
    return { trades, summary: replayTrades(trades) };
  }

  /**
   * 加一笔。
   * @returns {{ trades, summary }} 加完之后的完整状态
   * @throws 代码非法、流水非法、超上限、或读文件失败时抛
   */
  function add(code, raw) {
    const r = normalizeCode(code);
    if (!r.ok) throw new Error(r.error);
    const book = load();
    assertWritable();

    const cur = book.trades[r.code] || [];
    if (cur.length >= MAX_TRADES) {
      throw new Error(`该股票的流水已达上限 ${MAX_TRADES} 笔`);
    }

    // 先规范化再落盘：非法输入在这里就被挡住，不会写进文件。
    // id 由本层生成 —— 渲染层不该操心唯一性
    const withId = { ...(raw && typeof raw === 'object' ? raw : {}), id: makeId() };
    const list = normalizeTrades([...cur, withId]);
    if (list.length !== cur.length + 1) {
      throw new Error('流水格式不正确：请检查日期、方向、价格与数量');
    }

    const next = { ...book.trades, [r.code]: list };
    writeBook(next);
    return { trades: list, summary: replayTrades(list) };
  }

  /**
   * 删一笔。删不存在的 id 不算错误（幂等），但会照原样重写文件 ——
   * 界面上重复点删除按钮不该报错。
   */
  function remove(code, tradeId) {
    const r = normalizeCode(code);
    if (!r.ok) throw new Error(r.error);
    const book = load();
    assertWritable();

    const cur = book.trades[r.code] || [];
    const list = cur.filter((t) => t.id !== tradeId);

    const next = { ...book.trades };
    // 删空了就把这个键去掉，否则文件里会留一堆空数组
    if (list.length > 0) next[r.code] = list;
    else delete next[r.code];

    writeBook(next);
    return { trades: list, summary: replayTrades(list) };
  }

  /**
   * 整段替换某只股票的流水。设置面板「保存」走这条。
   *
   * 缺 id 的条目会补上 —— 界面可能直接提交用户编辑过的数组，
   * 新增行没有 id。非法条目被 normalizeTrades 丢弃（不报错：整段保存时
   * 用户可能留着一行空白输入没填完，为此拒绝整次保存太苛刻）。
   */
  function replaceFor(code, rawList) {
    const r = normalizeCode(code);
    if (!r.ok) throw new Error(r.error);
    const book = load();
    assertWritable();

    const withIds = (Array.isArray(rawList) ? rawList : []).map((t) => ({
      ...(t && typeof t === 'object' ? t : {}),
      id: t && typeof t === 'object' && typeof t.id === 'string' && t.id ? t.id : makeId(),
    }));
    const list = normalizeTrades(withIds);

    const next = { ...book.trades };
    if (list.length > 0) next[r.code] = list;
    else delete next[r.code];

    writeBook(next);
    return { trades: list, summary: replayTrades(list) };
  }

  /**
   * 全部股票的推导持仓 { [code]: {cost, shares} }。
   *
   * main.js 的 holdingsFor 用它一次性拿到覆盖表，避免为每只股票单独读一遍文件 ——
   * collectWatchlist 要给整个关注列表算盈亏，逐个 listFor 会把文件读 N 遍。
   */
  function allDerived() {
    const { trades } = load();
    const out = {};
    for (const [code, list] of Object.entries(trades)) {
      const s = replayTrades(list);
      out[code] = { cost: s.avgCost, shares: s.shares > 0 ? s.shares : null };
    }
    return out;
  }

  /** 各股票的已实现盈亏汇总。get-realized 用 */
  function realizedAll() {
    const { trades } = load();
    const byCode = {};
    const byMonth = {};
    let total = 0;
    for (const [code, list] of Object.entries(trades)) {
      const s = replayTrades(list);
      byCode[code] = s.realized;
      total += s.realized;
      for (const [mk, v] of Object.entries(s.realizedByMonth)) {
        byMonth[mk] = Math.round(((byMonth[mk] || 0) + v) * 100) / 100;
      }
    }
    return { total: Math.round(total * 100) / 100, byCode, byMonth };
  }

  return {
    filePath,
    load,
    listFor,
    summaryFor,
    add,
    remove,
    replaceFor,
    allDerived,
    realizedAll,
    /** 只读：当前是否处于「读失败、拒绝写入」状态。界面据此显示警告 */
    get loadError() {
      return loadError;
    },
  };
}

module.exports = { createTradeStore, FILE_NAME, VERSION, makeId };
