import crypto from "crypto";

export function validateTelegramInitData(initData) {
  if (!initData) {
    throw new Error("Missing Telegram initData");
  }

  const botToken =
    process.env.TELEGRAM_BOT_TOKEN;

  if (!botToken) {
    throw new Error(
      "Telegram bot token is not configured"
    );
  }

  const params =
    new URLSearchParams(initData);

  const receivedHash =
    params.get("hash");

  if (!receivedHash) {
    throw new Error(
      "Missing Telegram hash"
    );
  }

  const authDate =
    Number(params.get("auth_date"));

  if (
    !Number.isSafeInteger(authDate) ||
    authDate <= 0
  ) {
    throw new Error(
      "Missing or invalid Telegram auth date"
    );
  }

  /*
   * Accept initData up to 24 hours old.
   * Reject timestamps more than 60 seconds
   * in the future.
   */
  const now =
    Math.floor(Date.now() / 1000);

  const age =
    now - authDate;

  if (
    age < -60 ||
    age > 86400
  ) {
    throw new Error(
      "Telegram initData has expired or is invalid"
    );
  }

  /*
   * Build Telegram data-check-string.
   *
   * Telegram requires all parameters
   * except "hash", sorted alphabetically.
   */
  const dataCheckString =
    [...params.entries()]
      .filter(
        ([key]) =>
          key !== "hash"
      )
      .sort(
        ([a], [b]) =>
          a.localeCompare(b)
      )
      .map(
        ([key, value]) =>
          `${key}=${value}`
      )
      .join("\n");

  /*
   * Telegram Web App secret key.
   */
  const secretKey =
    crypto
      .createHmac(
        "sha256",
        "WebAppData"
      )
      .update(botToken)
      .digest();

  /*
   * Calculate expected hash.
   */
  const calculatedHash =
    crypto
      .createHmac(
        "sha256",
        secretKey
      )
      .update(dataCheckString)
      .digest("hex");

  const receivedHashBuffer =
    Buffer.from(
      receivedHash,
      "hex"
    );

  const calculatedHashBuffer =
    Buffer.from(
      calculatedHash,
      "hex"
    );

  /*
   * Constant-time hash comparison.
   */
  if (
    receivedHashBuffer.length !==
      calculatedHashBuffer.length ||
    !crypto.timingSafeEqual(
      receivedHashBuffer,
      calculatedHashBuffer
    )
  ) {
    throw new Error(
      "Invalid Telegram initData"
    );
  }

  /*
   * Extract Telegram user.
   */
  const userData =
    params.get("user");

  if (!userData) {
    throw new Error(
      "Telegram user data is missing"
    );
  }

  let user;

  try {
    user =
      JSON.parse(userData);
  } catch {
    throw new Error(
      "Invalid Telegram user data"
    );
  }

  /*
   * Telegram user ID must be
   * a valid JavaScript safe integer.
   */
  const telegramUserId =
    Number(user.id);

  if (
    !Number.isSafeInteger(
      telegramUserId
    ) ||
    telegramUserId <= 0
  ) {
    throw new Error(
      "Telegram user ID is invalid"
    );
  }

  return {
    telegram_user_id:
      telegramUserId,

    user,

    start_param:
      params.get("start_param") ||
      null,

    auth_date:
      authDate,
  };
}
