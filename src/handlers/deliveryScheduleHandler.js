'use strict';

const { getDb } = require('../db/database');

function fmtMoney(n) { return '¥' + Number(n).toLocaleString('ja-JP'); }

function parseDeliveryDate(text) {
  const today = new Date();
  today.setHours(0,0,0,0);
  if (text.includes('今日') || text.includes('本日')) return today.toISOString().split('T')[0];
  if (text.includes('明日') || text.includes('あす')) {
    const d = new Date(today); d.setDate(d.getDate()+1);
    return d.toISOString().split('T')[0];
  }
  if (text.includes('明後日')) {
    const d = new Date(today); d.setDate(d.getDate()+2);
    return d.toISOString().split('T')[0];
  }
  // YYYY-MM-DD or MM/DD
  const m1 = text.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m1) return `${m1[1]}-${m1[2].padStart(2,'0')}-${m1[3].padStart(2,'0')}`;
  const m2 = text.match(/(\d{1,2})\/(\d{1,2})/);
  if (m2) return `${today.getFullYear()}-${m2[1].padStart(2,'0')}-${m2[2].padStart(2,'0')}`;
  return today.toISOString().split('T')[0];
}

function parseTimeSlot(text) {
  if (text.includes('午前')) return '午前';
  if (text.includes('午後')) return '午後';
  return '指定なし';
}

/** 「配達登録 ORD-XXXXXXXX-001 明日午前」 */
async function handleRegisterDelivery(client, replyToken, orderNumber, dateTimeText) {
  const db = getDb();
  const order = db.prepare('SELECT * FROM received_orders WHERE order_number = ?').get(orderNumber);
  if (!order) {
    return client.replyMessage({ replyToken, messages: [{ type:'text', text:`受注「${orderNumber}」が見つかりません。` }] });
  }

  const deliveryDate = parseDeliveryDate(dateTimeText);
  const timeSlot = parseTimeSlot(dateTimeText);
  const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(order.customer_id);

  db.prepare(`INSERT INTO deliveries (received_order_id, order_number, delivery_date, time_slot, customer_name, address, status)
    VALUES (?,?,?,?,?,?,'予定')`).run(
    order.id, orderNumber, deliveryDate, timeSlot,
    order.customer_name, customer ? (customer.address || '') : ''
  );

  const dateObj = new Date(deliveryDate);
  const dateJP = `${dateObj.getMonth()+1}月${dateObj.getDate()}日`;

  return client.replyMessage({ replyToken, messages: [{ type:'text',
    text:`🚚 配達予定を登録しました\n\n受注番号: ${orderNumber}\n顧客: ${order.customer_name}\n配達日: ${dateJP}（${timeSlot}）\n\n「配達一覧」で確認できます。`
  }] });
}

/** 「配達一覧」または「今日の配達」 */
async function handleListDeliveries(client, replyToken, todayOnly = false) {
  const db = getDb();
  const today = new Date().toISOString().split('T')[0];
  const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate()+1);
  const tomorrowStr = tomorrow.toISOString().split('T')[0];

  const deliveries = todayOnly
    ? db.prepare("SELECT * FROM deliveries WHERE delivery_date = ? AND status != '完了' ORDER BY time_slot").all(today)
    : db.prepare("SELECT * FROM deliveries WHERE delivery_date <= ? AND status != '完了' ORDER BY delivery_date, time_slot").all(tomorrowStr);

  if (!deliveries.length) {
    return client.replyMessage({ replyToken, messages: [{ type:'text', text: todayOnly ? '今日の配達予定はありません。' : '配達予定はありません。' }] });
  }

  const timeColor = { '午前':'#1D4ED8', '午後':'#D97706', '指定なし':'#6B7280' };
  const bubbles = deliveries.map(d => {
    const order = db.prepare('SELECT * FROM received_orders WHERE order_number = ?').get(d.order_number);
    const items = order ? JSON.parse(order.items||'[]') : [];
    const summary = items.slice(0,2).map(i=>`${i.product_name} ${i.quantity}${i.unit}`).join(', ');
    const dateObj = new Date(d.delivery_date);
    const isToday = d.delivery_date === today;
    return {
      type:'bubble', size:'micro',
      header:{ type:'box', layout:'vertical', backgroundColor: timeColor[d.time_slot]||'#1B3A2D', paddingAll:'8px',
        contents:[
          { type:'text', text: isToday ? `今日（${d.time_slot}）` : `${dateObj.getMonth()+1}/${dateObj.getDate()}（${d.time_slot}）`, color:'#ffffff', size:'xs', weight:'bold' },
        ]},
      body:{ type:'box', layout:'vertical', paddingAll:'10px',
        contents:[
          { type:'text', text:d.customer_name, size:'sm', weight:'bold' },
          { type:'text', text:summary||'品目不明', size:'xs', color:'#555555', margin:'xs', wrap:true },
          { type:'text', text:d.order_number, size:'xs', color:'#888888', margin:'xs' },
        ]},
      footer:{ type:'box', layout:'vertical', paddingAll:'8px',
        contents:[{
          type:'button', height:'sm', style:'primary', color:'#1B3A2D',
          action:{ type:'postback', label:'✅ 配達完了', data:`action=delivery_complete&orderId=${d.order_number}` },
        }]},
    };
  });

  return client.replyMessage({ replyToken, messages: [{
    type:'flex', altText: todayOnly ? '今日の配達' : '配達一覧',
    contents: bubbles.length===1 ? bubbles[0] : { type:'carousel', contents:bubbles },
  }] });
}

/** 「配達完了 ORD-XXXXXXXX-001」またはpostback */
async function handleCompleteDelivery(client, replyToken, orderNumber) {
  const db = getDb();
  const delivery = db.prepare("SELECT * FROM deliveries WHERE order_number = ? AND status='予定'").get(orderNumber);
  if (!delivery) {
    return client.replyMessage({ replyToken, messages: [{ type:'text', text:`「${orderNumber}」の配達予定が見つかりません。` }] });
  }

  db.prepare("UPDATE deliveries SET status='完了', updated_at=datetime('now','localtime') WHERE id=?").run(delivery.id);
  db.prepare("UPDATE received_orders SET status='配達済', updated_at=datetime('now','localtime') WHERE order_number=?").run(orderNumber);

  return client.replyMessage({ replyToken, messages: [{ type:'text',
    text:`✅ 配達完了\n\n受注番号: ${orderNumber}\n顧客: ${delivery.customer_name}\n\n受注ステータスを「配達済」に更新しました。`
  }] });
}

/** 毎朝8時の配達リマインド（cron用） */
async function sendDailyDeliveryReminder(lineClient) {
  const adminId = process.env.ADMIN_LINE_USER_ID;
  if (!adminId) return;
  const db = getDb();
  const today = new Date().toISOString().split('T')[0];
  const deliveries = db.prepare("SELECT * FROM deliveries WHERE delivery_date=? AND status='予定' ORDER BY time_slot").all(today);

  if (!deliveries.length) {
    await lineClient.pushMessage({ to:adminId, messages:[{ type:'text', text:`🚚 本日（${today}）の配達予定はありません。` }] });
    return;
  }

  const lines = deliveries.map(d=>`・${d.time_slot} ${d.customer_name}（${d.order_number}）`).join('\n');
  await lineClient.pushMessage({ to:adminId, messages:[{ type:'text',
    text:`🚚 本日の配達予定 ${deliveries.length}件\n\n${lines}\n\n各配達完了後に「配達完了 受注番号」と送ってください。`
  }] });
}

module.exports = { handleRegisterDelivery, handleListDeliveries, handleCompleteDelivery, sendDailyDeliveryReminder };
