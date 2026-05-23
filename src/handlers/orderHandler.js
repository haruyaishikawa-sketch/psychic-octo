'use strict';

const { getDb } = require('../db/database');
const {
  buildOrderListFlex,
  buildOrderConfirmFlex,
} = require('../line/flexMessages');
const sheets = require('../integrations/sheetsSync');
const gmail  = require('../integrations/gmailSend');
const { generatePurchaseOrderPdf } = require('./purchaseOrderHandler');

// 未承認の発注一覧
async function handleOrderList(client, replyToken) {
  const db = getDb();
  const orders = db.prepare("SELECT * FROM orders WHERE status = 'pending' ORDER BY created_at DESC").all();

  const message = buildOrderListFlex(orders);
  await client.replyMessage({ replyToken, messages: [message] });
}

// 発注作成
async function handleCreateOrder(client, replyToken, productKeyword, quantity, supplierName, adminLineId) {
  const db = getDb();

  // 品目を検索
  const product = db
    .prepare('SELECT * FROM products WHERE (name || spec) LIKE ? OR (name || " " || spec) LIKE ?')
    .get(`%${productKeyword}%`, `%${productKeyword}%`);

  if (!product) {
    await client.replyMessage({
      replyToken,
      messages: [{ type: 'text', text: `「${productKeyword}」に一致する品目が見つかりませんでした。` }],
    });
    return;
  }

  // 仕入先を検索（なければ名前だけ保存）
  const supplier = db.prepare('SELECT * FROM suppliers WHERE company_name LIKE ?').get(`%${supplierName}%`);
  const supplierId = supplier ? supplier.id : null;
  const resolvedSupplierName = supplier ? supplier.company_name : supplierName;

  // 発注レコード作成
  const result = db.prepare(`
    INSERT INTO orders (product_id, product_name, quantity, supplier_id, supplier_name, status, requested_by)
    VALUES (?, ?, ?, ?, ?, 'pending', 'LINE')
  `).run(product.id, `${product.name} ${product.spec}`, quantity, supplierId, resolvedSupplierName);

  const newOrder = db.prepare('SELECT * FROM orders WHERE id = ?').get(Number(result.lastInsertRowid));

  const confirmMessage = buildOrderConfirmFlex(newOrder);
  await client.replyMessage({ replyToken, messages: [confirmMessage] });

  // Sheets 追記・メール送信（非同期）
  sheets.runAsync(sheets.appendOrder, newOrder);
  if (supplierId) gmail.runAsync(gmail.sendOrderConfirmEmail, supplierId, newOrder);

  // 管理者に承認依頼プッシュ
  if (adminLineId) {
    try {
      const pendingOrders = db.prepare("SELECT * FROM orders WHERE status = 'pending' ORDER BY created_at DESC").all();
      const listMessage = buildOrderListFlex(pendingOrders);
      await client.pushMessage({
        to: adminLineId,
        messages: [
          { type: 'text', text: `📋 新しい発注が登録されました。承認をお願いします。\n\n品名: ${newOrder.product_name}\n数量: ${newOrder.quantity}\n仕入先: ${newOrder.supplier_name}` },
          listMessage,
        ],
      });
    } catch (err) {
      console.error('[発注通知送信エラー]', err.message);
    }
  }
}

