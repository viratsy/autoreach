const API_URL = process.env.NEXT_PUBLIC_API_URL || "";

function getToken(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem("token");
}

export async function apiRequest<T>(
  path: string,
  options: RequestInit = {}
): Promise<T> {
  const token = getToken();

  const res = await fetch(`${API_URL}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
  });

  if (res.status === 401) {
    // Token expired — redirect to login
    localStorage.removeItem("token");
    localStorage.removeItem("email");
    document.cookie = "token=; path=/; max-age=0";
    window.location.href = "/login";
    throw new Error("Session expired");
  }

  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Request failed");
  return data as T;
}

export function logout() {
  localStorage.removeItem("token");
  localStorage.removeItem("email");
  document.cookie = "token=; path=/; max-age=0";
  window.location.href = "/login";
}

export function getCurrentEmail(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem("email");
}
