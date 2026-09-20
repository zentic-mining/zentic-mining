export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { item } = req.body || {};

  const products = {
    iron_axe: {
      title: "Iron Axe",
      description: "Iron Axe for Zentic Mining",
      amount: 100,
    },
    steel_axe: {
      title: "Steel Axe",
      description: "Steel Axe for Zentic Mining",
      amount: 500,
    },
  };

  const product = products[item];

  if (!product) {
    return res.status(400).json({ error: "Invalid item" });
  }

  const token = process.env.TELEGRAM_BOT_TOKEN;
console.log("Telegram token configured:", Boolean(token));
  if (!token) {
  return res.status(500).json({
    error: "Telegram bot token is not configured",
    telegram_token_configured: false
  });
  }

  const response = await fetch(
    `https://api.telegram.org/bot${token}/createInvoiceLink`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        title: product.title,
        description: product.description,
        payload: `zentic_${item}`,
        currency: "XTR",
        prices: [
          {
            label: product.title,
            amount: product.amount,
          },
        ],
      }),
    }
  );

  const data = await response.json();

  if (!data.ok) {
    return res.status(500).json({
      error: "Failed to create Telegram invoice",
      details: data.description,
    });
  }

  return res.status(200).json({
    invoice_url: data.result,
    item: item,
    price: product.amount,
  });
}
