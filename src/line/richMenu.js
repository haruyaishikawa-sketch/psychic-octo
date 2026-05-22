'use strict';

const https = require('https');
const zlib  = require('zlib');

/** リッチメニューの識別名（重複登録チェックに使用） */
const MENU_NAME = '材木店管理メニュー_v2';

// ────────────────────────────────────────────────────────────────
// PNG エンコーダー（外部ライブラリ不要・Node.js built-in のみ）
// ────────────────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const tb = Buffer.from(type, 'ascii');
  const lb = Buffer.allocUnsafe(4); lb.writeUInt32BE(data.length);
  const cb = Buffer.allocUnsafe(4); cb.writeUInt32BE(crc32(Buffer.concat([tb, data])));
  return Buffer.concat([lb, tb, data, cb]);
}

function encodePng(width, height, rgbBuf) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  const ihdrData = Buffer.allocUnsafe(13);
  ihdrData.writeUInt32BE(width,  0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8; ihdrData[9] = 2; // 8-bit RGB
  ihdrData[10] = 0; ihdrData[11] = 0; ihdrData[12] = 0;

  // 各行: filter byte(0) + RGB pixels
  const rowLen = 1 + width * 3;
  const raw = Buffer.allocUnsafe(height * rowLen);
  for (let y = 0; y < height; y++) {
    raw[y * rowLen] = 0;
    rgbBuf.copy(raw, y * rowLen + 1, y * width * 3, (y + 1) * width * 3);
  }

  const compressed = zlib.deflateSync(raw, { level: 6 });
  return Buffer.concat([sig, pngChunk('IHDR', ihdrData), pngChunk('IDAT', compressed), pngChunk('IEND', Buffer.alloc(0))]);
}

// ────────────────────────────────────────────────────────────────
// PNG ピクセル描画ヘルパー
// ────────────────────────────────────────────────────────────────

function fillRect(buf, W, H, x0, y0, w, h, r, g, b) {
  for (let y = y0; y < y0 + h; y++) {
    if (y < 0 || y >= H) continue;
    for (let x = x0; x < x0 + w; x++) {
      if (x < 0 || x >= W) continue;
      const i = (y * W + x) * 3;
      buf[i] = r; buf[i + 1] = g; buf[i + 2] = b;
    }
  }
}

function fillCircle(buf, W, H, cx, cy, radius, r, g, b) {
  const r2 = radius * radius;
  for (let y = cy - radius; y <= cy + radius; y++) {
    if (y < 0 || y >= H) continue;
    for (let x = cx - radius; x <= cx + radius; x++) {
      if (x < 0 || x >= W) continue;
      if ((x - cx) ** 2 + (y - cy) ** 2 <= r2) {
        const i = (y * W + x) * 3;
        buf[i] = r; buf[i + 1] = g; buf[i + 2] = b;
      }
    }
  }
}

function fillRing(buf, W, H, cx, cy, outerR, innerR, r, g, b) {
  const r1sq = innerR * innerR, r2sq = outerR * outerR;
  for (let y = cy - outerR; y <= cy + outerR; y++) {
    if (y < 0 || y >= H) continue;
    for (let x = cx - outerR; x <= cx + outerR; x++) {
      if (x < 0 || x >= W) continue;
      const d2 = (x - cx) ** 2 + (y - cy) ** 2;
      if (d2 >= r1sq && d2 <= r2sq) {
        const i = (y * W + x) * 3;
        buf[i] = r; buf[i + 1] = g; buf[i + 2] = b;
      }
    }
  }
}

/** 上向き三角（▲）*/
function fillTriUp(buf, W, H, cx, topY, botY, halfBase, r, g, b) {
  const height = botY - topY;
  for (let y = topY; y <= botY; y++) {
    if (y < 0 || y >= H) continue;
    const t = (y - topY) / height;
    const xL = Math.round(cx - halfBase * t);
    const xR = Math.round(cx + halfBase * t);
    for (let x = xL; x <= xR; x++) {
      if (x < 0 || x >= W) continue;
      const i = (y * W + x) * 3;
      buf[i] = r; buf[i + 1] = g; buf[i + 2] = b;
    }
  }
}