// 発注承認
async function handleApproveOrder(client, replyToken, orderId) {
  const db = getDb();
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);

  if (!order) {
    await client.replyMessage({
      replyToken,
      messages: [{ type: 'text', text: `発注番号 #${orderId} が見つかりませんでした。` }],
    });
    return;
  }

  if (order.status !== 'pending') {
    await client.replyMessage({
      replyToken,
      messages: [{ type: 'text', text: `発注 #${orderId} はすでに「${order.status}」状態です。` }],
    });
    return;
  }

  db.prepare("UPDATE orders SET status = 'approved', updated_at = datetime('now','localtime') WHERE id = ?").run(orderId);
  sheets.runAsync(sheets.updateOrderStatus, orderId, 'approved');

  // 仕入先情報を取得
  const supplier = order.supplier_id
    ? db.prepare('SELECT * FROM suppliers WHERE id = ?').get(Number(order.supplier_id))
    : null;

  // 発注書PDF生成 & メール送信
  let replyText;
  try {
    const { pdfPath, poNumber, deliveryDateObj } = await generatePurchaseOrderPdf(order, supplier || {
      company_name: order.supplier_name || '未定',
    });

    // PDFパスをDBに保存
    try {
      db.prepare(
        "UPDATE orders SET purchase_order_path = ?, updated_at = datetime('now','localtime') WHERE id = ?"
      ).run(pdfPath, orderId);
    } catch (_) { /* purchase_order_path カラム未存在の場合は無視 */ }

    const unit         = order.unit || '';
    const supplierName = (supplier && supplier.company_name) || order.supplier_name || '未定';
    const delStr       = `${deliveryDateObj.getFullYear()}/${String(deliveryDateObj.getMonth() + 1).padStart(2, '0')}/${String(deliveryDateObj.getDate()).padStart(2, '0')}`;

    if (supplier && supplier.email) {
      // メール送信を試みる
      const emailSent = await gmail.sendPurchaseOrderEmail(order.supplier_id, order, pdfPath);

      if (emailSent) {
        // メール送信フラグを保存
        try {
          db.prepare(
            "UPDATE orders SET email_sent = 1, email_sent_at = datetime('now','localtime'), updated_at = datetime('now','localtime') WHERE id = ?"
          ).run(orderId);
        } catch (_) { /* カラム未存在の場合は無視 */ }

        replyText = `✅ 発注 #${orderId} を承認しました。\n\n品名：${order.product_name}\n数量：${order.quantity}${unit}\n仕入先：${supplierName}\n\n📄 発注書：${poNumber}\n📧 ${supplierName}（${supplier.email}）に\n　 発注書メールを送信しました。\n\n納品希望日：${delStr}（7日後）`;
      } else {
        replyText = `✅ 発注 #${orderId} を承認しました。\n⚠️ メール送信に失敗しました。\n${supplierName}に直接ご連絡ください。\nTEL：${supplier.tel || supplier.phone || '—'}`;
      }
    } else {
      // メール未設定
      replyText = `✅ 発注 #${orderId} を承認しました。\n\n品名：${order.product_name}\n数量：${order.quantity}${unit}\n仕入先：${supplierName}\n\n📄 発注書：${poNumber}を生成しました。\n（仕入先メール未登録のため送信スキップ）`;
    }
  } catch (err) {
    console.error('[handleApproveOrder] PDF生成エラー:', err.message);
    replyText = `✅ 発注 #${orderId} を承認しました。\n⚠️ 発注書の生成に失敗しました: ${err.message}`;
  }

  await client.replyMessage({
    replyToken,
    messages: [{ type: 'text', text: replyText }],
  });
}

// 発注却下
async function handleRejectOrder(client, replyToken, orderId) {
  const db = getDb();
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);

  if (!order) {
    await client.replyMessage({
      replyToken,
      messages: [{ type: 'text', text: `発注番号 #${orderId} が見つかりませんでした。` }],
    });
    return;
  }

  if (order.status !== 'pending') {
    await client.replyMessage({
      replyToken,
      messages: [{ type: 'text', text: `発注 #${orderId} はすでに「${order.status}」状態です。` }],
    });
    return;
  }

  db.prepare("UPDATE orders SET status = 'rejected', updated_at = datetime('now','localtime') WHERE id = ?").run(orderId);
  sheets.runAsync(sheets.updateOrderStatus, orderId, 'rejected');

  await client.replyMessage({
    replyToken,
    messages: [
      {
        type: 'text',
        text: `❌ 発注 #${orderId} を却下しました。\n\n品名: ${order.product_name}\n数量: ${order.quantity}`,
      },
    ],
  });
}

