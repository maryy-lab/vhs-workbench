/**
 * 云端定时同步脚本 - GitHub Actions 专用
 * 
 * 工作流程：
 * 1. 从 jsonblob.com 下载用户配置（达人映射、人员、用户等，体积小）
 * 2. 从微信小店联盟API拉取佣金订单数据（体积大）
 * 3. 合并后保存到 data.json 文件
 * 4. GitHub Actions 自动提交 data.json 到仓库
 * 5. 前端从 raw.githubusercontent.com 读取 data.json
 * 
 * 这样即使本机关机，GitHub Actions 也会每30分钟自动同步一次
 */

const axios = require('axios');
const fs = require('fs');
const path = require('path');

// ============ 配置（从环境变量读取） ============
const APPID = process.env.WX_APPID;
const SECRET = process.env.WX_SECRET;
const JSONBLOB_ID = process.env.JSONBLOB_ID || '019fb939-7892-704d-956b-3aa79a5df273';
const SYNC_DAYS = parseInt(process.env.SYNC_DAYS || '7', 10);
const CLOUD_API = 'https://jsonblob.com/api/jsonBlob';
const OUTPUT_FILE = path.join(__dirname, 'data.json');

if (!APPID || !SECRET) {
  console.error('❌ 缺少环境变量 WX_APPID 或 WX_SECRET');
  process.exit(1);
}

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

// ============ 获取佣金单列表 ============
async function fetchOrderList(startTime, endTime) {
  const token = await getToken();
  const orders = [];
  let nextKey = '';
  let page = 0;
  let res;

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
    log(`获取订单列表第${page}页，累计${orders.length}条`);

    if (nextKey && res.data.has_more) {
      await sleep(300);
    }
  } while (nextKey && res.data.has_more);

  return orders;
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
    orderStatus: orderStatusMap[orderInfo.status] || String(orderInfo.status || ''),
    commissionStatus: commissionStatusMap[raw.status] || String(raw.status || ''),
    createTime: raw.create_time,
    payTime: orderInfo.pay_time,
    syncedAt: new Date().toISOString()
  };
}

// ============ 列表数据兜底（详情获取失败时用，确保订单不丢失） ============
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
function applyMapping(orders, mapping) {
  return orders.map(o => ({
    ...o,
    channel: mapping[o.talentName]?.channel || '',
    zhaoshang: mapping[o.talentName]?.zhaoshang || ''
  }));
}

// ============ 从仓库已有的 data.json 读取配置和旧订单（保留用户在云端做的修改 + 历史订单） ============
async function readExistingConfig() {
  try {
    if (fs.existsSync(OUTPUT_FILE)) {
      const raw = fs.readFileSync(OUTPUT_FILE, 'utf-8');
      const data = JSON.parse(raw);
      log(`从已有 data.json 读取配置: ${Object.keys(data.mapping || {}).length} 个映射, ${Object.keys(data.users || {}).length} 个用户, ${(data.personnel?.channels||[]).length} 个渠道, ${(data.personnel?.zhaoshangs||[]).length} 个招商, ${(data.orders||[]).length} 条旧订单`);
      return {
        mapping: data.mapping || {},
        users: data.users || {},
        personnel: data.personnel || { channels: [], zhaoshangs: [] },
        products: data.products || [],
        productMapping: data.productMapping || {},
        orders: data.orders || []
      };
    }
  } catch (e) {
    log(`读取已有 data.json 失败: ${e.message}`);
  }
  return {
    mapping: {}, users: {}, personnel: { channels: [], zhaoshangs: [] },
    products: [], productMapping: {},
    orders: []
  };
}

