const WEBHOOK_URL = "https://flow-webhooks.k8s.eu.codecreationlabs.cloud/webhook/wwe99hda";

export default {
  async fetch(request, env) {
    if (request.method !== "POST") {
      return json(
        { success: false, error: "Method not allowed. Please use POST." },
        405
      );
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json(
        {
          success: false,
          error: "Invalid request. Please check your data and try again.",
        },
        400
      );
    }

    const { customer_id, outputs, feature } = body;

    if (customer_id === undefined || customer_id === null) {
      return json({ success: false, error: "Customer ID is required." }, 400);
    }
    if (outputs === undefined || outputs === null || isNaN(Number(outputs))) {
      return json(
        { success: false, error: "A valid number of outputs is required." },
        400
      );
    }
    if (!feature) {
      return json({ success: false, error: "Feature is required." }, 400);
    }

    const numOutputs = Number(outputs);

    try {
      const customerRow = await env.DB_BINDING.prepare(
        `SELECT
           Customer_ID,
           BALANCE_customermetafieldscustombalance AS balance,
           CUSTOMER_ID_customermetafieldscustomcustomer_id AS customer_id_meta
         FROM mytable
         WHERE Customer_ID = ?`
      )
        .bind(customer_id)
        .first();

      if (!customerRow) {
        return json({ success: false, error: "Customer not found." }, 404);
      }

      const currentBalance = parseFloat(customerRow.balance) || 0;
      const customerIdMeta =
        customerRow.customer_id_meta || String(customer_id);

      const costRow = await env.DB_BINDING.prepare(
        `SELECT "PER CLICK", "MAX OUTPUTS" FROM costs WHERE FEATURE = ?`
      )
        .bind(feature)
        .first();

      if (!costRow) {
        return json(
          { success: false, error: "This feature is not available." },
          404
        );
      }

      const perClickCost = parseFloat(costRow["PER CLICK"]) || 0;
      const maxOutputs = parseFloat(costRow["MAX OUTPUTS"]) || 0;

      if (maxOutputs > 0 && numOutputs > maxOutputs) {
        return json(
          {
            success: false,
            error: `This action exceeds the maximum allowed outputs of ${maxOutputs}.`,
          },
          400
        );
      }

      const amountDeducted = numOutputs * perClickCost;
      const newBalance = currentBalance - amountDeducted;

      if (newBalance < 0) {
        return json({ success: false, error: "Insufficient funds." }, 402);
      }

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

      await fetch(WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          BALANCE_customermetafieldscustombalance: String(newBalance),
          CUSTOMER_ID_customermetafieldscustomcustomer_id: customerIdMeta,
          AMOUNT_DEDUCTED_customermetafieldscustomlast_spent:
            String(amountDeducted),
          PREVIOUS_BALANCE_customermetafieldscustomprevious_balance:
            String(currentBalance),
        }),
      });

      return json({ success: true }, 200);
    } catch (err) {
      return json(
        { success: false, error: "Server error. Please try again later." },
        500
      );
    }
  },
};

function json(data, status) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}