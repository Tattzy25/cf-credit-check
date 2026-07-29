/**
 * CALCULATOR WORKER — DEDUCT
 *
 * Receives: customer_id, outputs, feature
 * 1. Looks up the customer's current balance from `mytable`
 * 2. Looks up "PER CLICK" and "MAX OUTPUTS" from `costs` by FEATURE
 * 3. Validates outputs against MAX OUTPUTS
 * 4. Checks for sufficient funds
 * 5. Calculates: amount_deducted = outputs * per_click_cost
 * 6. Updates mytable with new balance, previous balance, amount deducted, feature
 * 7. On success: returns { success: true } and fires a webhook
 * 8. On failure: returns a friendly error message, no webhook
 *
 * D1 binding name: DB_BINDING
 * D1 database ID:  00a00a6a-a859-4e09-9655-44e5d1307b60
 */

export interface Env {
  DB_BINDING: D1Database;
}

interface DeductRequest {
  customer_id: string | number;
  outputs: number;
  feature: string;
}

const WEBHOOK_URL = "https://flow-webhooks.k8s.eu.codecreationlabs.cloud/webhook/wwe99hda";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Only accept POST
    if (request.method !== "POST") {
      return json({ success: false, error: "Method not allowed. Please use POST." }, 405);
    }

    let body: DeductRequest;
    try {
      body = await request.json() as DeductRequest;
    } catch {
      return json({ success: false, error: "Invalid request. Please check your data and try again." }, 400);
    }

    const { customer_id, outputs, feature } = body;

    // --- Validate inputs ---
    if (customer_id === undefined || customer_id === null) {
      return json({ success: false, error: "Customer ID is required." }, 400);
    }
    if (outputs === undefined || outputs === null || isNaN(Number(outputs))) {
      return json({ success: false, error: "A valid number of outputs is required." }, 400);
    }
    if (!feature) {
      return json({ success: false, error: "Feature is required." }, 400);
    }

    const numOutputs = Number(outputs);

    try {
      // --- 1. Get the customer's current balance from mytable ---
      const customerRow = await env.DB_BINDING.prepare(
        `SELECT
           Customer_ID,
           BALANCE_customermetafieldscustombalance AS balance,
           CUSTOMER_ID_customermetafieldscustomcustomer_id AS customer_id_meta
         FROM mytable
         WHERE Customer_ID = ?`
      ).bind(customer_id).first();

      if (!customerRow) {
        return json({ success: false, error: "Customer not found." }, 404);
      }

      const currentBalance = parseFloat(customerRow.balance as string) || 0;
      const customerIdMeta = (customerRow.customer_id_meta as string) || String(customer_id);

      // --- 2. Look up the per-click cost and max outputs from the costs table ---
      const costRow = await env.DB_BINDING.prepare(
        `SELECT "PER CLICK", "MAX OUTPUTS" FROM costs WHERE FEATURE = ?`
      ).bind(feature).first();

      if (!costRow) {
        return json({ success: false, error: "This feature is not available." }, 404);
      }

      const perClickCost = parseFloat(costRow["PER CLICK"] as string) || 0;
      const maxOutputs = parseFloat(costRow["MAX OUTPUTS"] as string) || 0;

      // --- 2a. Validate outputs against MAX OUTPUTS ---
      if (maxOutputs > 0 && numOutputs > maxOutputs) {
        return json({ success: false, error: `This action exceeds the maximum allowed outputs of ${maxOutputs}.` }, 400);
      }

      // --- 3. Calculate the deduction ---
      const amountDeducted = numOutputs * perClickCost;
      const newBalance = currentBalance - amountDeducted;

      // --- 4. Check for sufficient funds ---
      if (newBalance < 0) {
        return json({ success: false, error: "Insufficient funds." }, 402);
      }

      // --- 5. Update mytable with the new values ---
      await env.DB_BINDING.prepare(
        `UPDATE mytable
         SET
           BALANCE_customermetafieldscustombalance         = ?,
           PREVIOUS_BALANCE_customermetafieldscustomprevious_balance = ?,
           AMOUNT_DEDUCTED_customermetafieldscustomlast_spent = ?,
           FEATURE_NAME_customermetafieldscustomfeature_name   = ?
         WHERE Customer_ID = ?`
      )
        .bind(
          String(newBalance),
          String(currentBalance),
          String(amountDeducted),
          feature,
          customer_id
        )
        .run();

      // --- 6. Fire the webhook (best-effort, non-blocking to response) ---
      try {
        await fetch(WEBHOOK_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            BALANCE_customermetafieldscustombalance: String(newBalance),
            CUSTOMER_ID_customermetafieldscustomcustomer_id: customerIdMeta,
            AMOUNT_DEDUCTED_customermetafieldscustomlast_spent: String(amountDeducted),
            PREVIOUS_BALANCE_customermetafieldscustomprevious_balance: String(currentBalance),
          }),
        });
      } catch {
        // Webhook failed — do not expose to caller, the deduction already succeeded
      }

      // --- 7. Return success to the caller ---
      return json({ success: true }, 200);

    } catch (err) {
      // Never expose internal errors to the caller
      return json({ success: false, error: "Server error. Please try again later." }, 500);
    }
  },
};

// --- Helper: JSON response ---
function json(data: unknown, status: number): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}