/** 下向き三角（▼）*/
function fillTriDown(buf, W, H, cx, topY, botY, halfBase, r, g, b) {
  const height = botY - topY;
  for (let y = topY; y <= botY; y++) {
    if (y < 0 || y >= H) continue;
    const t = (botY - y) / height;
    const xL = Math.round(cx - halfBase * t);
    const xR = Math.round(cx + halfBase * t);
    for (let x = xL; x <= xR; x++) {
      if (x < 0 || x >= W) continue;
      const i = (y * W + x) * 3;
      buf[i] = r; buf[i + 1] = g; buf[i + 2] = b;
    }
  }
}

/** 半円弧（topY ≤ y ≤ cy の上半分のみ）*/
function fillSemiCircleTop(buf, W, H, cx, cy, outerR, innerR, r, g, b) {
  const r1sq = innerR * innerR, r2sq = outerR * outerR;
  for (let y = cy - outerR; y <= cy; y++) {
    if (y < 0 || y >= H) continue;
    for (let x = cx - outerR; x <= cx + outerR; x++) {
      if (x < 0 || x >= W) continue;
      const d2 = (x - cx) ** 2 + (y - cy) ** 2;
      if (d2 >= r1sq && d2 <= r2sq) {
        const i = (y * W + x) * 3;
        buf[i] = r; buf[i + 1] = g; buf[i + 2] = b;
      }
    }
  }
}

// ────────────────────────────────────────────────────────────────
// 各セルのアイコン描画
// ────────────────────────────────────────────────────────────────

/** 📦 在庫確認: 3×3 グリッド */
function drawIconGrid(buf, W, H, cx, cy) {
  const S = 68, G = 22; // square size, gap
  const total = 3 * S + 2 * G;
  const ox = cx - Math.floor(total / 2);
  const oy = cy - Math.floor(total / 2);
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) {
      fillRect(buf, W, H, ox + col * (S + G), oy + row * (S + G), S, S, 255, 255, 255);
    }
  }
}

/** 📋 発注確認: 3本の横線（リスト） */
function drawIconList(buf, W, H, cx, cy) {
  const bW = 240, bH = 52, gap = 38;
  const totalH = 3 * bH + 2 * gap;
  const ox = cx - Math.floor(bW / 2);
  const oy = cy - Math.floor(totalH / 2);
  for (let i = 0; i < 3; i++) {
    fillRect(buf, W, H, ox, oy + i * (bH + gap), bW, bH, 255, 255, 255);
  }
}

/** 🧾 未払い確認: ¥マーク（矩形組み合わせ） */
function drawIconYen(buf, W, H, cx, cy) {
  const wr = 255, wg = 255, wb = 255;
  const thick = 38;
  // 縦棒（下半分）
  fillRect(buf, W, H, cx - thick / 2, cy - 30, thick, 200, wr, wg, wb);
  // 横棒 2本
  fillRect(buf, W, H, cx - 110, cy - 30, 220, thick, wr, wg, wb);
  fillRect(buf, W, H, cx - 110, cy + 20, 220, thick, wr, wg, wb);
  // V字（左斜め: 左上→中央下） - 階段近似 (8段)
  const vSegs = 8;
  const segH = 28;
  for (let s = 0; s < vSegs; s++) {
    const sx = cx - 120 + Math.round(s * (120 / vSegs));
    const sy = cy - 30 - (vSegs - s) * segH;
    fillRect(buf, W, H, sx, sy, Math.ceil(120 / vSegs) + 4, segH + 4, wr, wg, wb);
  }
  // V字（右斜め: 右上→中央下）
  for (let s = 0; s < vSegs; s++) {
    const sx = cx + Math.round(s * (120 / vSegs));
    const sy = cy - 30 - s * segH;
    fillRect(buf, W, H, sx, sy, Math.ceil(120 / vSegs) + 4, segH + 4, wr, wg, wb);
  }
}

/** ⬆️ 入庫: 上向き矢印 */
function drawIconArrowUp(buf, W, H, cx, cy) {
  // 三角
  fillTriUp(buf, W, H, cx, cy - 220, cy - 10, 170, 255, 255, 255);
  // 軸
  fillRect(buf, W, H, cx - 60, cy - 10, 120, 210, 255, 255, 255);
}

