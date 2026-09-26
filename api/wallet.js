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


/* =========================================================
   TON WALLET HELPERS
========================================================= */

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


/* =========================================================
   TON PROOF VERIFICATION
========================================================= */

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

      new Uint8Array(
        signature
      ),

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


/* =========================================================
   MAIN HANDLER
========================================================= */

export default async function handler(
  req,
  res
) {

  if (
    req.method !== "POST"
  ) {
    return res.status(405).json({
      error:
        "Method not allowed",
    });
  }


  let pool;


  try {

    const {
      initData,
      action,
      proof,
    } = req.body || {};


    /* =====================================================
       TELEGRAM AUTH
    ===================================================== */

    let telegram_user_id;


    try {

      const telegramAuth =
        validateTelegramInitData(
          initData
        );


      telegram_user_id =
        telegramAuth.telegram_user_id;

    } catch (error) {

      return res.status(401).json({
        error:
          error.message ||
          "Invalid Telegram authentication",
      });
    }


    /* =====================================================
       DATABASE
    ===================================================== */

    const databaseUrl =
      process.env.DATABASE_URL;


    if (!databaseUrl) {
      return res.status(500).json({
        error:
          "Database is not configured",
      });
    }


    pool =
      new Pool({
        connectionString:
          databaseUrl,
      });


    /* =====================================================
       GENERATE TON PROOF
    ===================================================== */

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


    /* =====================================================
       VERIFY TON PROOF
    ===================================================== */

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

        wallet_connected:
          true,

        user:
          userResult.rows[0],
      });
    }


    /* =====================================================
       WITHDRAW
    ===================================================== */

    if (
      action ===
      "withdraw"
    ) {

      const {
        amount,
      } = req.body || {};


      const withdrawAmount =
        Number(amount);


      if (
        !Number.isSafeInteger(
          withdrawAmount
        ) ||
        withdrawAmount <= 0
      ) {

        return res.status(400).json({
          error:
            "Invalid withdrawal amount",
        });
      }


      const MIN_WITHDRAW =
        500000;


      if (
        withdrawAmount <
        MIN_WITHDRAW
      ) {

        return res.status(400).json({
          error:
            "Minimum withdrawal is 500,000 ZENTIC.",
        });
      }


      /*
       * One database client is required
       * for the whole transaction.
       */

      const client =
        await pool.connect();


      try {

        await client.query(
          "BEGIN"
        );


        /* ================================================
           LOCK USER
        ================================================= */

        const userResult =
          await client.query(
            `
              SELECT
                telegram_user_id,
                zentic_balance,
                ton_wallet_address
              FROM users
              WHERE telegram_user_id = $1
              FOR UPDATE
            `,
            [
              telegram_user_id,
            ]
          );


        if (
          userResult.rows.length ===
          0
        ) {

          throw new Error(
            "Player not found"
          );
        }


        const user =
          userResult.rows[0];


        const balance =
          BigInt(
            user.zentic_balance || 0
          );


        /* ================================================
           WALLET REQUIRED
        ================================================= */

        if (
          !user.ton_wallet_address
        ) {

          throw new Error(
            "TON wallet is not connected."
          );
        }


        /* ================================================
           BALANCE CHECK
        ================================================= */

        if (
          balance <
          BigInt(withdrawAmount)
        ) {

          throw new Error(
            "Insufficient ZENTIC balance."
          );
        }


        /* ================================================
           ACTIVE AXE
        ================================================= */

        const inventoryResult =
          await client.query(
            `
              SELECT
                item
              FROM user_inventory
              WHERE telegram_user_id = $1
                AND status = 'active'
              ORDER BY id DESC
              LIMIT 1
            `,
            [
              telegram_user_id,
            ]
          );


        if (
          inventoryResult.rows.length ===
          0
        ) {

          throw new Error(
            "No active mining equipment."
          );
        }


        const axeType =
          inventoryResult.rows[0].item;


        /* ================================================
           WEEKLY LIMIT
        ================================================= */

        const weeklyLimitMap = {

          stone_axe:
            750000,

          iron_axe:
            1500000,

          steel_axe:
            3000000,

        };


        const weeklyLimit =
          weeklyLimitMap[
            axeType
          ];


        if (!weeklyLimit) {

          throw new Error(
            "Unsupported mining equipment."
          );
        }


        /* ================================================
           PENDING WITHDRAWAL CHECK
        ================================================= */

        const pendingResult =
          await client.query(
            `
              SELECT
                id
              FROM withdrawals
              WHERE telegram_user_id = $1
                AND status IN (
                  'pending',
                  'processing'
                )
              LIMIT 1
            `,
            [
              telegram_user_id,
            ]
          );


        if (
          pendingResult.rows.length >
          0
        ) {

          throw new Error(
            "You already have a pending withdrawal."
          );
        }


        /* ================================================
           10 MINUTE COOLDOWN
        ================================================= */

        const cooldownResult =
          await client.query(
            `
              SELECT
                created_at
              FROM withdrawals
              WHERE telegram_user_id = $1
                AND status IN (
                  'pending',
                  'processing',
                  'completed'
                )
                AND created_at >
                    NOW() - INTERVAL '10 minutes'
              ORDER BY created_at DESC
              LIMIT 1
            `,
            [
              telegram_user_id,
            ]
          );


        if (
          cooldownResult.rows.length >
          0
        ) {

          throw new Error(
            "Please wait 10 minutes before making another withdrawal."
          );
        }


        /* ================================================
           ROLLING 7 DAY QUOTA
        ================================================= */

        const weeklyResult =
          await client.query(
            `
              SELECT
                COALESCE(
                  SUM(zentic_amount),
                  0
                ) AS total
              FROM withdrawals
              WHERE telegram_user_id = $1
                AND axe_type = $2
                AND status IN (
                  'pending',
                  'processing',
                  'completed'
                )
                AND created_at >=
                    NOW() - INTERVAL '7 days'
            `,
            [
              telegram_user_id,
              axeType,
            ]
          );


        const weeklyUsed =
          BigInt(
            weeklyResult.rows[0].total ||
            0
          );


        const remainingQuota =
          BigInt(
            weeklyLimit
          ) -
          weeklyUsed;


        if (
          remainingQuota <= 0n
        ) {

          throw new Error(
            "Weekly withdrawal limit has been reached."
          );
        }


        if (
          BigInt(withdrawAmount) >
          remainingQuota
        ) {

          throw new Error(
            `Weekly withdrawal limit exceeded. Remaining quota: ${remainingQuota.toString()} ZENTIC.`
          );
        }


        /* ================================================
           ZENTIC -> USDT
           1,000,000 ZENTIC = 1 USDT
        ================================================= */

        const usdtAmount =
          (
            withdrawAmount /
            1000000
          ).toFixed(6);


        /* ================================================
           DEDUCT ZENTIC
        ================================================= */

        const updateResult =
          await client.query(
            `
              UPDATE users
              SET
                zentic_balance =
                  zentic_balance - $1,
                updated_at = NOW()
              WHERE telegram_user_id = $2
                AND zentic_balance >= $1
              RETURNING
                zentic_balance
            `,
            [
              withdrawAmount,
              telegram_user_id,
            ]
          );


        if (
          updateResult.rows.length ===
          0
        ) {

          throw new Error(
            "Insufficient ZENTIC balance."
          );
        }


        /* ================================================
           CREATE WITHDRAWAL
        ================================================= */

        const withdrawalResult =
          await client.query(
            `
              INSERT INTO withdrawals (
                telegram_user_id,
                zentic_amount,
                usdt_amount,
                ton_wallet_address,
                axe_type,
                status
              )
              VALUES (
                $1,
                $2,
                $3,
                $4,
                $5,
                'pending'
              )
              RETURNING
                id,
                telegram_user_id,
                zentic_amount,
                usdt_amount,
                ton_wallet_address,
                axe_type,
                status,
                created_at
            `,
            [
              telegram_user_id,
              withdrawAmount,
              usdtAmount,
              user.ton_wallet_address,
              axeType,
            ]
          );


        /* ================================================
           COMMIT
        ================================================= */

        await client.query(
          "COMMIT"
        );


        /* ================================================
           SUCCESS RESPONSE
        ================================================= */

        return res.status(200).json({

          success:
            true,

          withdrawal:
            withdrawalResult.rows[0],

          remaining_balance:
            updateResult.rows[0]
              .zentic_balance,

          weekly_quota: {

            limit:
              weeklyLimit,

            used:
              Number(
                weeklyUsed
              ) +
              withdrawAmount,

          remaining:
              Number(
                remainingQuota
              ) -
              withdrawAmount,

          },

        });


      } catch (error) {

        try {

          await client.query(
            "ROLLBACK"
          );

        } catch (rollbackError) {

          console.error(
            "Withdrawal rollback error:",
            rollbackError
          );
        }


        return res.status(400).json({

          error:
            error.message ||
            "Withdrawal failed",

        });


      } finally {

        client.release();

      }
    }


    /* =====================================================
       INVALID ACTION
    ===================================================== */

    return res.status(400).json({
      error:
        "Invalid wallet action",
    });


  } catch (error) {

    console.error(
      "Wallet error:",
      error
    );


    return
    res.status(500).json({

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
