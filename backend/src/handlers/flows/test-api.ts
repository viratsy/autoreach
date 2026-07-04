import { APIGatewayProxyHandler } from "aws-lambda";
import { success, error, options } from "../../lib/response";

/**
 * POST /flows/test-api
 * Proxies an API call server-side to avoid CORS issues when testing from the browser.
 * Body: { url, method, headers, body }
 */
export const handler: APIGatewayProxyHandler = async (event) => {
  const origin = event.headers?.origin || event.headers?.Origin;
  if (event.httpMethod === "OPTIONS") return options(origin);

  try {
    const { url, method, headers, body } = JSON.parse(event.body || "{}");

    if (!url) return error(400, "url is required", origin);

    const response = await fetch(url, {
      method: method || "POST",
      headers: { "Content-Type": "application/json", ...(headers || {}) },
      ...(body ? { body } : {}),
    });

    const responseText = await response.text();

    return success({
      status: response.status,
      statusText: response.statusText,
      body: responseText,
    }, origin);
  } catch (err: any) {
    return success({
      status: 0,
      statusText: "Error",
      body: err.message || "Request failed",
    }, origin);
  }
};
