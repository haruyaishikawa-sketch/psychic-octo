'use strict';

const { getDb } = require('../db/database');
const { getSession, setSession, clearSession } = require('../sessions/stocktakeSession');

// ────────────────────────────────────────────────────────────────
// 出庫フロー (multi-step)
//   step 1: select_product  → 品目一覧Flex Message
//   step 2: input_quantity  → 数量入力プロンプト
//   step 3: confirm         → 確認Flex Message
//   step 4: execute         → DB更新・返信
// ────────────────────────────────────────────────────────────────

/** 出庫開始: 品目一覧Flexを送信 */
async function startStockout(client, replyToken, userId) {
  const db = getDb();
  const products = db.prepare('SELECT id, name, spec, unit, stock FROM products ORDER BY id').all();

  if (!products.length) {
    return client.replyMessage({ replyToken, messages: [{ type: 'text', text: '品目が登録されていません。' }] });
  }

  // セッション初期化
  setSession(userId, { type: 'stockout', step: 'select_product', product: null, quantity: null });

  const bubbles = products.map(p => ({
    type: 'bubble',
    size: 'micro',
    body: {
      type: 'box',
      layout: 'vertical',
      contents: [
        { type: 'text', text: p.name, weight: 'bold', size: 'sm', wrap: true },
        { type: 'text', text: p.spec, size: 'xs', color: '#888888', wrap: true },
        { type: 'text', text: `在庫: ${p.stock} ${p.unit}`, size: 'xs', color: p.stock <= 5 ? '#e53935' : '#388E3C', margin: 'sm' },
      ],
      paddingAll: '12px',
    },
    footer: {
      type: 'box',
      layout: 'vertical',
      contents: [{
        type: 'button',
        action: { type: 'postback', label: '選択', data: `action=stockout_select&productId=${p.id}` },
        style: 'primary',
        color: '#388E3C',
        height: 'sm',
      }],
      paddingAll: '8px',
    },
  }));

  const flex = {
    type: 'flex',
    altText: '出庫する品目を選択してください',
    contents: {
      type: 'carousel',
      contents: bubbles.slice(0, 12), // LINE limit
    },
  };

  return client.replyMessage({ replyToken, messages: [
    { type: 'text', text: '⬇️ 出庫する品目を選択してください:' },
    flex,
  ]});
}

/** 品目選択後: 数量入力プロンプト */
async function handleProductSelect(client, replyToken, userId, productId) {
  const sess = getSession(userId);
  if (!sess || sess.type !== 'stockout') {
    return client.replyMessage({ replyToken, messages: [{ type: 'text', text: 'セッションが切れました。もう一度「出庫」を押してください。' }] });
  }

  const db = getDb();
  const product = db.prepare('SELECT id, name, spec, unit, stock FROM products WHERE id = ?').get(Number(productId));
  if (!product) {
    return client.replyMessage({ replyToken, messages: [{ type: 'text', text: '品目が見つかりませんでした。' }] });
  }

  setSession(userId, { ...sess, step: 'input_quantity', product: { id: product.id, name: product.name, unit: product.unit, stock: product.stock } });

  return client.replyMessage({ replyToken, messages: [{
    type: 'text',
    text: `📦 ${product.name}（${product.spec}）\n現在在庫: ${product.stock} ${product.unit}\n\n出庫数量を入力してください（例: 10）`,
  }]});
}

