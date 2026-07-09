/**
 * RazorpayX payout helper — used for operator wallet withdrawals.
 *
 * RazorpayX uses a different API surface from the payment gateway:
 *   - POST /v1/contacts        → create a contact (the operator)
 *   - POST /v1/fund_accounts   → attach a bank account / UPI VPA to the contact
 *   - POST /v1/payouts         → send money from our RazorpayX account to the fund account
 *
 * Auth is HTTP Basic using the RAZORPAYX key id + secret.
 *
 * NOTE: works in test mode with the rzp_test_* RazorpayX keys. For go-live,
 * swap to live RazorpayX keys and ensure the RazorpayX balance is funded.
 */

const RZPX_BASE = "https://api.razorpay.com/v1";

function authHeader() {
  // RazorpayX payouts authenticate with the dedicated RazorpayX API keys.
  const id = process.env.RAZORPAYX_KEY_ID;
  const secret = process.env.RAZORPAYX_KEY_SECRET;
  const token = Buffer.from(`${id}:${secret}`).toString("base64");
  return `Basic ${token}`;
}

async function rzpxRequest(path, body, idempotencyKey) {
  const headers = {
    "Content-Type": "application/json",
    Authorization: authHeader(),
  };
  // RazorpayX supports idempotency on payouts to avoid duplicate transfers
  if (idempotencyKey) headers["X-Payout-Idempotency"] = idempotencyKey;

  const res = await fetch(`${RZPX_BASE}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg =
      data?.error?.description || data?.message || `RazorpayX ${res.status}`;
    const err = new Error(msg);
    err.rzpx = data;
    throw err;
  }
  return data;
}

// Create (or reuse) a contact for the operator
async function createContact({ name, email, contact, referenceId }) {
  return rzpxRequest("/contacts", {
    name: name || "Trip Reel Operator",
    email: email || undefined,
    contact: contact || undefined,
    type: "vendor",
    reference_id: referenceId,
  });
}

// Create a fund account — bank account (IMPS/NEFT) or UPI VPA
async function createFundAccount({
  contactId,
  accountType, // "bank_account" | "vpa"
  accountHolderName,
  ifsc,
  accountNumber,
  vpa,
}) {
  if (accountType === "vpa") {
    return rzpxRequest("/fund_accounts", {
      contact_id: contactId,
      account_type: "vpa",
      vpa: { address: vpa },
    });
  }
  return rzpxRequest("/fund_accounts", {
    contact_id: contactId,
    account_type: "bank_account",
    bank_account: {
      name: accountHolderName,
      ifsc,
      account_number: accountNumber,
    },
  });
}

// Create a payout from our RazorpayX account to the operator's fund account
async function createPayout({
  fundAccountId,
  amountRupees,
  mode, // "IMPS" | "NEFT" | "UPI"
  referenceId,
  narration,
}) {
  const amountPaise = Math.round(Number(amountRupees) * 100);
  return rzpxRequest(
    "/payouts",
    {
      account_number: process.env.RAZORPAYX_ACCOUNT_NUMBER,
      fund_account_id: fundAccountId,
      amount: amountPaise,
      currency: "INR",
      mode: mode || "IMPS",
      purpose: "payout",
      queue_if_low_balance: true,
      reference_id: referenceId,
      narration: (narration || "Trip Reel Payout").slice(0, 30),
    },
    referenceId, // idempotency key — same reference never pays twice
  );
}

module.exports = { createContact, createFundAccount, createPayout };
