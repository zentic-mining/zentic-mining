import crypto from "crypto";
import { validateTelegramInitData } from "./telegram-auth.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Method not allowed",
    });
  }

  try {
    const { initData, action, proof } = req.body || {};

    const telegramAuth =
      validateTelegramInitData(initData);

    const telegram_user_id =
      telegramAuth.telegram_user_id;

    // Generate TON Proof payload
    if (action === "generate-proof") {
      const nonce =
        crypto.randomBytes(32).toString("base64url");

      const expires_at =
        Math.floor(Date.now() / 1000) + 600;

      const tonProofPayload =
        `${telegram_user_id}:${expires_at}:${nonce}`;

      return res.status(200).json({
        success: true,
        tonProofPayload,
        expires_at,
      });
    }

    // Verify TON Proof
    if (action === "verify-proof") {
      if (!proof) {
        return res.status(400).json({
          error: "Missing TON proof",
        });
      }

      return res.status(200).json({
        success: true,
        message: "TON proof received",
        telegram_user_id,
        proof,
      });
    }

    return res.status(400).json({
      error: "Invalid wallet action",
    });
  } catch (error) {
    console.error("Wallet error:", error);

    return res.status(401).json({
      error:
        error.message ||
        "Wallet authentication failed",
    });
  }
}
