'use strict';

/**
 * ユーザーごとのセッション管理（インメモリ）
 *
 * セッション種別:
 *   stocktake: 棚卸しモード
 *     { type:'stocktake', step:'in_progress',
 *       items: { [productId]: { name, unit, systemStock, actualStock, diff } } }
 *
 *   stockout: 出庫ステップフロー
 *     { type:'stockout', step:'select_product'|'input_quantity'|'confirm',
 *       product: { id, name, unit, stock }, quantity: Number|null }
 */

const sessions = new Map(); // userId → session object
const SESSION_TTL_MS = 30 * 60 * 1000; // 30分で自動クリア

// 期限切れセッションを定期削除（5分ごと）
setInterval(() => {
  const now = Date.now();
  for (const [uid, sess] of sessions) {
    if (now - sess._updatedAt > SESSION_TTL_MS) sessions.delete(uid);
  }
}, 5 * 60 * 1000);

function getSession(userId) {
  const s = sessions.get(userId);
  if (!s) return null;
  if (Date.now() - s._updatedAt > SESSION_TTL_MS) {
    sessions.delete(userId);
    return null;
  }
  return s;
}

function setSession(userId, data) {
  sessions.set(userId, { ...data, _updatedAt: Date.now() });
}

function clearSession(userId) {
  sessions.delete(userId);
}

function hasSession(userId) {
  return getSession(userId) !== null;
}

module.exports = { getSession, setSession, clearSession, hasSession };
