export const API = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";

export async function login(email: string, password: string) {
  const body = new URLSearchParams({ username: email, password });
  const res = await fetch(`${API}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" }
  /* body ด้านล่าง */
    , body
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export function authHeader(): HeadersInit {
  const t = (typeof window !== "undefined") ? localStorage.getItem("token") : null;
  // ถ้าไม่มี token → คืน object ว่าง (ไม่มีคีย์ Authorization)
  return t ? { Authorization: `Bearer ${t}` } : {};
}
