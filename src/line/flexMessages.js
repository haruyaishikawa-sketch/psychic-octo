'use strict';

// 在庫一覧 Flex Message
function buildInventoryListFlex(products) {
  const rows = products.map((p) => {
    const isAlert = p.stock <= p.reorder_point;
    const stockText = `${p.stock}${p.unit}`;
    const alertMark = isAlert ? ' ⚠️' : '';
    return {
      type: 'box',
      layout: 'horizontal',
      contents: [
        {
          type: 'text',
          text: `${p.name} ${p.spec}`,
          size: 'sm',
          color: isAlert ? '#E74C3C' : '#333333',
          flex: 5,
          wrap: true,
        },
        {
          type: 'text',
          text: `${stockText}${alertMark}`,
          size: 'sm',
          color: isAlert ? '#E74C3C' : '#555555',
          align: 'end',
          flex: 3,
        },
      ],
      margin: 'md',
    };
  });

  return {
    type: 'flex',
    altText: '在庫一覧',
    contents: {
      type: 'bubble',
      header: {
        type: 'box',
        layout: 'vertical',
        contents: [
          {
            type: 'text',
            text: '📦 在庫一覧',
            weight: 'bold',
            size: 'lg',
            color: '#FFFFFF',
          },
        ],
        backgroundColor: '#2C7A4B',
        paddingAll: 'md',
      },
      body: {
        type: 'box',
        layout: 'vertical',
        contents: [
          {
            type: 'box',
            layout: 'horizontal',
            contents: [
              { type: 'text', text: '品名・規格', size: 'xs', color: '#888888', flex: 5, weight: 'bold' },
              { type: 'text', text: '在庫', size: 'xs', color: '#888888', flex: 3, align: 'end', weight: 'bold' },
            ],
          },
          { type: 'separator', margin: 'sm' },
          ...rows,
          { type: 'separator', margin: 'md' },
          {
            type: 'text',
            text: '⚠️ 赤色は発注点以下の品目',
            size: 'xs',
            color: '#E74C3C',
            margin: 'md',
          },
        ],
        paddingAll: 'md',
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        contents: [
          {
            type: 'button',
            action: { type: 'message', label: '発注確認', text: '発注確認' },
            style: 'primary',
            color: '#2C7A4B',
            height: 'sm',
          },
        ],
        paddingAll: 'sm',
      },
    },
  };
}

// 特定品目の在庫詳細 Flex Message
function buildProductDetailFlex(product) {
  const isAlert = product.stock <= product.reorder_point;
  return {
    type: 'flex',
    altText: `${product.name} ${product.spec} の在庫情報`,
    contents: {
      type: 'bubble',
      header: {
        type: 'box',
        layout: 'vertical',
        contents: [
          { type: 'text', text: '📦 在庫情報', weight: 'bold', color: '#FFFFFF', size: 'md' },
        ],
        backgroundColor: isAlert ? '#C0392B' : '#2C7A4B',
        paddingAll: 'md',
      },
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'md',
        contents: [
          {
            type: 'text',
            text: `${product.name} ${product.spec}`,
            weight: 'bold',
            size: 'lg',
            wrap: true,
          },
          {
            type: 'box',
            layout: 'vertical',
            spacing: 'sm',
            contents: [
              buildLabelValue('在庫数', `${product.stock} ${product.unit}`),
              buildLabelValue('単価', `¥${product.unit_price.toLocaleString()}`),
              buildLabelValue('発注点', `${product.reorder_point} ${product.unit}`),
            ],
          },
          isAlert
            ? {
                type: 'text',
                text: '⚠️ 在庫が発注点を下回っています！',
                color: '#E74C3C',
                size: 'sm',
                wrap: true,
              }
            : { type: 'text', text: '✅ 在庫は適正水準です', color: '#27AE60', size: 'sm' },
        ],
        paddingAll: 'md',
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        contents: [
          {
            type: 'button',
            action: {
              type: 'message',
              label: '発注する',
              text: `発注 ${product.name} ${product.spec} 100${product.unit} 山田製材所`,
            },
            style: 'primary',
            color: '#2C7A4B',
            height: 'sm',
          },
        ],
        paddingAll: 'sm',
      },
    },
  };
}

