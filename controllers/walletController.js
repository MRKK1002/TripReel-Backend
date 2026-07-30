const OperatorWallet = require("../models/OperatorWallet");
const WalletTransaction = require("../models/WalletTransaction");
const crypto = require("crypto");

const MIN_WITHDRAWAL = 100; // ₹ minimum payout
const MAX_WITHDRAWAL = 500000; // ₹ per-request ceiling (sanity guard)
// Hold window after payout details (UPI/bank) change before payouts are allowed
const PAYOUT_CHANGE_HOLD_MS = 24 * 60 * 60 * 1000;

function mapPayoutStatus(s) {
  switch ((s || "").toLowerCase()) {
    case "processed":
      return "PROCESSED";
    case "reversed":
      return "REVERSED";
    case "failed":
    case "rejected":
    case "cancelled":
      return "FAILED";
    default:
      return "PROCESSING"; // queued | pending | processing | scheduled
  }
}

// ── Operator ──────────────────────────────────────────────────────────────────

// GET /api/wallet  — operator's own wallet summary
exports.getMyWallet = async (req, res) => {
  try {
    const wallet = await OperatorWallet.findOneAndUpdate(
      { operatorId: req.operator._id },
      { $setOnInsert: { operatorId: req.operator._id } },
      { upsert: true, new: true },
    );
    res.json({ success: true, wallet });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// GET /api/wallet/transactions  — operator's transaction history
exports.getMyTransactions = async (req, res) => {
  try {
    const { page = 1, limit = 20, type, fromDate, toDate } = req.query;
    const skip = (Number(page) - 1) * Number(limit);

    const query = { operatorId: req.operator._id };
    if (type && type !== "all") query.type = type;
    if (fromDate || toDate) {
      query.createdAt = {};
      if (fromDate) query.createdAt.$gte = new Date(fromDate);
      if (toDate) {
        const end = new Date(toDate);
        end.setHours(23, 59, 59, 999);
        query.createdAt.$lte = end;
      }
    }

    const [transactions, total] = await Promise.all([
      WalletTransaction.find(query)
        .populate("bookingId", "bookingId snapshot.packageTitle")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(Number(limit)),
      WalletTransaction.countDocuments(query),
    ]);

    res.json({ success: true, total, page: Number(page), transactions });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ── Admin ─────────────────────────────────────────────────────────────────────

// GET /api/wallet/admin/all  — all operator wallets
exports.adminGetAllWallets = async (req, res) => {
  try {
    const { page = 1, limit = 20, search } = req.query;
    const skip = (Number(page) - 1) * Number(limit);

    // Optional search by operator business/contact name
    let operatorIdFilter = null;
    if (search && search.trim()) {
      const { Operator } = require("../models/Operator");
      const ops = await Operator.find({
        $or: [
          { businessName: { $regex: search, $options: "i" } },
          { contactName: { $regex: search, $options: "i" } },
          { email: { $regex: search, $options: "i" } },
        ],
      }).select("_id");
      operatorIdFilter = ops.map((o) => o._id);
    }

    const query = operatorIdFilter
      ? { operatorId: { $in: operatorIdFilter } }
      : {};

    const [wallets, total] = await Promise.all([
      OperatorWallet.find(query)
        .populate("operatorId", "businessName contactName email")
        .sort({ balance: -1 })
        .skip(skip)
        .limit(Number(limit)),
      OperatorWallet.countDocuments(query),
    ]);

    res.json({ success: true, total, page: Number(page), wallets });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// GET /api/wallet/admin/:operatorId  — admin views single operator wallet
exports.adminGetWallet = async (req, res) => {
  try {
    const wallet = await OperatorWallet.findOne({
      operatorId: req.params.operatorId,
    }).populate("operatorId", "businessName contactName email");

    if (!wallet) {
      return res.json({
        success: true,
        wallet: { balance: 0, totalEarned: 0, totalWithdrawn: 0 },
      });
    }

    const transactions = await WalletTransaction.find({
      operatorId: req.params.operatorId,
    })
      .sort({ createdAt: -1 })
      .limit(20);

    res.json({ success: true, wallet, recentTransactions: transactions });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ── Withdrawals (RazorpayX payouts) ───────────────────────────────────────────

// POST /api/wallet/withdraw  — operator withdraws money to their bank/UPI
exports.requestWithdrawal = async (req, res) => {
  const operatorId = req.operator._id;
  const amount = Math.floor(Number(req.body.amount));

  if (!Number.isFinite(amount) || amount < MIN_WITHDRAWAL) {
    return res.status(400).json({
      success: false,
      message: `Minimum withdrawal is ₹${MIN_WITHDRAWAL}`,
    });
  }
  if (amount > MAX_WITHDRAWAL) {
    return res.status(400).json({
      success: false,
      message: `Maximum withdrawal per request is ₹${MAX_WITHDRAWAL.toLocaleString("en-IN")}`,
    });
  }

  const { Operator } = require("../models/Operator");
  const Withdrawal = require("../models/Withdrawal");
  const {
    createContact,
    createFundAccount,
    createPayout,
  } = require("../utils/razorpayPayout");

  // ── Everything below runs inside a guarded scope ─────────────────────────────
  // The atomic debit used to sit OUTSIDE any try/catch: if Withdrawal.create (or
  // anything between) threw, the balance was already reduced with no withdrawal
  // record and no compensating credit — real, silent money loss.
  let debitedWallet = null;
  let withdrawal = null;

  const refundDebit = async (reason) => {
    if (!debitedWallet) return;
    try {
      const w = await OperatorWallet.findOneAndUpdate(
        { operatorId },
        { $inc: { balance: amount } },
        { new: true },
      );
      await WalletTransaction.create({
        operatorId,
        type: "CREDIT",
        amount,
        description: `Withdrawal could not be started (${reason}) — amount returned to wallet`,
        balanceAfter: w?.balance || 0,
      });
    } catch (e) {
      console.error(
        "[requestWithdrawal] CRITICAL: failed to return debited amount",
        { operatorId: String(operatorId), amount, error: e.message },
      );
    }
    debitedWallet = null;
  };

  try {
    const operator = await Operator.findById(operatorId);
    if (!operator) {
      return res
        .status(404)
        .json({ success: false, message: "Operator not found" });
    }

    // ── Payout-detail cooling-off ──────────────────────────────────────────────
    // Bank fields are admin-locked, but upiId is self-editable, so changing UPI
    // and immediately withdrawing was a way to redirect funds. Hold new payouts
    // briefly after any payout-destination change.
    if (operator.payoutDetailsChangedAt) {
      const elapsedMs =
        Date.now() - new Date(operator.payoutDetailsChangedAt).getTime();
      if (elapsedMs < PAYOUT_CHANGE_HOLD_MS) {
        const hoursLeft = Math.ceil(
          (PAYOUT_CHANGE_HOLD_MS - elapsedMs) / (60 * 60 * 1000),
        );
        return res.status(400).json({
          success: false,
          code: "PAYOUT_DETAILS_ON_HOLD",
          message: `Your payout details changed recently. For security, withdrawals are on hold for another ${hoursLeft} hour${hoursLeft > 1 ? "s" : ""}.`,
        });
      }
    }

    // Choose destination: explicit method, else bank if present, else UPI
    const method =
      req.body.method === "vpa" || (!operator.accountNumber && operator.upiId)
        ? "vpa"
        : "bank_account";

    if (method === "bank_account") {
      if (
        !operator.accountNumber ||
        !operator.ifscCode ||
        !operator.accountHolderName
      ) {
        return res.status(400).json({
          success: false,
          message:
            "Add your bank account details (account number, IFSC, holder name) before withdrawing.",
        });
      }
    } else if (!operator.upiId) {
      return res
        .status(400)
        .json({ success: false, message: "Add a UPI ID before withdrawing." });
    }

    // Reject a second withdrawal while one is still in flight
    const inFlight = await Withdrawal.countDocuments({
      operatorId,
      status: { $in: ["PENDING", "PROCESSING"] },
    });
    if (inFlight > 0) {
      return res.status(400).json({
        success: false,
        message:
          "You already have a withdrawal in progress. Please wait for it to complete.",
      });
    }

    // ── Atomic debit: only succeeds if balance >= amount (prevents over/double withdraw)
    const wallet = await OperatorWallet.findOneAndUpdate(
      { operatorId, balance: { $gte: amount } },
      { $inc: { balance: -amount } },
      { new: true },
    );
    if (!wallet) {
      return res
        .status(400)
        .json({ success: false, message: "Insufficient wallet balance" });
    }
    debitedWallet = wallet;

    const referenceId = `wd${Date.now().toString(36)}${String(operatorId).slice(-6)}`;
    try {
      withdrawal = await Withdrawal.create({
        operatorId,
        amount,
        method,
        referenceId,
        status: "PENDING",
      });
    } catch (e) {
      // Could not even record the withdrawal — give the money back
      await refundDebit("could not create withdrawal record");
      return res.status(500).json({
        success: false,
        message: "Could not start the withdrawal. Your balance is unchanged.",
      });
    }

    try {
      // Ensure RazorpayX contact
      let contactId = operator.razorpayContactId;
      if (!contactId) {
        const c = await createContact({
          name: operator.contactName || operator.businessName || "Operator",
          email: operator.email,
          contact: operator.phone,
          referenceId: String(operatorId),
        });
        contactId = c.id;
        operator.razorpayContactId = contactId;
      }

      // Ensure fund account (recreate if bank/UPI details changed)
      const fingerprint =
        method === "vpa"
          ? `vpa:${operator.upiId}`
          : `bank:${operator.accountNumber}:${operator.ifscCode}`;
      let fundAccountId = operator.razorpayFundAccountId;
      if (!fundAccountId || operator.razorpayFundFingerprint !== fingerprint) {
        const fa = await createFundAccount({
          contactId,
          accountType: method,
          accountHolderName: operator.accountHolderName,
          ifsc: operator.ifscCode,
          accountNumber: operator.accountNumber,
          vpa: operator.upiId,
        });
        fundAccountId = fa.id;
        operator.razorpayFundAccountId = fundAccountId;
        operator.razorpayFundFingerprint = fingerprint;
      }
      await operator.save();

      // Create the payout
      const payout = await createPayout({
        fundAccountId,
        amountRupees: amount,
        mode: method === "vpa" ? "UPI" : "IMPS",
        referenceId,
        narration: "Trip Reel payout",
      });

      withdrawal.payoutId = payout.id || "";
      withdrawal.fundAccountId = fundAccountId;
      if (payout.utr) withdrawal.utr = payout.utr; // usually arrives later via webhook
      withdrawal.destination =
        method === "vpa"
          ? operator.upiId
          : `****${String(operator.accountNumber || "").slice(-4)}`;
      withdrawal.status = mapPayoutStatus(payout.status);
      await withdrawal.save();

      // Log the wallet transaction. `totalWithdrawn` is only incremented once the
      // payout actually settles (see the webhook) — it used to be bumped even for
      // a PROCESSING payout that might later reverse.
      await WalletTransaction.create({
        operatorId,
        type: "WITHDRAWAL",
        amount,
        description: `Withdrawal to ${withdrawal.destination}`,
        balanceAfter: wallet.balance,
      });
      if (withdrawal.status === "PROCESSED") {
        await OperatorWallet.updateOne(
          { operatorId },
          { $inc: { totalWithdrawn: amount } },
        );
        withdrawal.countedInTotal = true;
        await withdrawal.save();
      }

      debitedWallet = null; // payout accepted — debit is now legitimate
      return res.json({
        success: true,
        withdrawal,
        balance: wallet.balance,
        message: "Withdrawal initiated",
      });
    } catch (err) {
      // Payout failed → return the debited money to the wallet, mark FAILED
      await OperatorWallet.updateOne(
        { operatorId },
        { $inc: { balance: amount } },
      );
      debitedWallet = null; // already compensated here

      // Friendly message for the most common cause: RazorpayX not activated
      let friendly = err.message || "Payout failed";
      if (/not found on the server|not enabled|not activated/i.test(friendly)) {
        friendly =
          "Withdrawals are temporarily unavailable (payout service not enabled yet). Your balance is unchanged.";
      }
      console.error(
        "Withdrawal payout error:",
        err.rzpx ? JSON.stringify(err.rzpx) : err.message,
      );

      // Self-heal: if the cached RazorpayX contact/fund account is invalid
      // (e.g. keys/account changed), clear them so the next attempt recreates them.
      if (
        /fund_account|contact|does not exist|not found|invalid/i.test(friendly)
      ) {
        try {
          operator.razorpayContactId = "";
          operator.razorpayFundAccountId = "";
          operator.razorpayFundFingerprint = "";
          await operator.save();
        } catch {}
      }

      withdrawal.status = "FAILED";
      withdrawal.failureReason = err.message || "Payout failed";
      withdrawal.refunded = true;
      await withdrawal.save();
      return res.status(400).json({
        success: false,
        message: friendly,
      });
    }
  } catch (outerErr) {
    // Anything unexpected before/around the payout — never leave a silent debit
    await refundDebit("unexpected error");
    if (withdrawal && withdrawal.status === "PENDING") {
      try {
        withdrawal.status = "FAILED";
        withdrawal.failureReason = outerErr.message || "Unexpected error";
        withdrawal.refunded = true;
        await withdrawal.save();
      } catch {}
    }
    console.error("[requestWithdrawal] unexpected error:", outerErr);
    if (res.headersSent) return;
    return res.status(500).json({
      success: false,
      message:
        "Could not process the withdrawal. Your balance has not been changed.",
    });
  }
};

// GET /api/wallet/withdrawals  — operator's withdrawal history
exports.getMyWithdrawals = async (req, res) => {
  try {
    const Withdrawal = require("../models/Withdrawal");
    const { page = 1, limit = 20 } = req.query;
    const skip = (Number(page) - 1) * Number(limit);
    const [withdrawals, total] = await Promise.all([
      Withdrawal.find({ operatorId: req.operator._id })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(Number(limit)),
      Withdrawal.countDocuments({ operatorId: req.operator._id }),
    ]);
    res.json({ success: true, total, page: Number(page), withdrawals });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// POST /api/wallet/razorpayx/webhook  — RazorpayX payout status callbacks
exports.razorpayxWebhook = async (req, res) => {
  try {
    const Withdrawal = require("../models/Withdrawal");
    const secret = process.env.RAZORPAYX_WEBHOOK_SECRET;

    // Signature verification is MANDATORY. This used to be `if (secret) {...}`,
    // so with the env var unset the endpoint accepted unsigned events — anyone
    // could POST a "reversed" payout and have the amount credited back, repeatedly.
    if (!secret) {
      console.error(
        "[razorpayxWebhook] RAZORPAYX_WEBHOOK_SECRET is not set — rejecting webhook",
      );
      return res
        .status(503)
        .json({ success: false, message: "Webhook not configured" });
    }

    const signature = req.headers["x-razorpay-signature"];
    if (!signature) {
      return res
        .status(400)
        .json({ success: false, message: "Missing signature" });
    }
    const expected = crypto
      .createHmac("sha256", secret)
      .update(req.rawBody || Buffer.from(JSON.stringify(req.body || {})))
      .digest("hex");
    const sigBuf = Buffer.from(String(signature));
    const expBuf = Buffer.from(expected);
    if (
      sigBuf.length !== expBuf.length ||
      !crypto.timingSafeEqual(sigBuf, expBuf)
    ) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid signature" });
    }

    const entity = req.body?.payload?.payout?.entity;
    if (!entity) return res.json({ success: true }); // not a payout event

    const withdrawal = await Withdrawal.findOne({ payoutId: entity.id });
    if (!withdrawal) return res.json({ success: true });

    withdrawal.status = mapPayoutStatus(entity.status);
    // Capture the bank UTR as soon as RazorpayX assigns it (on processing/processed)
    if (entity.utr && !withdrawal.utr) withdrawal.utr = entity.utr;

    const failed = ["reversed", "failed", "rejected", "cancelled"].includes(
      (entity.status || "").toLowerCase(),
    );
    if (failed && !withdrawal.refunded) {
      withdrawal.failureReason =
        entity.failure_reason || entity.status || "Payout failed";
      const w = await OperatorWallet.findOneAndUpdate(
        { operatorId: withdrawal.operatorId },
        { $inc: { balance: withdrawal.amount } },
        { new: true },
      );
      withdrawal.refunded = true;
      await WalletTransaction.create({
        operatorId: withdrawal.operatorId,
        type: "CREDIT",
        amount: withdrawal.amount,
        description: `Withdrawal ${entity.status} — amount returned to wallet`,
        balanceAfter: w?.balance || 0,
      });
    }

    // Count it against the lifetime total only once, on actual settlement
    if (
      withdrawal.status === "PROCESSED" &&
      !withdrawal.refunded &&
      !withdrawal.countedInTotal
    ) {
      await OperatorWallet.updateOne(
        { operatorId: withdrawal.operatorId },
        { $inc: { totalWithdrawn: withdrawal.amount } },
      );
      withdrawal.countedInTotal = true;
    }

    await withdrawal.save();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// GET /api/wallet/admin/withdrawals  — admin view of all withdrawals
exports.adminGetWithdrawals = async (req, res) => {
  try {
    const Withdrawal = require("../models/Withdrawal");
    const { page = 1, limit = 20, status } = req.query;
    const skip = (Number(page) - 1) * Number(limit);
    const query = {};
    if (status && status !== "all") query.status = status;
    const [withdrawals, total] = await Promise.all([
      Withdrawal.find(query)
        .populate("operatorId", "businessName contactName email")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(Number(limit)),
      Withdrawal.countDocuments(query),
    ]);
    res.json({ success: true, total, page: Number(page), withdrawals });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};
