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
const JSONBLOB_ID = process.env.JSONBLOB_ID || '019fa181-1038-700a-9d23-38f99c75d982';
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
  log('正在获取 access_token...');
  const res = await axios.get('https://api.weixin.qq.com/cgi-bin/token', {
    params: { grant_type: 'client_credential', appid: APPID, secret: SECRET },
    timeout: 10000
  });
  if (res.data.errcode) {
    throw new Error(`获取token失败: ${res.data.errcode} ${res.data.errmsg}`);
  }
  accessToken = res.data.access_token;
  tokenExpiry = Date.now() + (res.data.expires_in || 7200) * 1000;
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
    res = await axios.post(
      `https://api.weixin.qq.com/channels/ec/league/headsupplier/order/list/get?access_token=${token}`,
      {
        page_size: 30,
        next_key: nextKey,
        create_time_range: { start_time: startTime, end_time: endTime }
      },
      {
        timeout: 15000,
        transformResponse: [function(data) { return parseBigint(data); }]
      }
    );

    if (res.data.errcode) {
      throw new Error(`获取订单列表失败: ${res.data.errcode} ${res.data.errmsg}`);
    }

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
  const res = await axios.post(
    `https://api.weixin.qq.com/channels/ec/league/headsupplier/order/get?access_token=${token}`,
    { order_id: String(orderId), sku_id: String(skuId) },
    {
      timeout: 15000,
      transformRequest: [function(data) { return buildBigintBody(data); }],
      transformResponse: [function(data) { return parseBigint(data); }]
    }
  );

  if (res.data.errcode) {
    throw new Error(`获取订单详情失败: ${res.data.errcode} ${res.data.errmsg}`);
  }

  return res.data.commssion_order;
}

// ============ 数据转换 ============
let _debugLogged = false;
function transformOrder(raw) {
  const detail = raw.order_detail || {};
  const commission = detail.commission_info || {};
  const product = detail.product_info || {};
  const shop = detail.shop_info || {};
  const orderInfo = detail.order_info || {};

  if (!_debugLogged) {
    _debugLogged = true;
    console.log('[DEBUG] product_info keys:', Object.keys(product));
    console.log('[DEBUG] product_info sample:', JSON.stringify(product).slice(0, 500));
    console.log('[DEBUG] detail keys:', Object.keys(detail));
  }

  let talentName = '', talentType = '', talentId = '', talentCommission = 0, talentCommissionRatio = 0;
  if (commission.talent_info && commission.talent_info.nickname) {
    const t = commission.talent_info;
    talentName = t.nickname;
    talentType = 'talent';
    talentId = t.opentalentid || t.talent_appid || '';
    talentCommission = (t.amount || 0) / 100;
    talentCommissionRatio = (t.ratio || 0) / 10000;
  } else if (commission.finder_info && commission.finder_info.nickname) {
    const f = commission.finder_info;
    talentName = f.nickname;
    talentType = 'finder';
    talentId = f.openfinderid || '';
    talentCommission = (f.amount || 0) / 100;
    talentCommissionRatio = (f.ratio || 0) / 10000;
  } else if (commission.sharer_info && commission.sharer_info.nickname) {
    const s = commission.sharer_info;
    talentName = s.nickname;
    talentType = 'sharer';
    talentId = s.opensharerid || s.sharer_appid || '';
    talentCommission = (s.amount || 0) / 100;
    talentCommissionRatio = (s.ratio || 0) / 10000;
  }

  const timestamp = orderInfo.pay_time || orderInfo.create_time || raw.create_time || Date.now() / 1000;
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10);

  const orderStatusMap = { 10: '待付款', 12: '待收礼', 17: '待使用', 20: '待发货', 21: '部分发货', 30: '待收货', 100: '已完成', 200: '已取消', 250: '已取消' };
  const commissionStatusMap = { 20: '未结算', 100: '已结算', 200: '取消结算' };

  return {
    id: `${raw.order_id}_${raw.sku_id}`,
    orderId: String(raw.order_id),
    skuId: raw.sku_id,
    date,
    talentName,
    talentType,
    talentId,
    shopName: shop.shop_name || '',
    shopAppid: shop.appid || '',
    productTitle: product.title || '',
    productId: product.product_id || '',
    productImg: product.head_img || '',
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

// ============ 从仓库已有的 data.json 读取配置（保留用户在云端做的修改） ============
async function readExistingConfig() {
  try {
    if (fs.existsSync(OUTPUT_FILE)) {
      const raw = fs.readFileSync(OUTPUT_FILE, 'utf-8');
      const data = JSON.parse(raw);
      log(`从已有 data.json 读取配置: ${Object.keys(data.mapping || {}).length} 个映射, ${Object.keys(data.users || {}).length} 个用户, ${(data.personnel?.channels||[]).length} 个渠道, ${(data.personnel?.zhaoshangs||[]).length} 个招商`);
      return {
        mapping: data.mapping || {},
        users: data.users || {},
        personnel: data.personnel || { channels: [], zhaoshangs: [] },
        products: data.products || [],
        productMapping: data.productMapping || {}
      };
    }
  } catch (e) {
    log(`读取已有 data.json 失败: ${e.message}`);
  }
  return {
    mapping: {}, users: {}, personnel: { channels: [], zhaoshangs: [] },
    products: [], productMapping: {}
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
    const startTime = endTime - SYNC_DAYS * 24 * 3600;
    log(`开始同步最近 ${SYNC_DAYS} 天的佣金订单...`);

    const orderList = await fetchOrderList(startTime, endTime);
    log(`共获取到 ${orderList.length} 条佣金单`);

    if (orderList.length === 0) {
      log('无订单数据');
    }

    // 3. 获取每条订单详情
    const detailedOrders = [];
    let fetched = 0, errors = 0;

    for (const item of orderList) {
      try {
        await sleep(200);
        const detail = await fetchOrderDetail(item.order_id, item.sku_id);
        const transformed = transformOrder(detail);
        detailedOrders.push(transformed);
        fetched++;

        if (fetched % 10 === 0) {
          log(`已获取 ${fetched}/${orderList.length} 条订单详情...`);
        }
      } catch (err) {
        errors++;
        log(`订单 ${item.order_id} 详情获取失败: ${err.message}`);
      }
    }

    // 4. 转换数据
    const mappedOrders = applyMapping(detailedOrders, userConfig.mapping);
    const talents = extractTalents(detailedOrders, userConfig.mapping);

    log(`数据转换完成！成功 ${fetched} 条，失败 ${errors} 条`);

    // 5. 保存到 data.json 文件（GitHub Actions 会自动提交到仓库）
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
    console.log(`  订单数: ${mappedOrders.length}`);
    console.log(`  达人数: ${talents.length}`);
    console.log(`  失败数: ${errors}`);
    console.log(`  数据文件: cloud-sync/data.json`);
    console.log('═══════════════════════════════════════════');

  } catch (err) {
    console.error(`\n❌ 同步失败: ${err.message}`);
    process.exit(1);
  }
}

main();
