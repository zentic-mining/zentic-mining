import { neon } from "@neondatabase/serverless";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const token = process.env.TELEGRAM_BOT_TOKEN;
  const databaseUrl = process.env.DATABASE_URL;

  if (!token || !databaseUrl) {
    return res.status(500).json({
      error: "Server configuration is incomplete",
    });
  }

  const sql = neon(databaseUrl);
  const update = req.body;

  try {
    // Confirm the checkout request.
    if (update.pre_checkout_query) {
      const query = update.pre_checkout_query;

      const validPayments = {
        zentic_iron_axe: 100,
        zentic_steel_axe: 500,
      };

      const expectedAmount = validPayments[query.invoice_payload];

      const isValid =
        query.currency === "XTR" &&
        expectedAmount !== undefined &&
        query.total_amount === expectedAmount;

      await fetch(
        `https://api.telegram.org/bot${token}/answerPreCheckoutQuery`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            pre_checkout_query_id: query.id,
            ok: isValid,
            ...(isValid
              ? {}
              : {
                  error_message: "Payment details are invalid.",
                }),
          }),
        }
      );

      return res.status(200).json({ ok: true });
    }

    // Process a completed Telegram Stars payment.
    const payment = update.message?.successful_payment;

    if (payment) {
      const userId = update.message.from.id;
      const payload = payment.invoice_payload;

      let item;

      if (payload === "zentic_iron_axe") {
        item = "iron_axe";
      } else if (payload === "zentic_steel_axe") {
        item = "steel_axe";
      } else {
        return res.status(400).json({
          error: "Unknown payment payload",
        });
      }

      const stars = payment.total_amount;
      const chargeId = payment.telegram_payment_charge_id;

      const expectedStars = {
        iron_axe: 100,
        steel_axe: 500,
      };

      if (stars !== expectedStars[item]) {
        return res.status(400).json({
          error: "Invalid payment amount",
        });
      }

      const insertedPurchase = await sql`
        INSERT INTO purchases (
          telegram_user_id,
          item,
          stars,
          telegram_payment_charge_id,
          telegram_invoice_payload,
          status
        )
        VALUES (
          ${userId},
          ${item},
          ${stars},
          ${chargeId},
          ${payload},
          'completed'
        )
        ON CONFLICT (telegram_payment_charge_id) DO NOTHING
        RETURNING id
      `;

      if (insertedPurchase.length > 0) {
        await sql`
          INSERT INTO user_inventory (
            telegram_user_id,
            item,
            quantity
          )
          VALUES (
            ${userId},
            ${item},
            1
          )
          ON CONFLICT (telegram_user_id, item)
          DO UPDATE SET quantity = user_inventory.quantity + 1
        `;
      }

      return res.status(200).json({ ok: true });
    }

    return res.status(200).json({ ok: true });
    } catch (error) {
    console.error("Telegram webhook error:", error);

    return res.status(500).json({
      error: "Internal server error",
    });
  }
}
