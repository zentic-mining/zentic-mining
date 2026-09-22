import crypto from "crypto";
import { Pool } from "@neondatabase/serverless";
import { sha256 } from "@ton/crypto";

import {
  Address,
  Cell,
  WalletContractV1R1,
  WalletContractV1R2,
  WalletContractV1R3,
  WalletContractV2R1,
  WalletContractV2R2,
  WalletContractV3R1,
  WalletContractV3R2,
  WalletContractV4 as WalletContractV4R2,
  WalletContractV5R1,
  contractAddress,
  loadStateInit,
} from "@ton/ton";

import nacl from "tweetnacl";

import { validateTelegramInitData } from "./telegram-auth.js";

const TON_PROOF_PREFIX =
  "ton-proof-item-v2/";

const TON_CONNECT_PREFIX =
  "ton-connect";

const ALLOWED_DOMAIN =
  "zentic-mining.vercel.app";

const MAX_PROOF_AGE_SECONDS =
  15 * 60;

function loadV1(cs) {
  cs.loadUint(32);

  return cs.loadBuffer(32);
}

function loadV2(cs) {
  cs.loadUint(32);

  return cs.loadBuffer(32);
}

function loadV3(cs) {
  cs.loadUint(32);
  cs.loadUint(32);

  return cs.loadBuffer(32);
}

function loadV4(cs) {
  cs.loadUint(32);
  cs.loadUint(32);

  return cs.loadBuffer(32);
}

function loadV5(cs) {
  cs.loadBoolean();
  cs.loadUint(32);
  cs.loadUint(32);

  return cs.loadBuffer(32);
}

const knownWallets = [
  {
    contract: WalletContractV1R1,
    load: loadV1,
  },
  {
    contract: WalletContractV1R2,
    load: loadV1,
  },
  {
    contract: WalletContractV1R3,
    load: loadV1,
  },
  {
    contract: WalletContractV2R1,
    load: loadV2,
  },
  {
    contract: WalletContractV2R2,
    load: loadV2,
  },
  {
    contract: WalletContractV3R1,
    load: loadV3,
  },
  {
    contract: WalletContractV3R2,
    load: loadV3,
  },
  {
    contract: WalletContractV4R2,
    load: loadV4,
  },
  {
    contract: WalletContractV5R1,
    load: loadV5,
  },
].map(({ contract, load }) => ({
  code: contract
    .create({
      workchain: 0,
      publicKey: Buffer.alloc(32),
    })
    .init.code,

  load,
}));

function tryExtractPublicKey(stateInit) {
  for (const wallet of knownWallets) {
    if (
      wallet.code
        .hash()
        .equals(stateInit.code.hash())
    ) {
      const cs =
        stateInit.data.beginParse();

      return wallet.load(cs);
    }
  }

  return null;
}

async function verifyTonProof({
  address,
  publicKey,
  walletStateInit,
  proof,
}) {
  try {
    if (
      !address ||
      !publicKey ||
      !walletStateInit ||
      !proof
    ) {
      return false;
    }

    if (
      proof.domain?.value !==
      ALLOWED_DOMAIN
    ) {
      return false;
    }

    const domainBytes =
      Buffer.from(
        proof.domain.value,
        "utf8"
      );

    if (
      proof.domain.lengthBytes !==
      domainBytes.length
    ) {
      return false;
    }

    const timestamp =
      Number(proof.timestamp);

    if (
      !Number.isSafeInteger(timestamp)
    ) {
      return false;
    }

    const now =
      Math.floor(
        Date.now() / 1000
      );

    if (
      Math.abs(
        now - timestamp
      ) > MAX_PROOF_AGE_SECONDS
    ) {
      return false;
    }

    const walletAddress =
      Address.parse(address);

    const stateInitCell =
      Cell.fromBase64(
        walletStateInit
      );

    const stateInit =
      loadStateInit(
        stateInitCell.beginParse()
      );

    const derivedAddress =
      contractAddress(
        walletAddress.workChain,
        stateInit
      );

    if (
      !derivedAddress.equals(
        walletAddress
      )
    ) {
      return false;
    }

    if (
      !stateInitCell
        .hash()
        .equals(walletAddress.hash)
    ) {
      return false;
    }

    const extractedPublicKey =
      tryExtractPublicKey(
        stateInit
      );

    if (!extractedPublicKey) {
      console.error(
        "Unsupported TON wallet contract"
      );

      return false;
    }

    const suppliedPublicKey =
      Buffer.from(
        publicKey,
        "hex"
      );

    if (
      suppliedPublicKey.length !== 32
    ) {
      return false;
    }

    if (
      !suppliedPublicKey.equals(
        extractedPublicKey
      )
    ) {
      return false;
    }

    const workchain =
      Buffer.alloc(4);

    workchain.writeInt32BE(
      walletAddress.workChain,
      0
    );

    const domainLength =
      Buffer.alloc(4);

    domainLength.writeUInt32LE(
      domainBytes.length,
      0
    );

    const timestampBuffer =
      Buffer.alloc(8);

    timestampBuffer.writeBigUInt64LE(
      BigInt(timestamp),
      0
    );

    const payload =
      Buffer.from(
        proof.payload,
        "utf8"
      );

    const message =
      Buffer.concat([
        Buffer.from(
          TON_PROOF_PREFIX,
          "utf8"
        ),

        workchain,

        walletAddress.hash,

        domainLength,

        domainBytes,

        timestampBuffer,

        payload,
      ]);

    const messageHash =
      await sha256(message);

    const fullMessage =
      Buffer.concat([
        Buffer.from([
          0xff,
          0xff,
        ]),

        Buffer.from(
          TON_CONNECT_PREFIX,
          "utf8"
        ),

        messageHash,
      ]);

    const finalHash =
      await sha256(
        fullMessage
      );

    const signature =
      Buffer.from(
        proof.signature,
        "base64"
      );

    if (
      signature.length !== 64
    ) {
      return false;
    }

    return nacl.sign.detached.verify(
      new Uint8Array(finalHash),
      new Uint8Array(signature),
      new Uint8Array(
        extractedPublicKey
      )
    );
  } catch (error) {
    console.error(
      "TON proof verification error:",
      error
    );

    return false;
  }
}

