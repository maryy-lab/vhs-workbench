/**
 * 云端定时同步脚本 - GitHub Actions 专用
 *
 * 工作流程：
 * 1. 从 GitHub API 读取最新 data.json（获取用户保存的配置 + 旧订单）
 * 2. 从微信小店联盟API拉取佣金订单列表（窗口自适应：从上次同步时间起算，不重复翻旧页）
 * 3. 新订单获取详情入库；已入库订单按"最久未刷新优先"轮换刷新（48小时内状态会变化）
 * 4. 写入 data.json，GitHub Actions 自动提交到仓库
 * 5. 前端从 raw.githubusercontent.com 读取 data.json
 *
 * ★ 时间预算制（防超时停更的核心）：
 *   无论订单量多大（哪怕每天上万单），每轮同步都在固定时间预算内优雅收尾，
 *   绝不会超过 workflow 超时被强制取消。预算内干不完的增量工作自动留给下一轮
 *   （自循环 5 分钟后触发），积压会被持续消化，链路永不卡死：
 *   - 拉列表最多 7 分钟（超时停止翻页，未覆盖的时间起点记入 _meta.pendingListStart 下轮续拉）
 *   - 拉详情最多到第 13 分钟（新单优先；预算耗尽时用列表数据兜底入库，下轮补全详情）
 *   - data.json 行数硬上限 60000（超出丢弃最旧的，防文件过大拖垮前端和提交）
 */

const axios = require('axios');
const fs = require('fs');
const path = require('path');

// ============ 配置（从环境变量读取） ============
const APPID = process.env.WX_APPID;
const SECRET = process.env.WX_SECRET;
const SYNC_DAYS = parseInt(process.env.SYNC_DAYS || '7', 10);
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const GITHUB_REPO = process.env.GITHUB_REPOSITORY || 'maryy-lab/vhs-workbench';
const OUTPUT_FILE = path.join(__dirname, 'data.json');

if (!APPID || !SECRET) {
  console.error('❌ 缺少环境变量 WX_APPID 或 WX_SECRET');
  process.exit(1);
}

// ============ 时间预算（防超时核心机制） ============
const RUN_START = Date.now();
const LIST_DEADLINE = RUN_START + 7 * 60 * 1000;    // 拉列表最多 7 分钟
const DETAIL_DEADLINE = RUN_START + 13 * 60 * 1000; // 拉详情最多到第 13 分钟
const KEEP_DAYS = 30;      // 订单保留天数
const MAX_ORDERS = 60000;  // data.json 行数硬上限

// ============ 工具函数 ============
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function log(msg) {
  const time = new Date().toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai' });
  console.log(`[${time}] ${msg}`);
}

// 带指数退避的自动重试（最多 maxRetries 次）
async function retryWithBackoff(fn, label, maxRetries = 3) {
  let lastErr;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt < maxRetries) {
        const delay = attempt * 5000; // 5s, 10s, 15s
        log(`⚠️ ${label} 第${attempt}次失败: ${err.message}，${delay/1000}秒后重试...`);
        await sleep(delay);
      } else {
        log(`❌ ${label} 已重试${maxRetries}次仍失败: ${err.message}`);
      }
    }
  }
  throw lastErr;
}

