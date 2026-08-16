'use strict';

/**
 * 极薄 HTTP 层：超时控制 + 编码解码 + fetch 注入点。
 *
 * 说明：本项目所有请求都在 Electron 主进程用 Node 内置 fetch 发起。
 * Node 的 fetch 默认**不读** HTTP_PROXY/HTTPS_PROXY 环境变量，
 * 等价于 curl 的 `--noproxy *`，正好绕开公司代理直连行情接口。
 */

const DEFAULT_TIMEOUT_MS = 12000;

/** 行情站点普遍要求带 UA，缺失会被判为爬虫直接拒绝 */
const DEFAULT_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
  Accept: '*/*',
  'Accept-Language': 'zh-CN,zh;q=0.9',
};

/**
 * 取原始字节。
 * @param {string} url
 * @param {{ timeoutMs?: number, headers?: object, fetchImpl?: Function }} [opts]
 * @returns {Promise<Buffer>}
 */
async function fetchBuffer(url, opts = {}) {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, headers = {}, fetchImpl = globalThis.fetch } = opts;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      headers: { ...DEFAULT_HEADERS, ...headers },
      signal: controller.signal,
      redirect: 'follow',
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText || ''}`.trim());
    }
    return Buffer.from(await res.arrayBuffer());
  } catch (err) {
    // AbortError 的原始信息是 "This operation was aborted"，对用户没有意义
    if (err && (err.name === 'AbortError' || err.name === 'TimeoutError')) {
      throw new Error(`请求超时（${timeoutMs}ms）`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 取文本，按指定编码解码。
 * @param {string} url
 * @param {{ encoding?: 'utf-8'|'gbk', timeoutMs?: number, headers?: object, fetchImpl?: Function }} [opts]
 */
async function fetchText(url, opts = {}) {
  const { encoding = 'utf-8' } = opts;
  const buf = await fetchBuffer(url, opts);
  // 腾讯行情、新浪网页都是 GB18030 系；gbk 解码器兼容读取
  return new TextDecoder(encoding).decode(buf);
}

/** 取 JSON。响应不是合法 JSON 时抛出带片段的错误，便于定位接口变更。 */
async function fetchJson(url, opts = {}) {
  const text = await fetchText(url, { ...opts, encoding: opts.encoding || 'utf-8' });
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`响应不是合法 JSON：${text.slice(0, 120)}`);
  }
}

module.exports = { fetchBuffer, fetchText, fetchJson, DEFAULT_TIMEOUT_MS, DEFAULT_HEADERS };