export default async function handler(
  req,
  res
) {
  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Method not allowed",
    });
  }

  let pool;

  try {
    const {
      initData,
      action,
      proof,
    } = req.body || {};

    let telegram_user_id;

    try {
      const telegramAuth =
        validateTelegramInitData(initData);

      telegram_user_id =
        telegramAuth.telegram_user_id;
    } catch (error) {
      return res.status(401).json({
        error:
          error.message ||
          "Invalid Telegram authentication",
      });
    }

    const databaseUrl =
      process.env.DATABASE_URL;

    if (!databaseUrl) {
      return res.status(500).json({
        error:
          "Database is not configured",
      });
    }

    pool = new Pool({
      connectionString:
        databaseUrl,
    });

    if (
      action ===
      "generate-proof"
    ) {
      const nonce =
        crypto
          .randomBytes(32)
          .toString(
            "base64url"
          );

      const expires_at =
        Math.floor(
          Date.now() / 1000
        ) + 600;

      const tonProofPayload =
        `${telegram_user_id}:${expires_at}:${nonce}`;

      await pool.query(
        `
          INSERT INTO ton_proof_nonces (
            telegram_user_id,
            payload,
            expires_at
          )
          VALUES ($1, $2, $3)
        `,
        [
          telegram_user_id,
          tonProofPayload,
          expires_at,
        ]
      );

      return res.status(200).json({
        success: true,
        tonProofPayload,
        expires_at,
      });
    }

    if (
      action ===
      "verify-proof"
    ) {
      if (!proof) {
        return res.status(400).json({
          error:
            "Missing TON proof",
        });
      }

      if (
        !proof.address ||
        !proof.publicKey ||
        !proof.walletStateInit ||
        !proof.payload ||
        !proof.timestamp ||
        !proof.domain ||
        !proof.signature
      ) {
        return res.status(400).json({
          error:
            "Incomplete TON proof",
        });
      }

      const nonceResult =
        await pool.query(
          `
            SELECT
              id,
              telegram_user_id,
              payload,
              expires_at,
              used_at
            FROM ton_proof_nonces
            WHERE payload = $1
              AND telegram_user_id = $2
            LIMIT 1
          `,
          [
            proof.payload,
            telegram_user_id,
          ]
        );

      if (
        nonceResult.rows.length ===
        0
      ) {
        return res.status(401).json({
          error:
            "Invalid TON proof payload",
        });
      }

      const nonce =
        nonceResult.rows[0];

      if (nonce.used_at) {
        return res.status(401).json({
          error:
            "TON proof has already been used",
        });
      }

      const now =
        Math.floor(
          Date.now() / 1000
        );

      if (
        Number(nonce.expires_at) <
        now
      ) {
        return res.status(401).json({
          error:
            "TON proof payload expired",
        });
      }

      const valid =
        await verifyTonProof({
          address:
            proof.address,

          publicKey:
            proof.publicKey,

          walletStateInit:
            proof.walletStateInit,

          proof,
        });

      if (!valid) {
        return res.status(401).json({
          error:
            "Invalid TON proof signature",
        });
      }

      const consumeResult =
        await pool.query(
          `
            UPDATE ton_proof_nonces
            SET used_at = NOW()
            WHERE id = $1
              AND used_at IS NULL
              AND expires_at >= $2
            RETURNING id
          `,
          [
            nonce.id,
            now,
          ]
        );

      if (
        consumeResult.rows.length ===
        0
      ) {
        return res.status(401).json({
          error:
            "TON proof has already been used",
        });
      }

      const userResult =
        await pool.query(
          `
            UPDATE users
            SET
              ton_wallet_address = $1,
              wallet_connected_at =
                COALESCE(
                  wallet_connected_at,
                  NOW()
                ),
              updated_at = NOW()
            WHERE telegram_user_id = $2
            RETURNING
              telegram_user_id,
              ton_wallet_address,
              wallet_connected_at,
              updated_at
          `,
          [
            proof.address,
            telegram_user_id,
          ]
        );

      if (
        userResult.rows.length ===
        0
      ) {
        return res.status(404).json({
          error:
            "Player not found",
        });
      }

      return res.status(200).json({
        success: true,
        wallet_connected: true,
        user:
          userResult.rows[0],
      });
    }

    return res.status(400).json({
      error:
        "Invalid wallet action",
    });
  } catch (error) {
    console.error(
      "Wallet error:",
      error
    );

    return res.status(500).json({
      error:
        error.message ||
        "Wallet operation failed",
    });
  } finally {
    if (pool) {
      await pool.end();
    }
  }
}
