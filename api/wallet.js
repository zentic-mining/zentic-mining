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

/*
 * Extract public key from standard TON wallet
 * StateInit.
 *
 * Supports:
 * V1R1
 * V1R2
 * V1R3
 * V2R1
 * V2R2
 * V3R1
 * V3R2
 * V4R2
 * V5R1
 */
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

    /*
     * Domain must belong to this app.
     */
    if (
      proof.domain?.value !==
      ALLOWED_DOMAIN
    ) {
      return false;
    }

    /*
     * Verify the UTF-8 byte length of
     * the domain.
     */
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

    /*
     * Verify timestamp.
     */
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

    /*
     * Parse wallet address.
     */
    const walletAddress =
      Address.parse(address);

    /*
     * Parse wallet StateInit.
     */
    const stateInitCell =
      Cell.fromBase64(
        walletStateInit
      );

    const stateInit =
      loadStateInit(
        stateInitCell.beginParse()
      );

    /*
     * Verify that StateInit actually
     * produces the claimed wallet address.
     */
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

    /*
     * TON Connect spec explicitly requires:
     *
     * walletStateInit.hash()
     * === address.hash
     */
    if (
      !stateInitCell
        .hash()
        .equals(walletAddress.hash)
    ) {
      return false;
    }

    /*
     * Extract public key from the
     * known standard wallet contract.
     */
    const extractedPublicKey =
      tryExtractPublicKey(
        stateInit
      );

    /*
     * We intentionally reject unknown
     * wallet contract versions here.
     *
     * This prevents us from trusting a
     * publicKey supplied by the frontend.
     */
    if (!extractedPublicKey) {
      console.error(
        "Unsupported TON wallet contract"
      );

      return false;
    }

    /*
     * Compare public key supplied by
     * TON Connect with the public key
     * extracted from StateInit.
     */
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

    /*
     * Reconstruct TON Proof message.
     */
    const workchain =
      Buffer.alloc(4);

    workchain.writeInt32BE(
      walletAddress.workChain,
      0
    );

    const domainLength =
      Buffer.alloc(4);

    /*
     * TON Connect spec uses
     * unsigned 32-bit LITTLE endian
     * for domain length.
     */
    domainLength.writeUInt32LE(
      domainBytes.length,
      0
    );

    const timestampBuffer =
      Buffer.alloc(8);

    /*
     * TON Connect spec uses
     * unsigned 64-bit LITTLE endian
     * timestamp.
     */
    timestampBuffer.writeBigUInt64LE(
      BigInt(timestamp),
      0
    );

    /*
     * Payload is variable-length data
     * and is placed at the end.
     *
     * Our generated payload is text.
     */
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

    /*
     * First SHA-256:
     *
     * sha256(message)
     */
    const messageHash =
      await sha256(message);

    /*
     * TON Connect signature envelope:
     *
     * 0xffff
     * + "ton-connect"
     * + sha256(message)
     */
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

    /*
     * Final hash signed by wallet.
     */
    const finalHash =
      await sha256(
        fullMessage
      );

    /*
     * Signature returned by TON Connect
     * is Base64 encoded.
     */
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

    /*
     * Verify Ed25519 signature.
     */
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

    /*
     * Always authenticate Telegram first.
     */
    const telegramAuth =
      validateTelegramInitData(
        initData
      );

    const telegram_user_id =
      telegramAuth.telegram_user_id;

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

    /*
     * =====================================
     * GENERATE TON PROOF
     * =====================================
     */
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

    /*
     * =====================================
     * VERIFY TON PROOF
     * =====================================
     */
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

      /*
       * Find the exact server-issued
       * payload for this Telegram user.
       */
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

      /*
       * Prevent replay.
       */
      if (nonce.used_at) {
        return res.status(401).json({
          error:
            "TON proof has already been used",
        });
      }

      /*
       * Server-side nonce expiration.
       */
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

      /*
       * Verify the cryptographic proof.
       */
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

      /*
       * Consume nonce atomically.
       */
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

      /*
       * Save the verified wallet
       * against this Telegram user.
       */
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
