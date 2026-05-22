'use strict';

const { getDb } = require('../db/database');
const { getSession, setSession, clearSession } = require('../sessions/stocktakeSession');
const sheets = require('../integrations/sheetsSync');

// ────────────────────────────────────────────────────────────────
// 棚卸しフロー
//   1. 「棚卸し開始」 → 全品目リストを表示してモード開始
//   2. 「棚卸し [品名キーワード] [実数量]」 → 品目の実地在庫を記録
//   3. 「棚卸し完了」 → 差異サマリーを表示して反映確認Flex
//   4. postback action=stocktake_apply → DB一括更新 + 調整履歴保存
//   5. postback action=stocktake_cancel → セッションクリア
//   6. 「棚卸し履歴」 → inventory_adjustments の最新10件
// ────────────────────────────────────────────────────────────────

/** 棚卸し開始 */
async function startStocktake(client, replyToken, userId) {
  const db = getDb();
  const products = db.prepare('SELECT id, name, unit, stock FROM products ORDER BY id').all();

  if (!products.length) {
    return client.replyMessage({ replyToken, messages: [{ type: 'text', text: '品目が登録されていません。' }] });
  }

  // セッション初期化（品目ごとに実地在庫 null でセット）
  const items = {};
  for (const p of products) {
    items[p.id] = { name: p.name, unit: p.unit, systemStock: p.stock, actualStock: null, diff: null };
  }
  setSession(userId, { type: 'stocktake', step: 'in_progress', items });

  // 品目一覧テキスト
  const list = products.map(p => `  • ${p.name}（在庫: ${p.stock} ${p.unit}）`).join('\n');

  const msg = `📋 棚卸しモードを開始しました。\n\n【登録品目】\n${list}\n\n実地数量を以下の形式で入力してください：\n「棚卸し [品名キーワード] [実数量]」\n例: 棚卸し 杉 45\n\nすべて入力し終えたら「棚卸し完了」と送ってください。\n中断するには「棚卸しキャンセル」と送ってください。`;

  return client.replyMessage({ replyToken, messages: [{ type: 'text', text: msg }] });
}

/** 棚卸し入力: 「棚卸し [キーワード] [数量]」 */
async function inputStocktakeItem(client, replyToken, userId, keyword, quantityText) {
  const sess = getSession(userId);
  if (!sess || sess.type !== 'stocktake') {
    return client.replyMessage({ replyToken, messages: [{ type: 'text', text: '棚卸しモードではありません。「棚卸し開始」と送ってください。' }] });
  }

  const quantity = parseInt(quantityText, 10);
  if (isNaN(quantity) || quantity < 0) {
    return client.replyMessage({ replyToken, messages: [{ type: 'text', text: '数量は0以上の整数で入力してください。' }] });
  }

  // キーワードで品目を検索（部分一致）
  const matched = Object.entries(sess.items).filter(([, v]) => v.name.includes(keyword));
  if (matched.length === 0) {
    return client.replyMessage({ replyToken, messages: [{ type: 'text', text: `「${keyword}」に一致する品目が見つかりません。` }] });
  }
  if (matched.length > 1) {
    const names = matched.map(([, v]) => v.name).join('、');
    return client.replyMessage({ replyToken, messages: [{ type: 'text', text: `「${keyword}」は複数の品目に一致します：${names}\nより具体的なキーワードを入力してください。` }] });
  }

  const [productId, item] = matched[0];
  item.actualStock = quantity;
  item.diff = quantity - item.systemStock;

  // セッション更新
  setSession(userId, sess);

  // 残り未入力品目
  const remaining = Object.values(sess.items).filter(v => v.actualStock === null);
  const diffText = item.diff === 0 ? '差異なし' : (item.diff > 0 ? `+${item.diff}（実地が多い）` : `${item.diff}（実地が少ない）`);

  let reply = `✅ ${item.name}: 帳簿 ${item.systemStock} → 実地 ${quantity} ${item.unit}（${diffText}）`;
  if (remaining.length > 0) {
    reply += `\n\n残り ${remaining.length} 品目: ${remaining.map(v => v.name).join('、')}`;
  } else {
    reply += '\n\n全品目の入力が完了しました！\n「棚卸し完了」と送ると差異サマリーを確認できます。';
  }

  return client.replyMessage({ replyToken, messages: [{ type: 'text', text: reply }] });
}

