'use strict';

const { getDb } = require('../db/database');
const {
  buildInventoryListFlex,
  buildProductDetailFlex,
} = require('../line/flexMessages');
const sheets = require('../integrations/sheetsSync');
const gmail  = require('../integrations/gmailSend');

// 全在庫一覧を返す
async function handleInventoryList(client, replyToken) {
  const db = getDb();
  const products = db.prepare('SELECT * FROM products ORDER BY id').all();

  const message = buildInventoryListFlex(products);
  await client.replyMessage({ replyToken, messages: [message] });
}

// 特定品目の在庫確認
async function handleProductSearch(client, replyToken, keyword) {
  const db = getDb();
  const product = db
    .prepare('SELECT * FROM products WHERE (name || spec) LIKE ? OR (name || " " || spec) LIKE ?')
    .get(`%${keyword}%`, `%${keyword}%`);

  if (!product) {
    await client.replyMessage({
      replyToken,
      messages: [{ type: 'text', text: `「${keyword}」に一致する品目が見つかりませんでした。\n\n「在庫確認」で全品目の一覧を確認できます。` }],
    });
    return;
  }

  const message = buildProductDetailFlex(product);
  await client.replyMessage({ replyToken, messages: [message] });
}

// 入庫処理
async function handleStockIn(client, replyToken, keyword, quantity) {
  const db = getDb();
  const product = db
    .prepare('SELECT * FROM products WHERE (name || spec) LIKE ? OR (name || " " || spec) LIKE ?')
    .get(`%${keyword}%`, `%${keyword}%`);

  if (!product) {
    await client.replyMessage({
      replyToken,
      messages: [{ type: 'text', text: `「${keyword}」に一致する品目が見つかりませんでした。` }],
    });
    return;
  }

  const newStock = product.stock + quantity;
  db.prepare('UPDATE products SET stock = ?, updated_at = datetime("now","localtime") WHERE id = ?').run(newStock, product.id);

  await client.replyMessage({
    replyToken,
    messages: [
      {
        type: 'text',
        text: `✅ 入庫完了\n\n品名: ${product.name} ${product.spec}\n入庫数: +${quantity}${product.unit}\n更新後在庫: ${newStock}${product.unit}`,
      },
    ],
  });

  // Sheets 同期（非同期）
  sheets.runAsync(sheets.syncInventory, product.id);
}

// 出庫処理
async function handleStockOut(client, replyToken, keyword, quantity, adminLineId) {
  const db = getDb();
  const product = db
    .prepare('SELECT * FROM products WHERE (name || spec) LIKE ? OR (name || " " || spec) LIKE ?')
    .get(`%${keyword}%`, `%${keyword}%`);

  if (!product) {
    await client.replyMessage({
      replyToken,
      messages: [{ type: 'text', text: `「${keyword}」に一致する品目が見つかりませんでした。` }],
    });
    return;
  }

  if (product.stock < quantity) {
    await client.replyMessage({
      replyToken,
      messages: [
        {
          type: 'text',
          text: `⚠️ 在庫不足\n\n品名: ${product.name} ${product.spec}\n現在の在庫: ${product.stock}${product.unit}\n出庫要求: ${quantity}${product.unit}\n\n在庫が足りません。`,
        },
      ],
    });
    return;
  }

  const newStock = product.stock - quantity;
  db.prepare('UPDATE products SET stock = ?, updated_at = datetime("now","localtime") WHERE id = ?').run(newStock, product.id);

  const isAlert = newStock <= product.reorder_point;
  const replyText = `✅ 出庫完了\n\n品名: ${product.name} ${product.spec}\n出庫数: -${quantity}${product.unit}\n残在庫: ${newStock}${product.unit}${isAlert ? '\n\n⚠️ 在庫が発注点を下回りました！' : ''}`;

  await client.replyMessage({
    replyToken,
    messages: [{ type: 'text', text: replyText }],
  });

  // Sheets 同期（非同期）
  sheets.runAsync(sheets.syncInventory, product.id);

  // 在庫アラート: 管理者にプッシュ通知 + メール送信
  if (isAlert) {
    if (adminLineId) {
      try {
        await client.pushMessage({
          to: adminLineId,
          messages: [{
            type: 'text',
            text: `🚨 在庫アラート\n\n${product.name} ${product.spec} の在庫が発注点以下になりました。\n現在庫: ${newStock}${product.unit} / 発注点: ${product.reorder_point}${product.unit}\n\n「発注 ${product.name}${product.spec} 100${product.unit} 山田製材所」で発注できます。`,
          }],
        });
      } catch (err) { console.error('[在庫アラート送信エラー]', err.message); }
    }
    // アラートメール送信（非同期）
    gmail.runAsync(gmail.sendStockAlertEmail, [{ ...product, stock: newStock }]);
  }
}

module.exports = { handleInventoryList, handleProductSearch, handleStockIn, handleStockOut };
