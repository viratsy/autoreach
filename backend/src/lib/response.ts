const ALLOWED_ORIGINS = [
  "https://autoreach.hardikraja.com",
  "https://autoreach.navinparmar.in",
  "http://localhost:3000",
];

function getCorsHeaders(origin?: string) {
  const allowedOrigin = origin && ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Headers": "Content-Type,Authorization",
    "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
    "Access-Control-Allow-Credentials": "true",
  };
}

export function success(body: unknown, origin?: string) {
  return {
    statusCode: 200,
    headers: getCorsHeaders(origin),
    body: JSON.stringify(body),
  };
}

export function error(statusCode: number, message: string, origin?: string) {
  return {
    statusCode,
    headers: getCorsHeaders(origin),
    body: JSON.stringify({ error: message }),
  };
}

export function options(origin?: string) {
  return {
    statusCode: 200,
    headers: getCorsHeaders(origin),
    body: "",
  };
}

// force rebuild v7