/** 棚卸し完了: 差異サマリー表示 + 反映確認Flex */
async function finishStocktake(client, replyToken, userId) {
  const sess = getSession(userId);
  if (!sess || sess.type !== 'stocktake') {
    return client.replyMessage({ replyToken, messages: [{ type: 'text', text: '棚卸しモードではありません。' }] });
  }

  const allItems = Object.entries(sess.items);
  const notEntered = allItems.filter(([, v]) => v.actualStock === null);

  if (notEntered.length > 0) {
    const names = notEntered.map(([, v]) => v.name).join('、');
    return client.replyMessage({ replyToken, messages: [{ type: 'text', text: `まだ未入力の品目があります：\n${names}\n\n入力が終わったら「棚卸し完了」と送ってください。\n未入力のまま完了する場合は「棚卸し完了 強制」と送ってください。` }] });
  }

  return sendStocktakeSummary(client, replyToken, allItems);
}

/** 棚卸し完了（強制: 未入力品目をスキップ） */
async function finishStocktakeForce(client, replyToken, userId) {
  const sess = getSession(userId);
  if (!sess || sess.type !== 'stocktake') {
    return client.replyMessage({ replyToken, messages: [{ type: 'text', text: '棚卸しモードではありません。' }] });
  }

  // 未入力はスキップ（actualStock が null のものを除外）
  const entered = Object.entries(sess.items).filter(([, v]) => v.actualStock !== null);
  if (entered.length === 0) {
    return client.replyMessage({ replyToken, messages: [{ type: 'text', text: '実地数量が1件も入力されていません。' }] });
  }

  return sendStocktakeSummary(client, replyToken, entered);
}

/** サマリーFlex生成・送信ヘルパー */
async function sendStocktakeSummary(client, replyToken, items) {
  const rows = items.map(([, v]) => {
    const diffColor = v.diff === 0 ? '#388E3C' : (v.diff > 0 ? '#1565C0' : '#e53935');
    const diffStr = v.diff === 0 ? '±0' : (v.diff > 0 ? `+${v.diff}` : String(v.diff));
    return {
      type: 'box',
      layout: 'horizontal',
      contents: [
        { type: 'text', text: v.name, size: 'xs', flex: 4, wrap: true },
        { type: 'text', text: String(v.systemStock), size: 'xs', flex: 2, align: 'center' },
        { type: 'text', text: String(v.actualStock), size: 'xs', flex: 2, align: 'center' },
        { type: 'text', text: diffStr, size: 'xs', flex: 2, align: 'center', color: diffColor, weight: 'bold' },
      ],
      margin: 'xs',
    };
  });

  const hasDiff = items.some(([, v]) => v.diff !== 0);

  const flex = {
    type: 'flex',
    altText: '棚卸しサマリー',
    contents: {
      type: 'bubble',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: '#1B5E20',
        contents: [{ type: 'text', text: '📋 棚卸しサマリー', color: '#ffffff', weight: 'bold', size: 'md' }],
        paddingAll: '12px',
      },
      body: {
        type: 'box',
        layout: 'vertical',
        contents: [
          {
            type: 'box', layout: 'horizontal',
            contents: [
              { type: 'text', text: '品目', size: 'xs', color: '#888', flex: 4, weight: 'bold' },
              { type: 'text', text: '帳簿', size: 'xs', color: '#888', flex: 2, align: 'center', weight: 'bold' },
              { type: 'text', text: '実地', size: 'xs', color: '#888', flex: 2, align: 'center', weight: 'bold' },
              { type: 'text', text: '差異', size: 'xs', color: '#888', flex: 2, align: 'center', weight: 'bold' },
            ],
          },
          { type: 'separator', margin: 'sm' },
          ...rows,
          { type: 'separator', margin: 'sm' },
          {
            type: 'text',
            text: hasDiff ? '⚠️ 差異があります。在庫を実地に合わせて反映しますか？' : '✅ 差異はありません。',
            size: 'xs',
            wrap: true,
            margin: 'sm',
            color: hasDiff ? '#e53935' : '#388E3C',
          },
        ],
        paddingAll: '12px',
      },
      footer: {
        type: 'box',
        layout: 'horizontal',
        spacing: 'sm',
        contents: [
          {
            type: 'button',
            action: { type: 'postback', label: '✅ 反映する', data: 'action=stocktake_apply' },
            style: 'primary',
            color: '#1B5E20',
          },
          {
            type: 'button',
            action: { type: 'postback', label: '❌ キャンセル', data: 'action=stocktake_cancel' },
            style: 'secondary',
          },
        ],
        paddingAll: '12px',
      },
    },
  };

  return client.replyMessage({ replyToken, messages: [flex] });
}