function parseBigint(data) {
  return JSON.parse(data.replace(/("[^"]+"\s*:\s*)(\d{16,})/g, '$1"$2"'));
}

function buildBigintBody(data) {
  const parts = [];
  for (const [key, value] of Object.entries(data)) {
    if (typeof value === 'string' && /^\d+$/.test(value)) {
      parts.push(`"${key}":${value}`);
    } else {
      parts.push(`"${key}":${JSON.stringify(value)}`);
    }
  }
  return `{${parts.join(',')}}`;
}

// ============ Access Token ============
let accessToken = null;
let tokenExpiry = 0;

async function getToken() {
  if (accessToken && Date.now() < tokenExpiry - 300000) {
    return accessToken;
  }
  log('正在获取 access_token (stable_token)...');
  const result = await retryWithBackoff(async () => {
    // 使用 stable_token 接口，不受 cgi-bin/token 每日配额限制
    const res = await axios.post('https://api.weixin.qq.com/cgi-bin/stable_token', {
      grant_type: 'client_credential',
      appid: APPID,
      secret: SECRET,
      force_refresh: false
    }, { timeout: 15000 });
    if (res.data.errcode) {
      throw new Error(`获取token失败: ${res.data.errcode} ${res.data.errmsg}`);
    }
    return res.data;
  }, '获取access_token');
  accessToken = result.access_token;
  tokenExpiry = Date.now() + (result.expires_in || 7200) * 1000;
  log('access_token 获取成功');
  return accessToken;
}

// ============ 获取佣金单列表（带时间预算，超时优雅停止翻页） ============
async function fetchOrderList(startTime, endTime) {
  const token = await getToken();
  const orders = [];
  let nextKey = '';
  let page = 0;
  let res;
  let truncated = false;

  do {
    page++;
    res = await retryWithBackoff(async () => {
      const r = await axios.post(
        `https://api.weixin.qq.com/channels/ec/league/headsupplier/order/list/get?access_token=${token}`,
        {
          page_size: 30,
          next_key: nextKey,
          create_time_range: { start_time: startTime, end_time: endTime }
        },
        {
          timeout: 20000,
          transformResponse: [function(data) { return parseBigint(data); }]
        }
      );
      if (r.data.errcode) {
        // token 过期则清除缓存，让下次重试重新获取
        if (r.data.errcode === 40001 || r.data.errcode === 42001) accessToken = null;
        throw new Error(`获取订单列表失败: ${r.data.errcode} ${r.data.errmsg}`);
      }
      return r;
    }, `获取订单列表第${page}页`);

    const list = res.data.list || [];
    if (Array.isArray(list)) {
      orders.push(...list);
    } else if (list && list.order_id) {
      orders.push(list);
    }

    nextKey = res.data.next_key || '';
    if (page % 20 === 0) {
      log(`订单列表已翻 ${page} 页，累计 ${orders.length} 条...`);
    }

    if (nextKey && res.data.has_more) {
      // ★ 时间预算：拉列表超过预算立即停止，已获取的部分照常入库，
      //   未覆盖的时间起点由调用方记入 _meta.pendingListStart，下一轮接着拉
      if (Date.now() > LIST_DEADLINE) {
        truncated = true;
        log(`⚠️ 拉列表已达时间预算（${page} 页/${orders.length} 条），剩余部分下一轮继续`);
        break;
      }
      await sleep(150);
    }
  } while (nextKey && res.data.has_more);

  return { orders, truncated };
}

// ============ 获取佣金单详情 ============
async function fetchOrderDetail(orderId, skuId) {
  const token = await getToken();
  const res = await retryWithBackoff(async () => {
    const r = await axios.post(
      `https://api.weixin.qq.com/channels/ec/league/headsupplier/order/get?access_token=${token}`,
      { order_id: String(orderId), sku_id: String(skuId) },
      {
        timeout: 20000,
        transformRequest: [function(data) { return buildBigintBody(data); }],
        transformResponse: [function(data) { return parseBigint(data); }]
      }
    );
    if (r.data.errcode) {
      if (r.data.errcode === 40001 || r.data.errcode === 42001) accessToken = null;
      throw new Error(`获取订单详情失败: ${r.data.errcode} ${r.data.errmsg}`);
    }
    return r;
  }, `订单详情 ${orderId}`);

  return res.data.commssion_order;
}

// ============ 北京时间格式化 ============
// 中国标准时间 UTC+8，无夏令时，固定偏移 28800 秒
// （ISO 字符串偏移后取切片，等价于按北京时间格式化）
function toBeijingDateStr(unixSec) {
  if (!unixSec) unixSec = Math.floor(Date.now() / 1000);
  return new Date((unixSec + 8 * 3600) * 1000).toISOString().slice(0, 10);
}
// 返回 "YYYY-MM-DD HH:mm" 北京时间，精确到分钟（与联盟带货机构后台出单时间一致）
function toBeijingTimeStr(unixSec) {
  if (!unixSec) unixSec = Math.floor(Date.now() / 1000);
  const iso = new Date((unixSec + 8 * 3600) * 1000).toISOString();
  return iso.slice(0, 10) + ' ' + iso.slice(11, 16);
}

// ============ 数据转换 ============
function transformOrder(raw) {
  const detail = raw.order_detail || {};
  const commission = detail.commission_info || {};
  const product = detail.product_info || {};
  const shop = detail.shop_info || {};
  const orderInfo = detail.order_info || {};


  // 达人信息提取：优先 finder_info（视频号名称，与联盟机构后台显示一致）
  // talent_info.nickname 有时是系统生成的字母串(如 z1234nn)，并非用户在后台看到的视频号名称
  let talentName = '', talentType = '', talentId = '', talentCommission = 0, talentCommissionRatio = 0;
  if (commission.finder_info && commission.finder_info.nickname) {
    const f = commission.finder_info;
    talentName = f.nickname;
    talentType = 'finder';
    talentId = f.openfinderid || '';
    talentCommission = (f.amount || 0) / 100;
    talentCommissionRatio = (f.ratio || 0) / 10000;
  } else if (commission.talent_info && commission.talent_info.nickname) {
    const t = commission.talent_info;
    talentName = t.nickname;
    talentType = 'talent';
    talentId = t.opentalentid || t.talent_appid || '';
    talentCommission = (t.amount || 0) / 100;
    talentCommissionRatio = (t.ratio || 0) / 10000;
  } else if (commission.sharer_info && commission.sharer_info.nickname) {
    const s = commission.sharer_info;
    talentName = s.nickname;
    talentType = 'sharer';
    talentId = s.opensharerid || s.sharer_appid || '';
    talentCommission = (s.amount || 0) / 100;
    talentCommissionRatio = (s.ratio || 0) / 10000;
  }

  // 出单时间：优先取付款时间(pay_time)，其次订单创建时间(create_time)，最后兜底当前时间
  // 全部按北京时间(UTC+8)计算，与联盟带货机构后台一致
  const timestamp = orderInfo.pay_time || orderInfo.create_time || raw.create_time || Math.floor(Date.now() / 1000);
  const date = toBeijingDateStr(timestamp);
  const payTimeStr = toBeijingTimeStr(timestamp);

  const orderStatusMap = { 10: '待付款', 12: '待收礼', 17: '待使用', 20: '待发货', 21: '部分发货', 30: '待收货', 100: '已完成', 200: '已取消', 250: '已取消' };
  const commissionStatusMap = { 20: '未结算', 100: '已结算', 200: '取消结算' };

  return {
    id: `${raw.order_id}_${raw.sku_id}`,
    orderId: String(raw.order_id),
    skuId: raw.sku_id,
    date,
    payTimeStr,
    talentName,
    talentType,
    talentId,
    shopName: shop.shop_name || '',
    shopAppid: shop.appid || '',
    productTitle: product.title || '',
    productId: product.product_id || '',
    productImg: product.thumb_img || '',
    productCount: product.product_cnt || 1,
    salesAmount: (product.actual_payment || 0) / 100,
    serviceAmount: (commission.service_amount || 0) / 100,
    serviceRatio: (commission.service_ratio || 0) / 10000,
    serviceTotalAmount: (commission.service_total_amount || 0) / 100,
    talentCommission,
    talentCommissionRatio,
    platformAmount: (commission.platform_amount || 0) / 100,
    promotionChannel: commission.promotion_channel === 1 ? '推客带货' : '橱窗带货',
    orderStatus: orderStatusMap[orderInfo.order_status] || String(orderInfo.order_status || ''),
    commissionStatus: commissionStatusMap[raw.status] || String(raw.status || ''),
    createTime: raw.create_time,
    payTime: orderInfo.pay_time,
    syncedAt: new Date().toISOString()
  };
}

// ============ 列表数据兜底（详情获取失败/预算耗尽时用，确保订单不丢失、下轮自动补全） ============
function transformListOrder(item) {
  const commissionStatusMap = { 20: '未结算', 100: '已结算', 200: '取消结算' };
  const timestamp = item.create_time || Math.floor(Date.now() / 1000);
  return {
    id: `${item.order_id}_${item.sku_id}`,
    orderId: String(item.order_id),
    skuId: item.sku_id,
    date: toBeijingDateStr(timestamp),
    payTimeStr: toBeijingTimeStr(timestamp),
    talentName: '',
    talentType: '',
    talentId: '',
    shopName: '',
    shopAppid: '',
    productTitle: '',
    productId: '',
    productImg: '',
    productCount: 1,
    salesAmount: 0,
    serviceAmount: 0,
    serviceRatio: 0,
    serviceTotalAmount: 0,
    talentCommission: 0,
    talentCommissionRatio: 0,
    platformAmount: 0,
    promotionChannel: '',
    orderStatus: '未知(详情获取失败)',
    commissionStatus: commissionStatusMap[item.status] || String(item.status || ''),
    createTime: item.create_time,
    payTime: null,
    syncedAt: new Date().toISOString(),
    _detailFailed: true
  };
}

// ============ 提取达人列表 ============
function extractTalents(orders, mapping) {
  const map = {};
  orders.forEach(o => {
    if (!o.talentName) return;
    if (!map[o.talentName]) {
      map[o.talentName] = {
        name: o.talentName,
        talentId: o.talentId,
        talentType: o.talentType,
        orderCount: 0,
        totalSales: 0,
        totalServiceFee: 0,
        totalCommission: 0,
        channel: mapping[o.talentName]?.channel || '',
        zhaoshang: mapping[o.talentName]?.zhaoshang || ''
      };
    }
    map[o.talentName].orderCount++;
    map[o.talentName].totalSales += o.salesAmount || 0;
    map[o.talentName].totalServiceFee += o.serviceAmount || 0;
    map[o.talentName].totalCommission += o.talentCommission || 0;
  });
  return Object.values(map).sort((a, b) => b.totalSales - a.totalSales);
}

// ============ 应用映射 ============
// 已废弃：不再把达人级 channel/zhaoshang 烘焙进订单字段。
// 前端 getChannel/getZhaoshang 的读取优先级为：商品级映射 > 达人级映射 > 手动订单字段，
// 订单上烘焙的快照会遮蔽用户后续的分配修改（造成"分配不生效/自动变成另一个人"）。
function applyMapping(orders, mapping) {
  return orders;
}

// ============ 从仓库已有的 data.json 读取配置和旧订单（保留用户在云端做的修改 + 历史订单） ============
async function readExistingConfig() {
  try {
    if (fs.existsSync(OUTPUT_FILE)) {
      const raw = fs.readFileSync(OUTPUT_FILE, 'utf-8');
      const data = JSON.parse(raw);
      log(`从本地 data.json 读取配置: ${Object.keys(data.mapping || {}).length} 个映射, ${Object.keys(data.users || {}).length} 个用户, ${(data.personnel?.channels||[]).length} 个渠道, ${(data.personnel?.zhaoshangs||[]).length} 个招商, ${(data.orders||[]).length} 条旧订单`);
      return {
        mapping: data.mapping || {},
        users: data.users || {},
        personnel: data.personnel || { channels: [], zhaoshangs: [] },
        products: data.products || [],
        productMapping: data.productMapping || {},
        orders: data.orders || [],
        _deleted: data._deleted || { channels: {}, zhaoshangs: {}, users: {} },
        _meta: data._meta || null
      };
    }
  } catch (e) {
    log(`读取已有 data.json 失败: ${e.message}`);
  }
  return {
    mapping: {}, users: {}, personnel: { channels: [], zhaoshangs: [] },
    products: [], productMapping: {},
    orders: [],
    _deleted: { channels: {}, zhaoshangs: {}, users: {} },
    _meta: null
  };
}

// ============ 从 GitHub API 读取最新 data.json（防止 checkout 后用户保存的配置被覆盖） ============
async function readLatestConfigFromAPI() {
  if (!GITHUB_TOKEN) {
    log('GITHUB_TOKEN 未设置，跳过 API 读取（使用本地 data.json）');
    return null;
  }
  try {
    // 用 raw 方式读取（base64 方式在文件超过 1MB 时会返回空内容失败）
    const res = await axios.get(
      `https://api.github.com/repos/${GITHUB_REPO}/contents/cloud-sync/data.json`,
      {
        headers: {
          'Authorization': `token ${GITHUB_TOKEN}`,
          'Accept': 'application/vnd.github.raw',
          'User-Agent': 'sync-config-reader'
        },
        timeout: 60000,
        responseType: 'text',
        transformResponse: [function(d) { return d; }]
      }
    );
    const raw = typeof res.data === 'string' ? res.data : Buffer.from(res.data).toString('utf-8');
    if (raw) {
      const data = JSON.parse(raw);
      log(`从 GitHub API 读取最新配置: ${Object.keys(data.mapping || {}).length} 个映射, ${Object.keys(data.users || {}).length} 个用户, ${(data.personnel?.channels||[]).length} 个渠道, ${(data.personnel?.zhaoshangs||[]).length} 个招商, ${(data.orders||[]).length} 条旧订单`);
      return {
        mapping: data.mapping || {},
        users: data.users || {},
        personnel: data.personnel || { channels: [], zhaoshangs: [] },
        products: data.products || [],
        productMapping: data.productMapping || {},
        orders: data.orders || [],
        _deleted: data._deleted || { channels: {}, zhaoshangs: {}, users: {} },
        _meta: data._meta || null
      };
    }
  } catch (e) {
    log(`从 GitHub API 读取配置失败: ${e.message}，使用本地 data.json`);
  }
  return null;
}

// ============ 主流程 ============
async function main() {
  console.log('');
  console.log('═══════════════════════════════════════════');
  console.log('  视频号出单数据 - GitHub Actions 云端同步');
  console.log('═══════════════════════════════════════════');
  console.log(`  时间预算: 列表≤7分钟, 详情≤13分钟`);
  console.log(`  配置来源: GitHub API + 本地 data.json`);
  console.log(`  运行时间: ${new Date().toISOString()}`);
  console.log('');

  try {
    // 1. 读取已有配置（优先从 GitHub API 读取最新版本，防止用户保存的配置被覆盖）
    log('读取已有配置...');
    let existingConfig = await readExistingConfig();

    // 从 GitHub API 读取最新 data.json（checkout 后用户可能已保存新配置）
    log('从 GitHub API 读取最新配置...');
    const latestConfig = await readLatestConfigFromAPI();
    if (latestConfig) {
      // API 版本更新，使用它的配置和旧订单
      existingConfig = latestConfig;
    }
    let userConfig = existingConfig;
    log(`最终配置: ${Object.keys(userConfig.mapping).length} 个映射, ${Object.keys(userConfig.users).length} 个用户, ${(userConfig.personnel?.channels||[]).length} 个渠道, ${(userConfig.personnel?.zhaoshangs||[]).length} 个招商`);

    // 2. 拉取订单列表 —— 窗口自适应：
    //    只从"上次成功同步时间 - 24小时"开始拉（更早的订单都已入库，无需重复翻页）。
    //    若上次同步距今很远（断链/停更后重启），窗口自动覆盖整个停滞期，不会漏单。
    //    若上轮拉列表被时间预算截断，从上轮记录的未覆盖起点继续拉。
    const endTime = Math.floor(Date.now() / 1000);
    const lastMeta = userConfig._meta || {};
    const lastSyncMs = lastMeta.time ? new Date(lastMeta.time).getTime() : 0;
    let windowStartSec;
    if (lastMeta.pendingListStart) {
      // 上轮列表被预算截断，从截断点继续
      windowStartSec = lastMeta.pendingListStart;
      log(`上轮列表未拉完，从上次截断点继续: ${toBeijingTimeStr(windowStartSec)}`);
    } else if (lastSyncMs) {
      // 常规：从上次同步时间往前留 24 小时余量（覆盖付款晚于下单的订单）
      windowStartSec = Math.floor(lastSyncMs / 1000) - 24 * 3600;
    } else {
      // 首次运行/无历史：拉完整 SYNC_DAYS+3 窗口
      windowStartSec = endTime - (SYNC_DAYS + 3) * 24 * 3600;
    }
    // 窗口至少覆盖最近 6 小时
    windowStartSec = Math.min(windowStartSec, endTime - 6 * 3600);
    const windowDays = ((endTime - windowStartSec) / 86400).toFixed(2);
    log(`拉取窗口: ${toBeijingTimeStr(windowStartSec)} ~ 现在（约 ${windowDays} 天）`);

    const { orders: orderList, truncated: listTruncated } = await fetchOrderList(windowStartSec, endTime);
    log(`共获取到 ${orderList.length} 条佣金单`);

    // 3. 处理订单（时间预算制）
    const existingOrderMap = new Map();
    for (const o of (existingConfig.orders || [])) {
      existingOrderMap.set(o.id, o);
    }
    const nowSec = Math.floor(Date.now() / 1000);
    // 48小时内创建的订单状态会变化（付款/发货/取消结算），需要轮换刷新
    const REFRESH_CUTOFF = nowSec - 48 * 3600;

    // 3a. 列表中未入库的新订单（必须本轮入库，预算耗尽时用列表数据兜底）
    const newItems = orderList.filter(item => !existingOrderMap.has(`${item.order_id}_${item.sku_id}`));
    log(`新订单 ${newItems.length} 条，已入库 ${orderList.length - newItems.length} 条`);

    // 3b. 从缓存构建刷新队列：详情失败的 / 状态为空的 / 48小时内状态可能变化的
    //     按 syncedAt 最久未刷新的优先（大订单量下保证轮换公平，不会一直刷不到同一批）
    const refreshQueue = (existingConfig.orders || [])
      .filter(o => o._detailFailed || !o.orderStatus || (o.createTime && o.createTime >= REFRESH_CUTOFF))
      .sort((a, b) => String(a.syncedAt || '').localeCompare(String(b.syncedAt || '')));
    log(`待刷新(48h内/详情待补全): ${refreshQueue.length} 条`);

    // 结果表：id -> 订单
    const results = new Map();
    let fetched = 0, refreshed = 0, fallbackUsed = 0, errors = 0;
    let budgetHit = false;
    const failedNew = [];

    // 3c. 新订单优先获取详情（保证新单第一时间带全数据入库）
    for (const item of newItems) {
      const orderKey = `${item.order_id}_${item.sku_id}`;
      if (Date.now() > DETAIL_DEADLINE) {
        // ★ 预算耗尽：用列表数据兜底入库（标记 _detailFailed，下轮自动补全详情）
        budgetHit = true;
        results.set(orderKey, transformListOrder(item));
        fallbackUsed++;
        continue;
      }
      try {
        await sleep(150);
        const detail = await fetchOrderDetail(item.order_id, item.sku_id);
        results.set(orderKey, transformOrder(detail));
        fetched++;
        if (fetched % 20 === 0) log(`新订单详情已获取 ${fetched}/${newItems.length}...`);
      } catch (err) {
        failedNew.push(item);
        log(`新订单 ${item.order_id} 详情获取失败(将重试): ${err.message}`);
      }
    }

    // 3d. 失败的新订单重试一轮（间隔更长，避免限流）
    for (const item of failedNew) {
      const orderKey = `${item.order_id}_${item.sku_id}`;
      if (Date.now() > DETAIL_DEADLINE) { budgetHit = true; results.set(orderKey, transformListOrder(item)); fallbackUsed++; continue; }
      try {
        await sleep(1000);
        const detail = await fetchOrderDetail(item.order_id, item.sku_id);
        results.set(orderKey, transformOrder(detail));
        fetched++;
      } catch (err) {
        errors++;
        results.set(orderKey, transformListOrder(item));
        fallbackUsed++;
        log(`重试仍失败，已用列表数据兜底: 订单 ${item.order_id}`);
      }
    }

    // 3e. 轮换刷新已入库订单（最久未刷的优先，预算耗尽的留到下一轮）
    for (const cached of refreshQueue) {
      if (Date.now() > DETAIL_DEADLINE) { budgetHit = true; results.set(cached.id, cached); continue; }
      try {
        await sleep(120);
        const detail = await fetchOrderDetail(cached.orderId, cached.skuId);
        results.set(cached.id, transformOrder(detail));
        refreshed++;
        if (refreshed % 50 === 0) log(`已刷新 ${refreshed}/${refreshQueue.length} 条...`);
      } catch (err) {
        // 刷新失败用旧缓存，不影响本轮完成
        results.set(cached.id, cached);
      }
    }

    // 3f. 其余缓存订单直接复用
    let reused = 0;
    for (const o of (existingConfig.orders || [])) {
      if (!results.has(o.id)) {
        results.set(o.id, o);
        reused++;
      }
    }

    log(`处理完成: 新获取 ${fetched}, 刷新 ${refreshed}, 兜底 ${fallbackUsed}, 复用缓存 ${reused}, 刷新失败用旧缓存 ${errors}${budgetHit ? '（本轮触发时间预算，剩余工作量下一轮继续）' : ''}`);

    // 4. 汇总 + 裁剪：保留 KEEP_DAYS 天内 且 不超过 MAX_ORDERS 行（超出丢最旧的，防 data.json 过大）
    const cutoffSec = nowSec - KEEP_DAYS * 24 * 3600;
    let allOrders = [...results.values()].filter(o => {
      const t = o.createTime || o.payTime || 0;
      return !t || t > cutoffSec; // 时间未知的保守保留
    });
    allOrders.sort((a, b) => (b.createTime || b.payTime || 0) - (a.createTime || a.payTime || 0));
    const trimmed = allOrders.length > MAX_ORDERS ? allOrders.length - MAX_ORDERS : 0;
    if (trimmed > 0) {
      allOrders = allOrders.slice(0, MAX_ORDERS);
      log(`⚠️ 订单数超过上限 ${MAX_ORDERS}，已丢弃最旧的 ${trimmed} 条`);
    }
    const droppedOld = results.size - allOrders.length - trimmed;
    log(`最终入库 ${allOrders.length} 条（保留${KEEP_DAYS}天内，复用${reused}条旧缓存${droppedOld > 0 ? `，剔除超期 ${droppedOld} 条` : ''}）`);

    // 5. 转换数据
    const mappedOrders = applyMapping(allOrders, userConfig.mapping);
    const talents = extractTalents(allOrders, userConfig.mapping);

    // 6. 保存到 data.json 文件（GitHub Actions 会自动提交到仓库）
    // 安全检查：如果配置为空但已有配置非空，保留已有配置（防止意外清空）
    if((!userConfig.personnel?.channels?.length && !userConfig.personnel?.zhaoshangs?.length) && existingConfig.personnel && (existingConfig.personnel.channels?.length || existingConfig.personnel.zhaoshangs?.length)){
      log('⚠️ 警告：当前 personnel 为空但已有配置非空，保留已有配置');
      userConfig.personnel = existingConfig.personnel;
    }
    if(Object.keys(userConfig.users).length === 0 && Object.keys(existingConfig.users||{}).length > 0){
      log('⚠️ 警告：当前 users 为空但已有配置非空，保留已有配置');
      userConfig.users = existingConfig.users;
    }
    if(Object.keys(userConfig.mapping).length === 0 && Object.keys(existingConfig.mapping||{}).length > 0){
      log('⚠️ 警告：当前 mapping 为空但已有配置非空，保留已有配置');
      userConfig.mapping = existingConfig.mapping;
    }
    const durationSec = Math.round((Date.now() - RUN_START) / 1000);
    const output = {
      orders: mappedOrders,
      talents,
      mapping: userConfig.mapping,
      productMapping: userConfig.productMapping,
      personnel: userConfig.personnel,
      users: userConfig.users,
      products: userConfig.products,
      _deleted: userConfig._deleted || { channels: {}, zhaoshangs: {}, users: {} },
      _meta: {
        source: 'github-actions',
        time: new Date().toISOString(),
        count: mappedOrders.length,
        errors,
        fetched,
        refreshed,
        budgetHit,
        durationSec,
        // 列表被预算截断时记录未覆盖起点，下一轮从此继续拉（保证不漏单）
        pendingListStart: listTruncated ? windowStartSec : undefined
      }
    };
    // 压缩输出（不缩进），大幅减小文件体积，前端加载更快
    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output));
    log(`数据已保存到 ${OUTPUT_FILE} (${(JSON.stringify(output).length / 1024).toFixed(1)} KB)`);

    console.log('');
    console.log('═══════════════════════════════════════════');
    console.log('  ✅ 云端同步完成！');
    console.log(`  耗时: ${durationSec} 秒 (预算 780 秒)`);
    console.log(`  订单列表(API): ${orderList.length} 条 (窗口约 ${windowDays} 天)`);
    console.log(`  新获取详情: ${fetched} 条`);
    console.log(`  刷新详情: ${refreshed} 条`);
    console.log(`  预算兜底(下轮补全): ${fallbackUsed} 条`);
    console.log(`  复用缓存: ${reused} 条`);
    console.log(`  最终入库: ${mappedOrders.length} 条`);
    console.log(`  达人数: ${talents.length}`);
    console.log(`  时间预算触发: ${budgetHit ? '是(正常,剩余工作量下一轮继续)' : '否'}`);
    console.log(`  列表截断: ${listTruncated ? '是(下轮续拉)' : '否'}`);
    console.log(`  数据文件: cloud-sync/data.json`);
    console.log('═══════════════════════════════════════════');

  } catch (err) {
    console.error(`\n❌ 同步失败: ${err.message}`);
    // 即使同步失败，也更新 _meta 标记，让前端知道同步出了问题
    try {
      const existingConfig = await readExistingConfig();
      const existing = JSON.parse(fs.readFileSync(OUTPUT_FILE, 'utf8'));
      existing._meta = existing._meta || {};
      existing._meta.lastSyncError = err.message;
      existing._meta.lastSyncErrorTime = new Date().toISOString();
      fs.writeFileSync(OUTPUT_FILE, JSON.stringify(existing));
      log('已保留旧数据并标记同步错误状态');
    } catch (e2) {
      log(`无法更新错误标记: ${e2.message}`);
    }
    process.exit(1);
  }
}

main();