/** ⬇️ 出庫: 下向き矢印 */
function drawIconArrowDown(buf, W, H, cx, cy) {
  // 軸
  fillRect(buf, W, H, cx - 60, cy - 200, 120, 210, 255, 255, 255);
  // 三角
  fillTriDown(buf, W, H, cx, cy + 10, cy + 220, 170, 255, 255, 255);
}

/** ❓ ヘルプ: ？マーク */
function drawIconHelp(buf, W, H, cx, cy) {
  const wr = 255, wg = 255, wb = 255;
  // 上部の弧（半円リング）
  fillSemiCircleTop(buf, W, H, cx, cy - 60, 130, 90, wr, wg, wb);
  // 右側の縦棒（弧の右端から下へ）
  fillRect(buf, W, H, cx + 82, cy - 60, 48, 100, wr, wg, wb);
  // 中央の縦棒
  fillRect(buf, W, H, cx - 24, cy + 30, 48, 100, wr, wg, wb);
  // ドット
  fillCircle(buf, W, H, cx, cy + 200, 38, wr, wg, wb);
}

/**
 * リッチメニュー用 PNG 画像を生成する（2500×1686, 2行×3列）
 * ボタンごとに異なる背景色とアイコンを描画
 */
function buildMenuPng() {
  const W = 2500, H = 1686;
  const COL_X = [0, 833, 1666];
  const COL_W = [833, 833, 834];
  const ROW_Y = [0, 843];
  const ROW_H = [843, 843];
  const BORDER = 6;

  // 各ボタンの背景色（指定通り）
  const CELLS = [
    { r: 0x1B, g: 0x3A, b: 0x2D, icon: drawIconGrid      }, // #1B3A2D 在庫確認（濃緑）
    { r: 0x2C, g: 0x5F, b: 0x2D, icon: drawIconList      }, // #2C5F2D 発注確認（中緑）
    { r: 0xD9, g: 0x77, b: 0x06, icon: drawIconYen       }, // #D97706 未払い確認（オレンジ）
    { r: 0x1D, g: 0x4E, b: 0xD8, icon: drawIconArrowUp   }, // #1D4ED8 入庫（青）
    { r: 0xDC, g: 0x26, b: 0x26, icon: drawIconArrowDown }, // #DC2626 出庫（赤）
    { r: 0x64, g: 0x74, b: 0x8B, icon: drawIconHelp      }, // #64748B ヘルプ（グレー）
  ];

  const buf = Buffer.alloc(W * H * 3, 255); // 白背景

  for (let row = 0; row < 2; row++) {
    for (let col = 0; col < 3; col++) {
      const cell = CELLS[row * 3 + col];
      const x0 = COL_X[col] + BORDER, cellW = COL_W[col] - BORDER * 2;
      const y0 = ROW_Y[row] + BORDER, cellH = ROW_H[row] - BORDER * 2;

      // 背景色で塗りつぶし
      fillRect(buf, W, H, x0, y0, cellW, cellH, cell.r, cell.g, cell.b);

      // アイコン描画（セル中央より少し上）
      const cx = x0 + Math.floor(cellW / 2);
      const cy = y0 + Math.floor(cellH / 2) - 40;
      cell.icon(buf, W, H, cx, cy);
    }
  }

  return encodePng(W, H, buf);
}

// ────────────────────────────────────────────────────────────────
// LINE API ヘルパー
// ────────────────────────────────────────────────────────────────

function lineApiReq(token, method, path, body, host = 'api.line.me', contentType = 'application/json') {
  return new Promise((resolve, reject) => {
    const bodyBuf = Buffer.isBuffer(body) ? body : (body ? Buffer.from(JSON.stringify(body)) : Buffer.alloc(0));
    const options = {
      hostname: host,
      path,
      method,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': contentType,
        'Content-Length': bodyBuf.length,
      },
    };
    const req = https.request(options, res => {
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString();
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch { resolve({ status: res.statusCode, body: raw }); }
      });
    });
    req.on('error', reject);
    if (bodyBuf.length) req.write(bodyBuf);
    req.end();
  });
}

// ────────────────────────────────────────────────────────────────
// リッチメニュー 構造定義
// ────────────────────────────────────────────────────────────────

