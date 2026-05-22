'use strict';

/**
 * 材積計算ハンドラー
 * 縦(mm) × 横(mm) × 長さ(mm) × 本数 を計算し、m³と才を返す
 *
 * 才(さい)とは: 1才 = 1寸×1寸×12尺 = 30.303mm × 30.303mm × 3636mm ≈ 0.001 m³
 * 製材業界では 1才 = 0.001 m³ として扱う慣習が多い
 * 本実装では 1才 = 30.3 × 30.3 × 363.6 mm³ (1寸×1寸×1尺 = 1/1000 m³) で計算
 */

// 1才 = 1寸 × 1寸 × 12尺 = (30.303mm)² × 3636.36mm
const MM3_PER_SAI = 30.303 * 30.303 * 3636.36; // ≈ 3,339,292 mm³ = 0.003339 m³
// より実務的な定義: 1才 = 0.001 m³（業界慣習）
// ここでは正確な寸法定義を使用
const MM3_PER_M3 = 1_000_000_000; // 1m³ = 10³mm³

/**
 * 1本あたりの材積を計算する
 * @param {number} width_mm  - 縦 (mm)
 * @param {number} height_mm - 横 (mm)
 * @param {number} length_mm - 長さ (mm)
 * @returns {{ m3: number, sai: number }}
 */
function calcVolume(width_mm, height_mm, length_mm) {
  const vol_mm3 = width_mm * height_mm * length_mm;
  const m3 = vol_mm3 / MM3_PER_M3;
  const sai = vol_mm3 / MM3_PER_SAI;
  return { m3, sai };
}

/**
 * m → mm 変換（入力が m 単位の場合）
 * 例: 0.105 → 105
 */
function parseDimension(val) {
  const n = parseFloat(val);
  if (isNaN(n) || n <= 0) return null;
  // 10以下は m 単位とみなして mm に変換
  return n <= 10 ? Math.round(n * 1000) : n;
}

async function handleCalc(client, replyToken, args) {
  // args: ["105", "105", "3000"] or ["105", "105", "3000", "10"]
  // or ["105×105×3000"] or ["105×105×3000", "10本"]
  let width, height, length, count;

  // 「105×105×3000」形式
  const joinedArgs = args.join(' ');
  const crossMatch = joinedArgs.match(/^(\d+(?:\.\d+)?)[×xX×*](\d+(?:\.\d+)?)[×xX×*](\d+(?:\.\d+)?)(?:\s+(\d+))?/);
  if (crossMatch) {
    width  = parseDimension(crossMatch[1]);
    height = parseDimension(crossMatch[2]);
    length = parseDimension(crossMatch[3]);
    count  = crossMatch[4] ? parseInt(crossMatch[4], 10) : 1;
  } else if (args.length >= 3) {
    // 「105 105 3000 10」形式
    width  = parseDimension(args[0]);
    height = parseDimension(args[1]);
    length = parseDimension(args[2]);
    count  = args[3] ? parseInt(args[3], 10) : 1;
  } else {
    await client.replyMessage({
      replyToken,
      messages: [{ type: 'text', text: '使い方:\n材積 105 105 3000\n材積 105 105 3000 10本\n材積 105×105×3000 10\n\n単位はmmです（0.105 のように入力するとm換算）' }],
    });
    return;
  }

  if (!width || !height || !length || isNaN(count) || count < 1) {
    await client.replyMessage({
      replyToken,
      messages: [{ type: 'text', text: '寸法の入力が正しくありません。\n例: 材積 105 105 3000 10' }],
    });
    return;
  }

  const perPiece = calcVolume(width, height, length);
  const totalM3  = perPiece.m3  * count;
  const totalSai = perPiece.sai * count;

  // 金額換算参考（立米単価での計算例）
  const refPricePerM3 = 50000; // 参考: ¥50,000/m³
  const refTotal = Math.round(totalM3 * refPricePerM3);

  const message = {
    type: 'flex',
    altText: `材積計算結果: ${totalM3.toFixed(4)} m³`,
    contents: {
      type: 'bubble',
      header: {
        type: 'box',
        layout: 'vertical',
        contents: [
          { type: 'text', text: '📐 材積計算結果', weight: 'bold', color: '#FFFFFF', size: 'md' },
        ],
        backgroundColor: '#5D4037',
        paddingAll: 'md',
      },
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'md',
        contents: [
          // 入力寸法
          {
            type: 'box',
            layout: 'vertical',
            backgroundColor: '#F5F5F5',
            cornerRadius: 'md',
            paddingAll: 'sm',
            contents: [
              { type: 'text', text: '入力寸法', size: 'xs', color: '#888888', weight: 'bold' },
              {
                type: 'text',
                text: `${width} × ${height} × ${length} mm  ×  ${count}本`,
                size: 'md',
                weight: 'bold',
                color: '#333333',
                margin: 'xs',
                wrap: true,
              },
            ],
          },
          { type: 'separator' },
          // 1本あたり
          {
            type: 'box',
            layout: 'vertical',
            spacing: 'xs',
            contents: [
              { type: 'text', text: '▍1本あたり', size: 'sm', color: '#5D4037', weight: 'bold' },
              row('材積 (m³)',    `${perPiece.m3.toFixed(5)} m³`),
              row('材積 (才)',    `${perPiece.sai.toFixed(3)} 才`),
            ],
          },
          { type: 'separator' },
          // 合計
          {
            type: 'box',
            layout: 'vertical',
            spacing: 'xs',
            contents: [
              { type: 'text', text: `▍合計（${count}本）`, size: 'sm', color: '#5D4037', weight: 'bold' },
              row('合計材積 (m³)', `${totalM3.toFixed(4)} m³`, true),
              row('合計材積 (才)', `${totalSai.toFixed(2)} 才`, true),
            ],
          },
          { type: 'separator' },
          // 金額参考
          {
            type: 'box',
            layout: 'vertical',
            contents: [
              {
                type: 'text',
                text: `参考金額: ¥${refTotal.toLocaleString()}（¥${refPricePerM3.toLocaleString()}/m³ 換算）`,
                size: 'xs',
                color: '#888888',
                wrap: true,
              },
            ],
          },
        ],
        paddingAll: 'md',
      },
    },
  };

  await client.replyMessage({ replyToken, messages: [message] });
}

function row(label, value, bold = false) {
  return {
    type: 'box',
    layout: 'horizontal',
    contents: [
      { type: 'text', text: label, size: 'sm', color: '#555555', flex: 4 },
      { type: 'text', text: value, size: 'sm', color: '#222222', flex: 4, align: 'end', weight: bold ? 'bold' : 'regular' },
    ],
  };
}

module.exports = { handleCalc, calcVolume };