// 発注一覧 Flex Message
function buildOrderListFlex(orders) {
  if (orders.length === 0) {
    return {
      type: 'text',
      text: '✅ 未承認の発注はありません。',
    };
  }

  const items = orders.map((o) => ({
    type: 'box',
    layout: 'vertical',
    spacing: 'sm',
    margin: 'md',
    paddingAll: 'sm',
    backgroundColor: '#F8F8F8',
    cornerRadius: 'md',
    contents: [
      {
        type: 'text',
        text: `#${o.id} ${o.product_name}`,
        weight: 'bold',
        size: 'sm',
        wrap: true,
      },
      {
        type: 'box',
        layout: 'horizontal',
        contents: [
          { type: 'text', text: `数量: ${o.quantity}`, size: 'xs', color: '#555555', flex: 3 },
          { type: 'text', text: `仕入先: ${o.supplier_name || '未定'}`, size: 'xs', color: '#555555', flex: 5 },
        ],
      },
      {
        type: 'box',
        layout: 'horizontal',
        spacing: 'sm',
        margin: 'sm',
        contents: [
          {
            type: 'button',
            action: { type: 'message', label: '✅ 承認', text: `承認 ${o.id}` },
            style: 'primary',
            color: '#27AE60',
            height: 'sm',
            flex: 1,
          },
          {
            type: 'button',
            action: { type: 'message', label: '❌ 却下', text: `却下 ${o.id}` },
            style: 'secondary',
            height: 'sm',
            flex: 1,
          },
        ],
      },
    ],
  }));

  return {
    type: 'flex',
    altText: '未承認発注一覧',
    contents: {
      type: 'bubble',
      header: {
        type: 'box',
        layout: 'vertical',
        contents: [
          { type: 'text', text: '📋 未承認発注一覧', weight: 'bold', color: '#FFFFFF', size: 'md' },
          { type: 'text', text: `${orders.length}件の発注が承認待ちです`, color: '#DDEEEE', size: 'xs', margin: 'sm' },
        ],
        backgroundColor: '#2980B9',
        paddingAll: 'md',
      },
      body: {
        type: 'box',
        layout: 'vertical',
        contents: items,
        paddingAll: 'md',
      },
    },
  };
}

// 発注作成確認 Flex Message
function buildOrderConfirmFlex(order) {
  return {
    type: 'flex',
    altText: '発注を受け付けました',
    contents: {
      type: 'bubble',
      header: {
        type: 'box',
        layout: 'vertical',
        contents: [
          { type: 'text', text: '📦 発注を受け付けました', weight: 'bold', color: '#FFFFFF', size: 'md' },
        ],
        backgroundColor: '#8E44AD',
        paddingAll: 'md',
      },
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        contents: [
          buildLabelValue('発注番号', `#${order.id}`),
          buildLabelValue('品名', order.product_name),
          buildLabelValue('数量', `${order.quantity}`),
          buildLabelValue('仕入先', order.supplier_name || '未定'),
          buildLabelValue('ステータス', '承認待ち'),
        ],
        paddingAll: 'md',
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        contents: [
          {
            type: 'text',
            text: '管理者に承認依頼を送信しました',
            size: 'xs',
            color: '#888888',
            align: 'center',
          },
        ],
        paddingAll: 'sm',
      },
    },
  };
}