// ============ 从 jsonblob 下载用户配置（体积小，GET 不会超时） ============
async function downloadUserConfig() {
  try {
    const res = await axios.get(`${CLOUD_API}/${JSONBLOB_ID}`, { timeout: 15000 });
    const data = res.data || {};
    return {
      mapping: data.mapping || {},
      users: data.users || {},
      personnel: data.personnel || { channels: [], zhaoshangs: [] },
      products: data.products || [],
      productMapping: data.productMapping || {}
    };
  } catch (e) {
    log(`下载用户配置失败: ${e.message}，使用空配置`);
    return {
      mapping: {}, users: {}, personnel: { channels: [], zhaoshangs: [] },
      products: [], productMapping: {}
    };
  }
}

// ============ 上传用户配置到 jsonblob（只传配置，不传订单，体积小） ============
async function uploadUserConfig(config) {
  try {
    const res = await axios.put(`${CLOUD_API}/${JSONBLOB_ID}`, config, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 15000
    });
    log('用户配置已同步到 jsonblob');
    return true;
  } catch (e) {
    log(`上传用户配置到 jsonblob 失败: ${e.message}`);
    return false;
  }
}

// ============ 主流程 ============
async function main() {
  console.log('');
  console.log('═══════════════════════════════════════════');
  console.log('  视频号出单数据 - GitHub Actions 云端同步');
  console.log('═══════════════════════════════════════════');
  console.log(`  同步范围: 最近 ${SYNC_DAYS} 天`);
  console.log(`  云端ID: ${JSONBLOB_ID}`);
  console.log(`  运行时间: ${new Date().toISOString()}`);
  console.log('');

  try {
    // 1. 读取已有配置（优先从仓库 data.json，再从 jsonblob 覆盖）
    log('读取已有配置...');
    const existingConfig = await readExistingConfig();
    let userConfig = existingConfig;
    
    // 尝试从 jsonblob 下载更新的配置（如果 jsonblob 可用的话）
    log('尝试从 jsonblob 下载配置...');
    const blobConfig = await downloadUserConfig();
    // jsonblob 的配置优先级更高（如果有的话）
    if (Object.keys(blobConfig.mapping).length > 0) userConfig.mapping = blobConfig.mapping;
    if (Object.keys(blobConfig.users).length > 0) userConfig.users = blobConfig.users;
    if (blobConfig.personnel && (blobConfig.personnel.channels?.length || blobConfig.personnel.zhaoshangs?.length)) userConfig.personnel = blobConfig.personnel;
    if (blobConfig.products.length > 0) userConfig.products = blobConfig.products;
    if (Object.keys(blobConfig.productMapping).length > 0) userConfig.productMapping = blobConfig.productMapping;
    log(`最终配置: ${Object.keys(userConfig.mapping).length} 个映射, ${Object.keys(userConfig.users).length} 个用户`);

    // 2. 获取订单列表
    const endTime = Math.floor(Date.now() / 1000);
    // 多往前取3天作为缓冲，确保不漏单（API按create_time过滤，与后台按付款时间可能略有差异）
    const startTime = endTime - (SYNC_DAYS + 3) * 24 * 3600;
    log(`开始同步最近 ${SYNC_DAYS} 天的佣金订单（缓冲3天）...`);

    const orderList = await fetchOrderList(startTime, endTime);
    log(`共获取到 ${orderList.length} 条佣金单`);

    if (orderList.length === 0) {
      log('无订单数据');
    }

    // 3. 获取每条订单详情（失败的先收集，最后重试+兜底）
    const detailedOrders = [];
    const failedItems = []; // 详情获取失败的订单，最后再重试一轮
    let fetched = 0, errors = 0;

    for (const item of orderList) {
      try {
        await sleep(200);
        const detail = await fetchOrderDetail(item.order_id, item.sku_id);
        const transformed = transformOrder(detail);
        detailedOrders.push(transformed);
        fetched++;

        if (fetched % 20 === 0) {
          log(`已获取 ${fetched}/${orderList.length} 条订单详情...`);
        }
      } catch (err) {
        failedItems.push(item);
        log(`订单 ${item.order_id} 详情获取失败(将重试): ${err.message}`);
      }
    }

    // 3.5 对失败的订单做第二轮重试（间隔更长，避免限流）
    if (failedItems.length > 0) {
      log(`第一轮完成: 成功 ${fetched} 条，失败 ${failedItems.length} 条，开始重试...`);
      for (const item of failedItems) {
        try {
          await sleep(1000); // 重试间隔更长
          const detail = await fetchOrderDetail(item.order_id, item.sku_id);
          const transformed = transformOrder(detail);
          detailedOrders.push(transformed);
          fetched++;
          log(`重试成功: 订单 ${item.order_id}`);
        } catch (err) {
          errors++;
          // 兜底：用列表数据创建最小记录，确保订单不丢失
          const fallback = transformListOrder(item);
          detailedOrders.push(fallback);
          log(`重试仍失败，已用列表数据兜底: 订单 ${item.order_id} (${err.message})`);
        }
      }
    }

    // 4. 合并旧订单（保留30天内，避免10天API窗口外的订单丢失）
    const KEEP_DAYS = 30;
    const nowSec = Math.floor(Date.now() / 1000);
    const cutoffSec = nowSec - KEEP_DAYS * 24 * 3600;

    // 用新获取的订单ID建立去重集合
    const newOrderIds = new Set(detailedOrders.map(o => o.id));
    let mergedCount = 0;
    const existingOrders = existingConfig.orders || [];
    for (const oldOrder of existingOrders) {
      if (newOrderIds.has(oldOrder.id)) continue; // 新批次已有，跳过
      // 检查是否在 KEEP_DAYS 天内（用 createTime 或 payTime 判断）
      const orderTime = oldOrder.createTime || oldOrder.payTime || 0;
      if (orderTime && orderTime > cutoffSec) {
        detailedOrders.push(oldOrder);
        mergedCount++;
      }
    }
    log(`合并旧订单: 新获取 ${fetched} 条，保留 ${mergedCount} 条旧订单（${KEEP_DAYS}天内），总计 ${detailedOrders.length} 条`);

    // 5. 转换数据
    const mappedOrders = applyMapping(detailedOrders, userConfig.mapping);
    const talents = extractTalents(detailedOrders, userConfig.mapping);

    log(`数据转换完成！成功 ${fetched} 条，失败 ${errors} 条`);

    // 5. 保存到 data.json 文件（GitHub Actions 会自动提交到仓库）
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
    const output = {
      orders: mappedOrders,
      talents,
      mapping: userConfig.mapping,
      productMapping: userConfig.productMapping,
      personnel: userConfig.personnel,
      users: userConfig.users,
      products: userConfig.products,
      _meta: {
        source: 'github-actions',
        time: new Date().toISOString(),
        count: mappedOrders.length,
        errors,
        syncDays: SYNC_DAYS
      }
    };

    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2));
    log(`数据已保存到 ${OUTPUT_FILE} (${(JSON.stringify(output).length / 1024).toFixed(1)} KB)`);

    // 6. 同时上传用户配置到 jsonblob（供前端读取用户编辑的配置）
    await uploadUserConfig({
      mapping: userConfig.mapping,
      users: userConfig.users,
      personnel: userConfig.personnel,
      products: userConfig.products,
      productMapping: userConfig.productMapping,
      _meta: { source: 'github-actions-config', time: new Date().toISOString() }
    });

    console.log('');
    console.log('═══════════════════════════════════════════');
    console.log('  ✅ 云端同步完成！');
    console.log(`  订单列表(API): ${orderList.length} 条`);
    console.log(`  详情成功: ${fetched} 条`);
    console.log(`  详情失败(已兜底): ${errors} 条`);
    console.log(`  合并旧订单: ${mergedCount} 条`);
    console.log(`  最终入库: ${mappedOrders.length} 条`);
    console.log(`  达人数: ${talents.length}`);
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
      fs.writeFileSync(OUTPUT_FILE, JSON.stringify(existing, null, 2));
      log('已保留旧数据并标记同步错误状态');
    } catch (e2) {
      log(`无法更新错误标记: ${e2.message}`);
    }
    process.exit(1);
  }
}

main();