/** 検収開始: 発注内容をFlexで表示 */
async function handleStartInspection(client, replyToken, orderId) {
  const db = getDb();
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(Number(orderId));
  if (!order) return client.replyMessage({ replyToken, messages:[{ type:'text', text:`発注ID ${orderId} が見つかりません。` }] });
  if (order.status !== 'approved') return client.replyMessage({ replyToken, messages:[{ type:'text', text:`発注ID ${orderId} は承認済みではありません（現在: ${order.status}）。` }] });

  return client.replyMessage({ replyToken, messages:[{
    type:'flex', altText:`検収 発注ID:${orderId}`,
    contents:{
      type:'bubble',
      header:{ type:'box', layout:'vertical', backgroundColor:'#1D4ED8', paddingAll:'12px',
        contents:[{ type:'text', text:'🔍 検収確認', color:'#ffffff', weight:'bold', size:'md' }]},
      body:{ type:'box', layout:'vertical', paddingAll:'12px',
        contents:[
          { type:'box', layout:'horizontal', contents:[
            { type:'text', text:'発注ID', size:'xs', color:'#888888', flex:3 },
            { type:'text', text:String(order.id), size:'sm', flex:7 },
          ]},
          { type:'box', layout:'horizontal', margin:'xs', contents:[
            { type:'text', text:'品名', size:'xs', color:'#888888', flex:3 },
            { type:'text', text:`${order.product_name}`, size:'sm', flex:7, wrap:true },
          ]},
          { type:'box', layout:'horizontal', margin:'xs', contents:[
            { type:'text', text:'発注数量', size:'xs', color:'#888888', flex:3 },
            { type:'text', text:`${order.quantity}`, size:'sm', flex:7 },
          ]},
          { type:'box', layout:'horizontal', margin:'xs', contents:[
            { type:'text', text:'仕入先', size:'xs', color:'#888888', flex:3 },
            { type:'text', text:order.supplier_name||'—', size:'sm', flex:7 },
          ]},
          { type:'text', text:'納品内容を確認して検収してください', size:'xs', color:'#555555', margin:'md', wrap:true },
        ]},
      footer:{ type:'box', layout:'horizontal', spacing:'sm', paddingAll:'12px',
        contents:[
          { type:'button', style:'primary', color:'#059669', height:'sm',
            action:{ type:'postback', label:'✅ 検収OK', data:`action=inspection_ok&orderId=${orderId}` }},
          { type:'button', style:'secondary', height:'sm',
            action:{ type:'postback', label:'❌ 検収NG', data:`action=inspection_ng&orderId=${orderId}` }},
        ]},
    },
  }] });
}

/** 検収OK: 入庫処理 + ステータス更新 */
async function handleInspectionOk(client, replyToken, orderId) {
  const db = getDb();
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(Number(orderId));
  if (!order) return client.replyMessage({ replyToken, messages:[{ type:'text', text:`発注ID ${orderId} が見つかりません。` }] });

  // ordersテーブルにinspection列があるか確認して更新
  try {
    db.prepare("UPDATE orders SET status='inspected', inspection_status='OK', inspected_at=datetime('now','localtime') WHERE id=?").run(Number(orderId));
  } catch(e) {
    db.prepare("UPDATE orders SET status='inspected' WHERE id=?").run(Number(orderId));
  }

  // 入庫処理
  const product = db.prepare('SELECT * FROM products WHERE name LIKE ? OR id = ?').get(`%${order.product_name ? order.product_name.split(' ')[0] : ''}%`, order.product_id || 0);
  let stockMsg = '';
  if (product) {
    const newStock = product.stock + order.quantity;
    db.prepare("UPDATE products SET stock=?, updated_at=datetime('now','localtime') WHERE id=?").run(newStock, product.id);
    stockMsg = `\n\n📦 入庫完了\n${product.name} ${product.spec}: ${product.stock} + ${order.quantity} = ${newStock}${product.unit}`;

    const sheetsLocal = require('../integrations/sheetsSync');
    sheetsLocal.runAsync(sheetsLocal.syncInventory, product.id);
  }

  return client.replyMessage({ replyToken, messages:[{ type:'text',
    text:`✅ 検収OK\n\n発注ID: ${orderId}\n品名: ${order.product_name}\n数量: ${order.quantity}${stockMsg}`
  }] });
}

/** 検収NG: ステータス更新 + 通知 */
async function handleInspectionNg(client, replyToken, orderId, reason, adminLineId) {
  const db = getDb();
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(Number(orderId));
  if (!order) return client.replyMessage({ replyToken, messages:[{ type:'text', text:`発注ID ${orderId} が見つかりません。` }] });

  try {
    db.prepare("UPDATE orders SET status='inspection_ng', inspection_status='NG', inspected_at=datetime('now','localtime'), inspection_memo=? WHERE id=?")
      .run(reason||'理由未記載', Number(orderId));
  } catch(e) {
    db.prepare("UPDATE orders SET status='inspection_ng' WHERE id=?").run(Number(orderId));
  }

  if (adminLineId) {
    try {
      await client.pushMessage({ to:adminLineId, messages:[{ type:'text',
        text:`🚨 検収NG通知\n\n発注ID: ${orderId}\n品名: ${order.product_name}\n理由: ${reason||'未記載'}\n仕入先: ${order.supplier_name||'—'}`
      }] });
    } catch(e) { console.error('[検収NG通知エラー]', e.message); }
  }

  return client.replyMessage({ replyToken, messages:[{ type:'text',
    text:`❌ 検収NG\n\n発注ID: ${orderId}\n品名: ${order.product_name}\n理由: ${reason||'未記載'}\n\n管理者に通知しました。`
  }] });
}

module.exports = { handleOrderList, handleCreateOrder, handleApproveOrder, handleRejectOrder, handleStartInspection, handleInspectionOk, handleInspectionNg };
