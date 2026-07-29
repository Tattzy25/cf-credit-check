const WEBHOOK_URL = "https://flow-webhooks.k8s.eu.codecreationlabs.cloud/webhook/wwe99hda";

export default {
  async fetch(request, env) {
    try {
      const body = await request.json();
      const { customer_id, outputs, feature } = body;
      const numOutputs = Number(outputs);

      // Trusting the payload, straight to the database lookups
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

      const costRow = await env.DB_BINDING.prepare(
        `SELECT "PER CLICK", "MAX OUTPUTS" FROM costs WHERE FEATURE = ?`
      )
        .bind(feature)
        .first();

      // The only limit check you wanted to keep
      if (costRow["MAX OUTPUTS"] > 0 && numOutputs > costRow["MAX OUTPUTS"]) {
        return new Response(`This action exceeds the maximum allowed outputs of ${costRow["MAX OUTPUTS"]}.`, { status: 400 });
      }

      const currentBalance = parseFloat(customerRow.balance) || 0;
      const customerIdMeta = customerRow.customer_id_meta || String(customer_id);
      const perClickCost = parseFloat(costRow["PER CLICK"]) || 0;

      const amountDeducted = numOutputs * perClickCost;
      const newBalance = currentBalance - amountDeducted;

      if (newBalance < 0) {
        return new Response("Insufficient funds.", { status: 402 });
      }

      // Update the database
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

      // Fire webhook
      await fetch(WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fieldOne: String(newBalance),
          fieldTwo: customerIdMeta,
          fieldThree: String(amountDeducted),
          fieldFour: String(currentBalance)
        }),
      });

      // Customer-facing success as raw text
      return new Response("Success", { status: 200 });
      
    } catch (err) {
      // Customer-facing failure as raw text
      return new Response("Server error. Please try again later.", { status: 500 });
    }
  },
};