function buildMenuJson() {
  const areas = [
    // 上段
    { x: 0,    y: 0,   w: 833, h: 843, label: '📦 在庫確認', action: { type: 'message', text: '在庫確認' } },
    { x: 833,  y: 0,   w: 833, h: 843, label: '📋 発注確認', action: { type: 'message', text: '発注確認' } },
    { x: 1666, y: 0,   w: 834, h: 843, label: '🧾 未払い確認', action: { type: 'message', text: '未払い確認' } },
    // 下段
    { x: 0,    y: 843, w: 833, h: 843, label: '⬆️ 入庫',    action: { type: 'postback', data: 'action=stockin_guide', displayText: '入庫' } },
    { x: 833,  y: 843, w: 833, h: 843, label: '⬇️ 出庫',    action: { type: 'postback', data: 'action=stockout_start', displayText: '出庫' } },
    { x: 1666, y: 843, w: 834, h: 843, label: '📊 ヘルプ',  action: { type: 'message', text: 'ヘルプ' } },
  ];

  return {
    size: { width: 2500, height: 1686 },
    selected: true,
    name: MENU_NAME,
    chatBarText: '操作メニュー',
    areas: areas.map(a => ({
      bounds: { x: a.x, y: a.y, width: a.w, height: a.h },
      action: a.action,
    })),
  };
}

// ────────────────────────────────────────────────────────────────
// 登録・削除 API
// ────────────────────────────────────────────────────────────────

async function getExistingMenuId(token) {
  const res = await lineApiReq(token, 'GET', '/v2/bot/richmenu/list', null);
  if (res.status !== 200 || !Array.isArray(res.body.richmenus)) return null;
  const found = res.body.richmenus.find(m => m.name === MENU_NAME);
  return found ? found.richMenuId : null;
}

async function registerRichMenu(token) {
  if (!token || token === 'DUMMY_TOKEN') {
    console.log('[RichMenu] トークン未設定 — スキップ');
    return null;
  }

  try {
    // 重複チェック
    const existingId = await getExistingMenuId(token);
    if (existingId) {
      console.log('[RichMenu] 既存メニュー検出:', existingId, '— スキップ');
      // デフォルトに設定されているか確認して設定
      await lineApiReq(token, 'POST', `/v2/bot/user/all/richmenu/${existingId}`, null);
      return existingId;
    }

    // 1. メニュー構造を作成
    const createRes = await lineApiReq(token, 'POST', '/v2/bot/richmenu', buildMenuJson());
    if (createRes.status !== 200) throw new Error(`メニュー作成失敗: ${JSON.stringify(createRes.body)}`);
    const richMenuId = createRes.body.richMenuId;
    console.log('[RichMenu] メニュー作成:', richMenuId);

    // 2. 画像をアップロード
    const pngBuf = buildMenuPng();
    const imgRes = await lineApiReq(token, 'POST', `/v2/bot/richmenu/${richMenuId}/content`, pngBuf, 'api-data.line.me', 'image/png');
    if (imgRes.status !== 200) throw new Error(`画像アップロード失敗: ${JSON.stringify(imgRes.body)}`);
    console.log('[RichMenu] 画像アップロード完了 (', pngBuf.length, 'bytes)');

    // 3. デフォルトメニューとして設定
    const defaultRes = await lineApiReq(token, 'POST', `/v2/bot/user/all/richmenu/${richMenuId}`, null);
    if (defaultRes.status !== 200) throw new Error(`デフォルト設定失敗: ${JSON.stringify(defaultRes.body)}`);

    console.log('[RichMenu] ✅ リッチメニューを登録・設定しました:', richMenuId);
    return richMenuId;
  } catch (err) {
    console.error('[RichMenu] ❌ 登録エラー:', err.message);
    return null; // サーバー起動は続行する
  }
}

/** リッチメニューを削除（手動リセット用） */
async function deleteRichMenu(token) {
  const existingId = await getExistingMenuId(token);
  if (!existingId) { console.log('[RichMenu] 削除対象なし'); return; }
  // デフォルト解除
  await lineApiReq(token, 'DELETE', `/v2/bot/user/all/richmenu`, null);
  // メニュー削除
  const res = await lineApiReq(token, 'DELETE', `/v2/bot/richmenu/${existingId}`, null);
  console.log('[RichMenu] 削除:', existingId, res.status);
}

module.exports = { registerRichMenu, deleteRichMenu, buildMenuPng };