// 未払い請求書一覧 Flex Message
function buildUnpaidInvoicesFlex(invoices) {
  if (invoices.length === 0) {
    return { type: 'text', text: '✅ 未払いの請求書はありません。' };
  }

  const items = invoices.map((inv) => ({
    type: 'box',
    layout: 'horizontal',
    margin: 'md',
    contents: [
      {
        type: 'box',
        layout: 'vertical',
        flex: 6,
        contents: [
          { type: 'text', text: inv.customer_name, weight: 'bold', size: 'sm', wrap: true },
          { type: 'text', text: `${inv.billing_month} 分`, size: 'xs', color: '#888888', margin: 'xs' },
        ],
      },
      {
        type: 'text',
        text: `¥${inv.total_amount.toLocaleString()}`,
        size: 'sm',
        color: '#E74C3C',
        align: 'end',
        flex: 4,
        weight: 'bold',
      },
    ],
  }));

  const totalAmount = invoices.reduce((sum, i) => sum + i.total_amount, 0);

  return {
    type: 'flex',
    altText: '未払い請求書一覧',
    contents: {
      type: 'bubble',
      header: {
        type: 'box',
        layout: 'vertical',
        contents: [
          { type: 'text', text: '💴 未払い請求書一覧', weight: 'bold', color: '#FFFFFF', size: 'md' },
          {
            type: 'text',
            text: `合計 ¥${totalAmount.toLocaleString()}`,
            color: '#FFDDDD',
            size: 'sm',
            margin: 'xs',
          },
        ],
        backgroundColor: '#E74C3C',
        paddingAll: 'md',
      },
      body: {
        type: 'box',
        layout: 'vertical',
        contents: [
          ...items,
          { type: 'separator', margin: 'md' },
          {
            type: 'text',
            text: `合計 ¥${totalAmount.toLocaleString()} (${invoices.length}件)`,
            weight: 'bold',
            size: 'sm',
            align: 'end',
            margin: 'md',
          },
        ],
        paddingAll: 'md',
      },
    },
  };
}

// ヘルプメニュー Flex Message
function buildHelpFlex() {
  const commands = [
    { label: '在庫確認',   text: '在庫確認',                    desc: '全品目の在庫一覧' },
    { label: '入庫',       text: '入庫 杉板2×4 100枚',          desc: '在庫を増やす' },
    { label: '出庫',       text: '出庫 杉板2×4 20枚',           desc: '在庫を減らす' },
    { label: '発注確認',   text: '発注確認',                    desc: '未承認の発注一覧' },
    { label: '見積書',     text: '見積書 田中建設 杉板2×4 50枚', desc: '見積書PDF生成' },
    { label: '納品書',     text: '納品書 田中建設 杉板2×4 30枚', desc: '納品書PDF生成' },
    { label: '未払い確認', text: '未払い確認',                  desc: '未払い請求書一覧' },
    { label: '材積計算',   text: '材積 105 105 3000 10',        desc: '縦×横×長さ(mm)×本数' },
    { label: '掛け率確認', text: '掛け率 田中建設',             desc: '顧客の掛け率を確認' },
  ];

  return {
    type: 'flex',
    altText: '操作メニュー',
    contents: {
      type: 'bubble',
      header: {
        type: 'box',
        layout: 'vertical',
        contents: [
          { type: 'text', text: '🌲 材木店管理システム', weight: 'bold', color: '#FFFFFF', size: 'md' },
          { type: 'text', text: '操作メニュー', color: '#CCEECC', size: 'xs', margin: 'xs' },
        ],
        backgroundColor: '#2C7A4B',
        paddingAll: 'md',
      },
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        contents: commands.map((c) => ({
          type: 'box',
          layout: 'horizontal',
          contents: [
            {
              type: 'button',
              action: { type: 'message', label: c.label, text: c.text },
              style: 'secondary',
              height: 'sm',
              flex: 2,
            },
            {
              type: 'text',
              text: c.desc,
              size: 'xs',
              color: '#555555',
              flex: 3,
              align: 'start',
              gravity: 'center',
              margin: 'md',
              wrap: true,
            },
          ],
          spacing: 'sm',
        })),
        paddingAll: 'md',
      },
    },
  };
}

// ユーティリティ: ラベル・値の行
function buildLabelValue(label, value) {
  return {
    type: 'box',
    layout: 'horizontal',
    contents: [
      { type: 'text', text: label, size: 'sm', color: '#888888', flex: 3 },
      { type: 'text', text: value, size: 'sm', color: '#333333', flex: 5, wrap: true },
    ],
  };
}

module.exports = {
  buildInventoryListFlex,
  buildProductDetailFlex,
  buildOrderListFlex,
  buildOrderConfirmFlex,
  buildUnpaidInvoicesFlex,
  buildHelpFlex,
};