/** 棚卸し反映: DB一括更新 + 調整履歴保存 */
async function applyStocktake(client, replyToken, userId) {
  const sess = getSession(userId);
  if (!sess || sess.type !== 'stocktake') {
    return client.replyMessage({ replyToken, messages: [{ type: 'text', text: 'セッションが切れました。もう一度「棚卸し開始」から行ってください。' }] });
  }

  const db = getDb();
  const entered = Object.entries(sess.items).filter(([, v]) => v.actualStock !== null);

  // トランザクション（manual BEGIN/COMMIT）
  db.exec('BEGIN');
  try {
    for (const [productId, item] of entered) {
      db.prepare("UPDATE products SET stock = ?, updated_at = datetime('now','localtime') WHERE id = ?")
        .run(item.actualStock, Number(productId));

      db.prepare(`INSERT INTO inventory_adjustments
        (product_id, product_name, system_stock, actual_stock, diff, adjuster_line_id)
        VALUES (?, ?, ?, ?, ?, ?)`)
        .run(Number(productId), item.name, item.systemStock, item.actualStock, item.diff, userId);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    clearSession(userId);
    return client.replyMessage({ replyToken, messages: [{ type: 'text', text: `❌ 反映中にエラーが発生しました: ${err.message}` }] });
  }

  clearSession(userId);

  // Sheets 追記・在庫同期（非同期）
  sheets.runAsync(sheets.appendStocktake, entered.map(([, v]) => v));
  for (const [productId] of entered) {
    sheets.runAsync(sheets.syncInventory, Number(productId));
  }

  const diffItems = entered.filter(([, v]) => v.diff !== 0);
  const summary = diffItems.length === 0
    ? '差異なし — 在庫に変更はありませんでした。'
    : diffItems.map(([, v]) => `  • ${v.name}: ${v.systemStock} → ${v.actualStock}（差異: ${v.diff > 0 ? '+' : ''}${v.diff}）`).join('\n');

  return client.replyMessage({ replyToken, messages: [{
    type: 'text',
    text: `✅ 棚卸しを反映しました。\n\n${summary}`,
  }]});
}

/** 棚卸しキャンセル */
async function cancelStocktake(client, replyToken, userId) {
  clearSession(userId);
  return client.replyMessage({ replyToken, messages: [{ type: 'text', text: '棚卸しをキャンセルしました。' }] });
}

/** 棚卸し履歴: 最新10件 */
async function showStocktakeHistory(client, replyToken) {
  const db = getDb();
  const rows = db.prepare(`
    SELECT adjusted_at, product_name, system_stock, actual_stock, diff
    FROM inventory_adjustments
    ORDER BY adjusted_at DESC LIMIT 10
  `).all();

  if (!rows.length) {
    return client.replyMessage({ replyToken, messages: [{ type: 'text', text: '棚卸し履歴はまだありません。' }] });
  }

  const lines = rows.map(r => {
    const diffStr = r.diff === 0 ? '±0' : (r.diff > 0 ? `+${r.diff}` : String(r.diff));
    const date = r.adjusted_at.slice(0, 10);
    return `${date} ${r.product_name}: ${r.system_stock}→${r.actual_stock}（${diffStr}）`;
  }).join('\n');

  return client.replyMessage({ replyToken, messages: [{ type: 'text', text: `📊 棚卸し履歴（直近10件）\n\n${lines}` }] });
}

module.exports = {
  startStocktake,
  inputStocktakeItem,
  finishStocktake,
  finishStocktakeForce,
  applyStocktake,
  cancelStocktake,
  showStocktakeHistory,
};