/** 数量入力後: 確認Flexを返す */
async function handleQuantityInput(client, replyToken, userId, quantityText) {
  const sess = getSession(userId);
  if (!sess || sess.type !== 'stockout' || sess.step !== 'input_quantity') return false;

  const quantity = parseInt(quantityText, 10);
  if (isNaN(quantity) || quantity <= 0) {
    await client.replyMessage({ replyToken, messages: [{ type: 'text', text: '半角数字で数量を入力してください（例: 10）' }] });
    return true;
  }

  const { product } = sess;
  if (quantity > product.stock) {
    await client.replyMessage({ replyToken, messages: [{ type: 'text', text: `⚠️ 在庫不足です。現在在庫は ${product.stock} ${product.unit} です。` }] });
    return true;
  }

  setSession(userId, { ...sess, step: 'confirm', quantity });

  const afterStock = product.stock - quantity;

  const flex = {
    type: 'flex',
    altText: '出庫確認',
    contents: {
      type: 'bubble',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: '#1B5E20',
        contents: [{ type: 'text', text: '⬇️ 出庫確認', color: '#ffffff', weight: 'bold', size: 'md' }],
        paddingAll: '12px',
      },
      body: {
        type: 'box',
        layout: 'vertical',
        contents: [
          { type: 'box', layout: 'horizontal', contents: [
            { type: 'text', text: '品目', size: 'sm', color: '#888888', flex: 2 },
            { type: 'text', text: product.name, size: 'sm', weight: 'bold', flex: 5, wrap: true },
          ]},
          { type: 'box', layout: 'horizontal', contents: [
            { type: 'text', text: '出庫数量', size: 'sm', color: '#888888', flex: 2 },
            { type: 'text', text: `${quantity} ${product.unit}`, size: 'sm', weight: 'bold', color: '#e53935', flex: 5 },
          ], margin: 'sm' },
          { type: 'box', layout: 'horizontal', contents: [
            { type: 'text', text: '出庫後在庫', size: 'sm', color: '#888888', flex: 2 },
            { type: 'text', text: `${afterStock} ${product.unit}`, size: 'sm', flex: 5 },
          ], margin: 'sm' },
          { type: 'separator', margin: 'md' },
          { type: 'text', text: '上記内容で出庫しますか？', size: 'sm', margin: 'md', wrap: true },
        ],
        paddingAll: '16px',
      },
      footer: {
        type: 'box',
        layout: 'horizontal',
        spacing: 'sm',
        contents: [
          {
            type: 'button',
            action: { type: 'postback', label: '✅ 出庫する', data: 'action=stockout_execute' },
            style: 'primary',
            color: '#388E3C',
          },
          {
            type: 'button',
            action: { type: 'postback', label: '❌ キャンセル', data: 'action=stockout_cancel' },
            style: 'secondary',
          },
        ],
        paddingAll: '12px',
      },
    },
  };

  await client.replyMessage({ replyToken, messages: [flex] });
  return true;
}

/** 出庫実行: DB更新 */
async function executeStockout(client, replyToken, userId) {
  const sess = getSession(userId);
  if (!sess || sess.type !== 'stockout' || sess.step !== 'confirm') {
    return client.replyMessage({ replyToken, messages: [{ type: 'text', text: 'セッションが切れました。もう一度「出庫」を押してください。' }] });
  }

  const { product, quantity } = sess;
  clearSession(userId);

  const db = getDb();
  const current = db.prepare('SELECT stock, reorder_point FROM products WHERE id = ?').get(product.id);
  if (!current) {
    return client.replyMessage({ replyToken, messages: [{ type: 'text', text: '品目が見つかりませんでした。' }] });
  }
  if (quantity > current.stock) {
    return client.replyMessage({ replyToken, messages: [{ type: 'text', text: `⚠️ 在庫不足。現在在庫: ${current.stock} ${product.unit}` }] });
  }

  const newStock = current.stock - quantity;
  db.prepare("UPDATE products SET stock = ?, updated_at = datetime('now','localtime') WHERE id = ?").run(newStock, product.id);

  const msgs = [{
    type: 'text',
    text: `✅ 出庫完了\n品目: ${product.name}\n数量: ${quantity} ${product.unit}\n出庫後在庫: ${newStock} ${product.unit}`,
  }];

  if (newStock <= current.reorder_point) {
    msgs.push({
      type: 'text',
      text: `⚠️ 発注アラート\n${product.name} の在庫が発注点（${current.reorder_point} ${product.unit}）以下になりました。\n発注を検討してください。`,
    });
  }

  return client.replyMessage({ replyToken, messages: msgs });
}

/** キャンセル */
async function cancelStockout(client, replyToken, userId) {
  clearSession(userId);
  return client.replyMessage({ replyToken, messages: [{ type: 'text', text: '出庫をキャンセルしました。' }] });
}

module.exports = {
  startStockout,
  handleProductSelect,
  handleQuantityInput,
  executeStockout,
  cancelStockout,
};
