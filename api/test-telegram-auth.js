import { validateTelegramInitData } from "./telegram-auth.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Method not allowed",
    });
  }

  try {
    const { initData } = req.body || {};

    const result = validateTelegramInitData(initData);

    return res.status(200).json({
      success: true,
      telegram_user_id: result.telegram_user_id,
      start_param: result.start_param,
      auth_date: result.auth_date,
    });
  } catch (error) {
    console.error("Telegram auth test error:", error);

    return res.status(401).json({
      success: false,
      error: error.message || "Invalid Telegram initData",
    });
  }
}
