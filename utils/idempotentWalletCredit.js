const OperatorWallet = require("../models/OperatorWallet");
const WalletTransaction = require("../models/WalletTransaction");

let walletTransactionIndexesReady;

async function ensureWalletTransactionIndexes() {
  if (!walletTransactionIndexesReady) {
    walletTransactionIndexesReady = WalletTransaction.init();
  }
  return walletTransactionIndexesReady;
}

/**
 * Apply one business credit to an operator wallet exactly once.
 *
 * The event key is recorded on both the wallet and ledger. The wallet key is
 * the balance guard; the unique ledger key is the audit-row guard. If a process
 * stops between those writes, a retry sees the wallet key and repairs the
 * missing ledger row without incrementing the balance again.
 */
async function creditOperatorWalletIdempotent({
  operatorId,
  amount,
  bookingId = null,
  eventKey,
  purpose,
  description = "",
}) {
  const creditAmount = Number(amount);
  if (!operatorId) throw new Error("operatorId is required for wallet credit");
  if (!eventKey || typeof eventKey !== "string") {
    throw new Error("eventKey is required for wallet credit");
  }
  if (!Number.isFinite(creditAmount) || creditAmount <= 0) {
    throw new Error("Wallet credit amount must be greater than zero");
  }

  await ensureWalletTransactionIndexes();

  // Seed the one-wallet-per-operator document before the conditional update.
  // A conditional upsert could otherwise try to insert a duplicate wallet when
  // the event key is already present.
  try {
    await OperatorWallet.updateOne(
      { operatorId },
      { $setOnInsert: { operatorId } },
      { upsert: true },
    );
  } catch (error) {
    if (error.code !== 11000) throw error;
  }

  const creditedWallet = await OperatorWallet.findOneAndUpdate(
    { operatorId, appliedCreditKeys: { $ne: eventKey } },
    {
      $inc: { balance: creditAmount, totalEarned: creditAmount },
      $addToSet: { appliedCreditKeys: eventKey },
    },
    { new: true, select: "+appliedCreditKeys" },
  );
  const applied = Boolean(creditedWallet);
  const wallet =
    creditedWallet ||
    (await OperatorWallet.findOne({ operatorId }).select(
      "+appliedCreditKeys",
    ));

  if (!wallet) throw new Error("Operator wallet could not be created");

  // Upsert also repairs the audit row after an interruption that happened just
  // after the balance update. The unique index makes concurrent repairs safe.
  try {
    await WalletTransaction.updateOne(
      { eventKey },
      {
        $setOnInsert: {
          operatorId,
          bookingId,
          eventKey,
          purpose: purpose || "",
          type: "CREDIT",
          amount: creditAmount,
          description,
          balanceAfter: Math.max(0, Number(wallet.balance) || 0),
        },
      },
      { upsert: true },
    );
  } catch (error) {
    if (error.code !== 11000) throw error;
  }

  const transaction = await WalletTransaction.findOne({ eventKey });
  return { applied, wallet, transaction };
}

module.exports = { creditOperatorWalletIdempotent };
