import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";

const WEBHOOK_URL = "https://flow-webhooks.k8s.eu.codecreationlabs.cloud/webhook/wwe99hda";

function createServer(env) {
  const server = new McpServer({
    name: "credit-check",
    version: "1.0.0",
  });

  // Tool 1: deduct
  server.registerTool(
    "deduct",
    {
      description: "Deduct credits from a customer based on outputs and feature cost",
      inputSchema: {
        customer_id: z.string().describe("The customer ID"),
        outputs: z.string().describe("Number of outputs requested"),
        feature: z.string().describe("The feature name to look up cost (where the call is coming from)"),
      },
    },
    async (params) => {
      const customer_id = params.customer_id;
      const numOutputs = Number(params.outputs);
      const feature = params.feature;

      const customerRow = await env.DB_BINDING.prepare(
        `SELECT
           Customer_ID,
           BALANCE_customermetafieldscustombalance AS balance,
           CUSTOMER_ID_customermetafieldscustomcustomer_id AS customer_id_meta
         FROM mytable
         WHERE Customer_ID = ?`
      ).bind(customer_id).first();

      if (!customerRow) {
        return { content: [{ type: "text", text: "Customer not found." }] };
      }

      const costRow = await env.DB_BINDING.prepare(
        `SELECT "PER CLICK", "MAX OUTPUTS" FROM costs WHERE FEATURE = ?`
      ).bind(feature).first();

      if (!costRow) {
        return { content: [{ type: "text", text: "Feature not found." }] };
      }

      if (costRow["MAX OUTPUTS"] > 0 && numOutputs > costRow["MAX OUTPUTS"]) {
        return {
          content: [{
            type: "text",
            text: `This action exceeds the maximum allowed outputs of ${costRow["MAX OUTPUTS"]}.`,
          }],
        };
      }

      const currentBalance = parseFloat(customerRow.balance) || 0;
      const customerIdMeta = customerRow.customer_id_meta || String(customer_id);
      const perClickCost = parseFloat(costRow["PER CLICK"]) || 0;
      const amountDeducted = numOutputs * perClickCost;
      const newBalance = currentBalance - amountDeducted;

      if (newBalance < 0) {
        return { content: [{ type: "text", text: "Insufficient funds." }] };
      }

      await env.DB_BINDING.prepare(
        `UPDATE mytable
         SET
           BALANCE_customermetafieldscustombalance = ?,
           PREVIOUS_BALANCE_customermetafieldscustomprevious_balance = ?,
           AMOUNT_DEDUCTED_customermetafieldscustomlast_spent = ?,
           FEATURE_NAME_customermetafieldscustomfeature_name = ?
         WHERE Customer_ID = ?`
      ).bind(
        String(newBalance),
        String(currentBalance),
        String(amountDeducted),
        feature,
        customer_id
      ).run();

      await fetch(WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fieldOne: String(newBalance),
          fieldTwo: customerIdMeta,
          fieldThree: String(amountDeducted),
          fieldFour: String(currentBalance),
        }),
      });

      return {
        content: [{
          type: "text",
          text: `Success. New balance: ${String(newBalance)}`,
        }],
      };
    }
  );

  // Tool 2: balance
  server.registerTool(
    "balance",
    {
      description: "Check the current credit balance for a customer",
      inputSchema: {
        customer_id: z.string().describe("The customer ID"),
      },
    },
    async (params) => {
      const customerRow = await env.DB_BINDING.prepare(
        `SELECT
           BALANCE_customermetafieldscustombalance AS balance
         FROM mytable
         WHERE Customer_ID = ?`
      ).bind(params.customer_id).first();

      if (!customerRow) {
        return { content: [{ type: "text", text: "Customer not found." }] };
      }

      const balance = String(customerRow.balance || "0");

      return {
        content: [{ type: "text", text: balance }],
      };
    }
  );

  return server;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // MCP endpoint
    if (url.pathname.startsWith("/mcp")) {
      return createMcpHandler(() => createServer(env))(request, env, ctx);
    }

    // Original HTTP endpoint — keeps working as before
    const body = await request.json();
    const { customer_id, outputs, feature } = body;
    const numOutputs = Number(outputs);

    const customerRow = await env.DB_BINDING.prepare(
      `SELECT
         Customer_ID,
         BALANCE_customermetafieldscustombalance AS balance,
         CUSTOMER_ID_customermetafieldscustomcustomer_id AS customer_id_meta
       FROM mytable
       WHERE Customer_ID = ?`
    ).bind(customer_id).first();

    const costRow = await env.DB_BINDING.prepare(
      `SELECT "PER CLICK", "MAX OUTPUTS" FROM costs WHERE FEATURE = ?`
    ).bind(feature).first();

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

    await env.DB_BINDING.prepare(
      `UPDATE mytable
       SET
         BALANCE_customermetafieldscustombalance = ?,
         PREVIOUS_BALANCE_customermetafieldscustomprevious_balance = ?,
         AMOUNT_DEDUCTED_customermetafieldscustomlast_spent = ?,
         FEATURE_NAME_customermetafieldscustomfeature_name = ?
       WHERE Customer_ID = ?`
    ).bind(
      String(newBalance),
      String(currentBalance),
      String(amountDeducted),
      feature,
      customer_id
    ).run();

    await fetch(WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fieldOne: String(newBalance),
        fieldTwo: customerIdMeta,
        fieldThree: String(amountDeducted),
        fieldFour: String(currentBalance),
      }),
    });

    return new Response("Success", { status: 200 });
  },
};
