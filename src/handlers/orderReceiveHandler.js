'use strict';

const { getDb } = require('../db/database');
const sheets = require('../integrations/sheetsSync');

// 受注番号採番: ORD-YYYYMMDD-001
function generateOrderNumber(db) {
  const now = new Date();
  const dateStr = now.getFullYear().toString()
    + String(now.getMonth()+1).padStart(2,'0')
    + String(now.getDate()).padStart(2,'0');
  const prefix = `ORD-${dateStr}-`;
  const count = db.prepare("SELECT COUNT(*) as c FROM received_orders WHERE order_number LIKE ?").get(`${prefix}%`).c;
  return prefix + String(count+1).padStart(3,'0');
}

function fmtMoney(n) { return '¥' + Number(n).toLocaleString('ja-JP'); }

/** 受注登録: 「受注登録 田中建設 杉板2×4 100枚 檜角材 50本」 */
async function handleRegisterOrder(client, replyToken, customerName, itemsText) {
  const db = getDb();
  const customer = db.prepare('SELECT * FROM customers WHERE company_name LIKE ?').get(`%${customerName}%`);
  if (!customer) {
    return client.replyMessage({ replyToken, messages: [{ type:'text', text:`「${customerName}」に一致する顧客が見つかりません。` }] });
  }

  // 品目パース: 「杉板2×4 100枚 檜角材 50本」
  const items = [];
  const regex = /([^\d\s]+(?:\d+[×xX]\d+)?[^\d\s]*)\s+(\d+)[枚本個袋kg]?/g;
  let m;
  while ((m = regex.exec(itemsText)) !== null) {
    const productName = m[1].trim();
    const quantity = parseInt(m[2], 10);
    const product = db.prepare('SELECT * FROM products WHERE name LIKE ? OR spec LIKE ?').get(`%${productName}%`, `%${productName}%`);
    const unitPrice = product ? Math.round(product.unit_price * (customer.discount_rate || 1)) : 0;
    items.push({
      product_name: product ? `${product.name} ${product.spec}` : productName,
      quantity,
      unit: product ? product.unit : '個',
      unit_price: unitPrice,
      amount: unitPrice * quantity,
      current_stock: product ? product.stock : null,
    });
  }
  if (!items.length) {
    return client.replyMessage({ replyToken, messages: [{ type:'text', text:'品目を解析できませんでした。\n例:「受注登録 田中建設 杉板2×4 100枚 檜角材 50本」' }] });
  }

  const total = items.reduce((s,i) => s+i.amount, 0);
  const orderNumber = generateOrderNumber(db);

  // 在庫不足チェック
  const shortages = items.filter(i => i.current_stock !== null && i.current_stock < i.quantity);

  db.prepare(`INSERT INTO received_orders (order_number, customer_id, customer_name, items, total_amount, status)
    VALUES (?,?,?,?,?,'受注済')`).run(orderNumber, customer.id, customer.company_name, JSON.stringify(items), total);

  const itemLines = items.map(i => `・${i.product_name} ${i.quantity}${i.unit} ${fmtMoney(i.amount)}`).join('\n');

  return client.replyMessage({ replyToken, messages: [{
    type: 'flex', altText: `受注登録完了 ${orderNumber}`,
    contents: {
      type: 'bubble',
      header: { type:'box', layout:'vertical', backgroundColor:'#1B3A2D', paddingAll:'12px',
        contents: [
          { type:'text', text:'📦 受注登録完了', color:'#fff', weight:'bold', size:'md' },
          { type:'text', text:orderNumber, color:'#a5d6a7', size:'xs', margin:'xs' },
        ]},
      body: { type:'box', layout:'vertical', paddingAll:'12px',
        contents: [
          { type:'box', layout:'horizontal', contents:[
            { type:'text', text:'顧客', size:'xs', color:'#888', flex:3 },
            { type:'text', text:customer.company_name, size:'sm', weight:'bold', flex:7 },
          ]},
          { type:'separator', margin:'sm' },
          ...items.slice(0,5).map(i=>({ type:'box', layout:'horizontal', margin:'xs',
            contents:[
              { type:'text', text:i.product_name, size:'xs', flex:5, wrap:true },
              { type:'text', text:`${i.quantity}${i.unit}`, size:'xs', flex:2, align:'center' },
              { type:'text', text:fmtMoney(i.amount), size:'xs', flex:3, align:'end' },
            ]})),
          { type:'separator', margin:'sm' },
          { type:'box', layout:'horizontal', margin:'sm',
            contents:[
              { type:'text', text:'合計', size:'sm', weight:'bold', flex:5 },
              { type:'text', text:fmtMoney(total), size:'sm', weight:'bold', flex:5, align:'end', color:'#1B3A2D' },
            ]},
          ...(shortages.length>0 ? [{ type:'text', text:`⚠️ 在庫不足 ${shortages.length}品目`, size:'xs', color:'#e53935', margin:'sm', wrap:true }] : []),
          { type:'text', text:'「受注一覧」で全受注を確認できます', size:'xs', color:'#888', margin:'sm' },
        ]},
    },
  }] });
}

