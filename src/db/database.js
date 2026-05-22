'use strict';

const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, '../../lumber.db');
const SCHEMA_PATH = path.join(__dirname, 'schema.sql');

let db;

function getDb() {
  if (!db) {
    db = new DatabaseSync(DB_PATH);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA foreign_keys = ON');
    initSchema();
    seedData();
  }
  return db;
}

function initSchema() {
  const schema = fs.readFileSync(SCHEMA_PATH, 'utf8');
  db.exec(schema);
}

function seedData() {
  const count = db.prepare('SELECT COUNT(*) as cnt FROM products').get();
  if (count.cnt > 0) return;

  // 品目初期データ
  const insertProduct = db.prepare(`
    INSERT INTO products (name, spec, unit_price, stock, reorder_point, unit)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  db.exec('BEGIN');
  try {
    for (const item of [
      ['杉板',   '2×4',     350,  150, 50, '枚'],
      ['檜角材', '105×105', 2800,  80, 20, '本'],
      ['合板',   '12mm',   1200,  200, 30, '枚'],
      ['垂木',   '45×45',   180,   25, 40, '本'],  // 在庫アラート状態
    ]) insertProduct.run(...item);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }

  // 仕入先
  const ins = db.prepare(`INSERT INTO suppliers (company_name, contact_person, phone, line_user_id) VALUES (?, ?, ?, ?)`);
  ins.run('山田製材所',     '山田太郎', '03-1234-5678', '');
  ins.run('木曽木材株式会社', '木曽次郎', '052-9876-5432', '');

  // 顧客（掛け率付き）
  const insc = db.prepare(`INSERT INTO customers (company_name, contact_person, phone, line_user_id, discount_rate) VALUES (?, ?, ?, ?, ?)`);
  insc.run('田中建設',   '田中一郎', '06-1111-2222', '', 0.85);  // 15%引き
  insc.run('鈴木工務店', '鈴木二郎', '045-3333-4444', '', 0.90); // 10%引き

  // サンプル発注
  const inso = db.prepare(`INSERT INTO orders (product_id, product_name, quantity, supplier_id, supplier_name, status, requested_by) VALUES (?, ?, ?, ?, ?, ?, ?)`);
  inso.run(1, '杉板 2×4',   200, 1, '山田製材所', 'pending', 'LINE管理者');
  inso.run(4, '垂木 45×45', 100, 1, '山田製材所', 'pending', 'LINE管理者');

  // サンプル請求書
  const insInv = db.prepare(`INSERT INTO invoices
    (invoice_number, customer_id, customer_name, billing_month,
     items, subtotal, tax_amount, discount_rate, total_amount, due_date, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const items1 = JSON.stringify([
    { product_name: '杉板 2×4',      quantity: 50, unit: '枚', unit_price: 298,  amount: 14875 },
    { product_name: '合板 12mm',     quantity: 10, unit: '枚', unit_price: 1020, amount: 10200 },
  ]);
  const tax1 = Math.floor(25075 * 0.1);
  insInv.run('INV-20241130-001', 1, '田中建設', '2024-11', items1, 25075, tax1, 0.85, 25075 + tax1, '2024-12-31', 'unpaid');

  const items2 = JSON.stringify([
    { product_name: '檜角材 105×105', quantity: 5, unit: '本', unit_price: 2520, amount: 12600 },
  ]);
  const tax2 = Math.floor(12600 * 0.1);
  insInv.run('INV-20241130-002', 2, '鈴木工務店', '2024-11', items2, 12600, tax2, 0.90, 12600 + tax2, '2024-12-31', 'paid');

  // サンプル見積書
  const insQ = db.prepare(`INSERT INTO quotes (customer_id, customer_name, items, subtotal, discount_rate, total_amount, tax_amount, grand_total, status, valid_until) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const qItems = JSON.stringify([
    { product_name: '杉板 2×4', quantity: 100, unit_price: 350, discounted_price: 298, amount: 29750 },
  ]);
  const qSubtotal = 29750;
  const qTax = Math.floor(qSubtotal * 0.1);
  insQ.run(1, '田中建設', qItems, qSubtotal, 0.85, qSubtotal, qTax, qSubtotal + qTax, 'draft', '2024-12-31');

  console.log('[DB] 初期データを投入しました');
}

module.exports = { getDb };
