'use strict';

const { getDb } = require('../db/database');
const {
  buildOrderListFlex,
  buildOrderConfirmFlex,
} = require('../line/flexMessages');
const sheets = require('../integrations/sheetsSync');
const gmail  = require('../integrations/gmailSend');

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

  await client.replyMessage({
    replyToken,
    messages: [
      {
        type: 'text',
        text: `✅ 発注 #${orderId} を承認しました。\n\n品名: ${order.product_name}\n数量: ${order.quantity}\n仕入先: ${order.supplier_name || '未定'}\n\n仕入先への連絡を行ってください。`,
      },
    ],
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

module.exports = { handleOrderList, handleCreateOrder, handleApproveOrder, handleRejectOrder };
