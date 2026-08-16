'use strict';

/**
 * A 股代码规范化。
 *
 * 统一把用户各种写法（600519 / SH600519 / 600519.SH / sh600519）转成
 * 腾讯行情要求的 `sh600519` 形式，并给出交易所标记。
 */

/** 上交所前缀段：6=主板, 9=B股, 5=基金/ETF, 7=配股 */
const SH_PREFIX = ['6', '9', '5', '7'];
/** 深交所前缀段：0=主板, 3=创业板, 2=B股, 1=基金/债 */
const SZ_PREFIX = ['0', '3', '2', '1'];
/** 北交所前缀段：4=新三板精选, 8=北交所 */
const BJ_PREFIX = ['4', '8'];

/**
 * 场内基金代码段（ETF / LOF / 封闭式）。
 *
 *   沪 5xxxxx —— 51/56/58 宽基与行业 ETF、588 科创 ETF、511 货币 ETF、
 *                513 跨境 ETF、518 黄金 ETF、501/502/505 LOF
 *   深 15xxxx —— 159 ETF、150 分级（已清退但代码段仍在）
 *      16xxxx —— LOF（如 161725 白酒基金）
 *      18xxxx —— 封闭式
 *
 * 深市**不能**放宽到整个 1xxxxx：12xxxx 是可转债（123/127/128），
 * 10xxxx-11xxxx 是国债与债券，混进来会被当成基金去请求基金公告。
 */
const FUND_PATTERN = {
  sh: /^5\d{5}$/,
  sz: /^1[5-8]\d{4}$/,
};

/**
 * 指数代码段。沪深各有一段，且**必须连交易所一起判**——
 * `sh000001` 是上证指数，而 `sz000001` 是平安银行，只看数字会把后者错判成指数。
 */
const INDEX_PATTERN = {
  sh: /^000\d{3}$/,
  sz: /^399\d{3}$/,
};

/**
 * 从任意用户输入里剥出 6 位数字代码与显式交易所标记。
 * @returns {{ digits: string, explicit: string }} explicit 为 '' 表示用户没写交易所
 */
function splitInput(input) {
  const raw = String(input == null ? '' : input).trim();
  if (!raw) return { digits: '', explicit: '' };

  const lower = raw.toLowerCase();
  let explicit = '';

  // 形如 600519.sh / 000858.sz
  const dotted = lower.match(/^(\d{6})\.(sh|sz|bj)$/);
  if (dotted) return { digits: dotted[1], explicit: dotted[2] };

  // 形如 sh600519 / SZ000858
  const prefixed = lower.match(/^(sh|sz|bj)(\d{6})$/);
  if (prefixed) return { digits: prefixed[2], explicit: prefixed[1] };

  // 纯数字（可能带其他杂字符，取第一段连续 6 位数字）
  const digitsOnly = lower.match(/(\d{6})/);
  if (digitsOnly) return { digits: digitsOnly[1], explicit };

  return { digits: '', explicit: '' };
}

/** 按代码首位猜交易所。 */
function guessExchange(digits) {
  const head = digits.charAt(0);
  if (SH_PREFIX.includes(head)) return 'sh';
  if (SZ_PREFIX.includes(head)) return 'sz';
  if (BJ_PREFIX.includes(head)) return 'bj';
  return 'sh';
}

/**
 * 判定标的类型：'fund'（场内基金）/ 'index'（指数）/ 'stock'（股票）。
 *
 * 类型决定后续走哪条数据路径：基金没有市盈率/市净率，公告要走
 * 东财的 ann_type=FUND，且新浪个股新闻页对基金只会回落成大盘快讯
 * （已实测：ETF 与伪代码 sh999999 返回完全相同的内容）。
 *
 * @param {string} digits 6 位数字代码
 * @param {string} exchange 'sh' | 'sz' | 'bj'
 * @returns {'fund'|'index'|'stock'}
 */
function classifyCode(digits, exchange) {
  const d = String(digits || '');
  const ex = String(exchange || '');
  if (INDEX_PATTERN[ex] && INDEX_PATTERN[ex].test(d)) return 'index';
  if (FUND_PATTERN[ex] && FUND_PATTERN[ex].test(d)) return 'fund';
  return 'stock';
}

/**
 * 规范化股票代码。
 * @param {string} input 用户输入
 * @returns {{ ok: boolean, code?: string, digits?: string, exchange?: string,
 *            kind?: 'fund'|'index'|'stock', isFund?: boolean, error?: string }}
 *          code 形如 `sh600519`（腾讯行情/新浪均用此格式）
 */
function normalizeCode(input) {
  const { digits, explicit } = splitInput(input);
  if (!digits) {
    return { ok: false, error: '请输入 6 位代码，如 600519 或 510300' };
  }
  const exchange = explicit || guessExchange(digits);
  const kind = classifyCode(digits, exchange);
  return {
    ok: true,
    code: `${exchange}${digits}`,
    digits,
    exchange,
    kind,
    // 布尔别名：调用点大多只关心「是不是基金」，写 isFund 比 kind === 'fund' 短
    isFund: kind === 'fund',
  };
}

/**
 * 批量规范化并去重（保持首次出现顺序）。
 * 非法项收集到 errors 中，不打断其余项。
 */
function normalizeCodeList(list) {
  const items = Array.isArray(list) ? list : [];
  const seen = new Set();
  const codes = [];
  const errors = [];

  for (const item of items) {
    const r = normalizeCode(item);
    if (!r.ok) {
      errors.push({ input: item, error: r.error });
      continue;
    }
    if (seen.has(r.code)) continue;
    seen.add(r.code);
    codes.push(r.code);
  }
  return { codes, errors };
}

/** 交易所中文名，用于 UI 展示。 */
function exchangeLabel(exchange) {
  return { sh: '沪', sz: '深', bj: '京' }[exchange] || '';
}

/** 标的类型中文标签，用于搜索结果与关注列表打标 */
function kindLabel(kind) {
  return { fund: '基金', index: '指数' }[kind] || '';
}

module.exports = {
  normalizeCode,
  normalizeCodeList,
  exchangeLabel,
  classifyCode,
  kindLabel,
  FUND_PATTERN,
  INDEX_PATTERN,
};
