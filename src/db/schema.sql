-- 品目（在庫）テーブル
CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  spec TEXT NOT NULL,
  unit_price INTEGER NOT NULL,
  stock INTEGER NOT NULL DEFAULT 0,
  reorder_point INTEGER NOT NULL DEFAULT 0,
  unit TEXT NOT NULL DEFAULT '枚',
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);

-- 仕入先テーブル
CREATE TABLE IF NOT EXISTS suppliers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_name TEXT NOT NULL,
  contact_person TEXT,
  phone TEXT,
  email TEXT,
  line_user_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);

-- 顧客テーブル（discount_rate: 掛け率 例 0.8 = 20%引き）
CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_name TEXT NOT NULL,
  contact_person TEXT,
  phone TEXT,
  email TEXT,
  line_user_id TEXT,
  discount_rate REAL NOT NULL DEFAULT 1.0,
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);

-- 発注テーブル
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL,
  product_name TEXT NOT NULL,
  quantity INTEGER NOT NULL,
  supplier_id INTEGER,
  supplier_name TEXT,
  status TEXT NOT NULL DEFAULT 'pending',  -- pending / approved / rejected / inspected / inspection_ng
  requested_by TEXT,
  approved_by TEXT,
  inspection_status TEXT DEFAULT '未検収',
  inspected_at TEXT,
  inspection_memo TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  FOREIGN KEY (product_id) REFERENCES products(id),
  FOREIGN KEY (supplier_id) REFERENCES suppliers(id)
);

-- 請求書テーブル
CREATE TABLE IF NOT EXISTS invoices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_number TEXT UNIQUE,              -- INV-YYYYMMDD-001
  customer_id INTEGER NOT NULL,
  customer_name TEXT NOT NULL,
  billing_month TEXT NOT NULL,
  items TEXT NOT NULL,
  subtotal INTEGER NOT NULL DEFAULT 0,
  tax_amount INTEGER NOT NULL DEFAULT 0,
  discount_rate REAL NOT NULL DEFAULT 1.0,
  total_amount INTEGER NOT NULL,
  due_date TEXT,                           -- 支払期限
  status TEXT NOT NULL DEFAULT 'unpaid',  -- unpaid / paid
  pdf_path TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  FOREIGN KEY (customer_id) REFERENCES customers(id)
);

-- 見積書テーブル
CREATE TABLE IF NOT EXISTS quotes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL,
  customer_name TEXT NOT NULL,
  items TEXT NOT NULL,          -- JSON [{product_name, quantity, unit_price, discounted_price, amount}]
  subtotal INTEGER NOT NULL,
  discount_rate REAL NOT NULL DEFAULT 1.0,
  total_amount INTEGER NOT NULL,
  tax_amount INTEGER NOT NULL DEFAULT 0,
  grand_total INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',  -- draft / sent / accepted / rejected
  valid_until TEXT,
  pdf_path TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  FOREIGN KEY (customer_id) REFERENCES customers(id)
);

-- 棚卸し調整履歴テーブル
CREATE TABLE IF NOT EXISTS inventory_adjustments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  adjusted_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  product_id INTEGER NOT NULL,
  product_name TEXT NOT NULL,
  system_stock INTEGER NOT NULL,
  actual_stock INTEGER NOT NULL,
  diff INTEGER NOT NULL,
  adjuster_line_id TEXT,
  FOREIGN KEY (product_id) REFERENCES products(id)
);

-- 受注管理テーブル
CREATE TABLE IF NOT EXISTS received_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_number TEXT UNIQUE NOT NULL,
  customer_id INTEGER,
  customer_name TEXT NOT NULL,
  items TEXT NOT NULL DEFAULT '[]',
  total_amount INTEGER DEFAULT 0,
  status TEXT NOT NULL DEFAULT '受注済',
  notes TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now','localtime')),
  updated_at TEXT DEFAULT (datetime('now','localtime'))
);

-- 配送管理テーブル
CREATE TABLE IF NOT EXISTS deliveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  received_order_id INTEGER,
  order_number TEXT,
  delivery_date TEXT NOT NULL,
  time_slot TEXT DEFAULT '指定なし',
  customer_name TEXT NOT NULL,
  address TEXT DEFAULT '',
  driver_memo TEXT DEFAULT '',
  status TEXT DEFAULT '予定',
  created_at TEXT DEFAULT (datetime('now','localtime')),
  updated_at TEXT DEFAULT (datetime('now','localtime'))
);

-- 納品書テーブル
CREATE TABLE IF NOT EXISTS delivery_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL,
  customer_name TEXT NOT NULL,
  items TEXT NOT NULL,          -- JSON [{product_name, quantity, unit_price, amount}]
  total_amount INTEGER NOT NULL,
  delivered_at TEXT,
  pdf_path TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  FOREIGN KEY (customer_id) REFERENCES customers(id)
);