/** 受注一覧: 未完了の受注 */
async function handleListOrders(client, replyToken) {
  const db = getDb();
  const orders = db.prepare("SELECT * FROM received_orders WHERE status != '完了' ORDER BY created_at DESC LIMIT 10").all();

  if (!orders.length) {
    return client.replyMessage({ replyToken, messages: [{ type:'text', text:'未完了の受注はありません。' }] });
  }

  const statusColor = { '受注済':'#1D4ED8', '出庫済':'#D97706', '配達済':'#7C3AED', '請求済':'#059669', '完了':'#6B7280' };

  const bubbles = orders.map(o => {
    const items = JSON.parse(o.items || '[]');
    const itemSummary = items.slice(0,2).map(i=>`${i.product_name} ${i.quantity}${i.unit}`).join(' / ') + (items.length>2?` 他${items.length-2}件`:'');
    return {
      type:'bubble', size:'micro',
      header:{ type:'box', layout:'vertical', backgroundColor: statusColor[o.status]||'#1B3A2D', paddingAll:'8px',
        contents:[
          { type:'text', text:o.order_number, color:'#fff', size:'xs', weight:'bold' },
          { type:'text', text:o.status, color:'#fff', size:'xs', margin:'xs' },
        ]},
      body:{ type:'box', layout:'vertical', paddingAll:'10px',
        contents:[
          { type:'text', text:o.customer_name, size:'sm', weight:'bold' },
          { type:'text', text:itemSummary, size:'xs', color:'#555', margin:'xs', wrap:true },
          { type:'text', text:fmtMoney(o.total_amount), size:'sm', weight:'bold', color:'#1B3A2D', margin:'xs' },
          { type:'text', text:o.created_at.slice(0,10), size:'xs', color:'#888' },
        ]},
    };
  });

  return client.replyMessage({ replyToken, messages: [{
    type:'flex', altText:'受注一覧',
    contents:{ type:'carousel', contents:bubbles },
  }] });
}

/** 受注確認: 「受注確認 ORD-XXXXXXXX-001」 */
async function handleCheckOrder(client, replyToken, orderNumber) {
  const db = getDb();
  const order = db.prepare('SELECT * FROM received_orders WHERE order_number = ?').get(orderNumber);
  if (!order) {
    return client.replyMessage({ replyToken, messages: [{ type:'text', text:`受注番号「${orderNumber}」が見つかりません。` }] });
  }
  const items = JSON.parse(order.items || '[]');
  const itemLines = items.map(i=>`・${i.product_name} ${i.quantity}${i.unit} ${fmtMoney(i.amount)}`).join('\n');
  return client.replyMessage({ replyToken, messages: [{ type:'text',
    text:`📦 受注詳細\n\n受注番号: ${order.order_number}\n顧客: ${order.customer_name}\nステータス: ${order.status}\n\n【品目】\n${itemLines}\n\n合計: ${fmtMoney(order.total_amount)}\n受注日: ${order.created_at.slice(0,10)}`
  }] });
}

module.exports = { handleRegisterOrder, handleListOrders, handleCheckOrder };
