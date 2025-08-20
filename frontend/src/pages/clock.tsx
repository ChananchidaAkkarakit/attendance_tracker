// src/pages/clock-in.tsx
import { useEffect, useState } from "react";
import { useRouter } from "next/router";
import { kalnia } from "./_app";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE || process.env.NEXT_PUBLIC_API_URL || "http://127.0.0.1:8000";

type ApiOk = {
  ok: boolean;
  action: "in" | "out";
  attendance_id: number;
  distance_m: number;
  slot?: "morning" | "noon" | "afternoon" | "evening"; // << อ่านจาก backend (auto)
  user: { id: number; email: string; name: string };
};

type JWTPayload = {
  sub?: string;
  username?: string;
  name?: string;
  role?: string;
  exp?: number; // seconds since epoch
};

const SLOT_LABEL: Record<string, string> = {
  morning: "เช้า",
  noon: "กลางวัน",
  afternoon: "บ่าย",
  evening: "เย็น",
};

function parseJWT(token: string | null): JWTPayload | null {
  if (!token) return null;
  try {
    const base64 = (token.split(".")[1] ?? "").replace(/-/g, "+").replace(/_/g, "/");
    const json = atob(base64);
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function nameFromPayload(p: JWTPayload | null) {
  if (!p) return null;
  return p.name || p.username || p.sub || null;
}

export default function ClockInManual() {
  const router = useRouter();
  const [name, setName] = useState<string>("User");
  const [loading, setLoading] = useState<"in" | "out" | null>(null);
  const [msg, setMsg] = useState<string>("");
  const [now, setNow] = useState<string>("");

  // guard + preload username + role redirect
  useEffect(() => {
    const role = localStorage.getItem("role");
    const token = localStorage.getItem("token");
    const payload = parseJWT(token);

    // token expired -> logout
    if (payload?.exp && Date.now() / 1000 > payload.exp) {
      localStorage.clear();
      router.replace("/login");
      return;
    }

    // role guard
    if (!role) {
      router.replace("/login");
      return;
    }
    // if (role === "admin") {
    //   router.replace("/admin-home");
    //   return;
    // }

    // preload name
    const stored = localStorage.getItem("name");
    setName(stored || nameFromPayload(payload) || "User");
  }, [router]);

  // live clock (en-US)
  useEffect(() => {
    const fmt = new Intl.DateTimeFormat("us-US", { dateStyle: "full", timeStyle: "medium" });
    const tick = () => setNow(fmt.format(new Date()));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);

  async function doManual(action: "in" | "out") {
    const token = localStorage.getItem("token");
    if (!token) {
      alert("กรุณาเข้าสู่ระบบใหม่");
      router.replace("/login");
      return;
    }
    setLoading(action);
    setMsg("");

    try {
      // ขอพิกัด
      const pos = await new Promise<GeolocationPosition>((res, rej) =>
        navigator.geolocation.getCurrentPosition(res, rej, {
          enableHighAccuracy: true,
          timeout: 10000,
          maximumAge: 0,
        })
      ).catch((e) => {
        throw new Error(
          e?.code === e?.PERMISSION_DENIED
            ? "โปรดอนุญาตการเข้าถึงตำแหน่ง (Location)"
            : "ไม่สามารถอ่านพิกัดได้"
        );
      });

      const lat = pos.coords.latitude;
      const lng = pos.coords.longitude;
      const acc = Math.round(pos.coords.accuracy || 0);

      const form = new FormData();
      form.append("lat", String(lat));
      form.append("lng", String(lng));
      form.append("accuracy", String(acc));
      // ❌ ไม่ต้องส่ง slot — backend จะ derive ให้เอง

      const endpoint = action === "in" ? "/api/attendance/manual-in" : "/api/attendance/manual-out";
      const res = await fetch(`${API_BASE}${endpoint}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: form,
      });

      // จัดการกรณี token หมดอายุ/ไม่ถูกต้อง
      if (res.status === 401) {
        localStorage.clear();
        router.replace("/login");
        return;
      }

      const raw: unknown = await res.json();
      if (!res.ok) {
        const err = raw as { detail?: string };
        throw new Error(err?.detail || "บันทึกไม่สำเร็จ");
      }

      const data = raw as ApiOk;
      const t = new Intl.DateTimeFormat("us-US", { dateStyle: "medium", timeStyle: "short" }).format(new Date());
      const slotText = data.slot ? ` | ช่วง: ${SLOT_LABEL[data.slot] ?? data.slot}` : "";

      setMsg(
        data.action === "in"
          ? `บันทึก Clock-in สำเร็จ (${t})${slotText} | ห่างจุดอนุญาต ~${data.distance_m} m`
          : `บันทึก Clock-out สำเร็จ (${t})${slotText} | ห่างจุดอนุญาต ~${data.distance_m} m`
      );

      if (data?.user?.name) setName(data.user.name);
    } catch (e: any) {
      alert(e?.message ?? "เกิดข้อผิดพลาด");
    } finally {
      setLoading(null);
    }
  }

  return (
    <main className="min-h-screen w-full bg-[#FFFBF0] p-10">
      {/* กล่องพื้นฟ้า เว้นขอบ 10px รอบด้าน */}
      <section className="w-full min-h-[calc(100vh-80px)] rounded-[28px] bg-[#DEE5ED] px-6 sm:px-14 py-6 sm:py-8">
        {/* Header */}
        <div className="mb-10 flex items-center justify-between">
          <div className="flex items-center gap-3">
            {/* ปุ่มย้อนกลับ */}
            <button
              onClick={() => {
                if (typeof window !== "undefined" && window.history.length > 1) {
                  router.back();
                } else {
                  router.push("/admin-home"); // fallback
                }
              }}
              aria-label="Back"
              className="text-[#6E8197] bg-slate-50 transition hover:bg-white rounded-full p-1"
            >
              <svg
                viewBox="0 0 24 24"
                className="h-9 w-9"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M15 18l-6-6 6-6" />
              </svg>
            </button>

            <h1 className={`text-[40px] sm:text-[45px] font-semibold leading-none text-[#809CBB] ${kalnia.className}`}>
              Hi, {name}
            </h1>
          </div>

          <div className="flex flex-wrap gap-3">
            {/* ทางลัดไปสแกนหน้า */}
            <button
              onClick={() => router.push("/facescan")}
              className="rounded-full border border-[#BFD0E0] bg-white/80 px-6 py-3.5 text-[15px] text-[#6E8197] shadow-sm transition hover:bg-white"
            >
              Face Scan
            </button>

            <button
              onClick={() => {
                localStorage.clear();
                router.push("/login");
              }}
              className="rounded-full border border-[#BFD0E0] bg-white/80 px-6 py-3.5 text-[15px] text-[#6E8197] shadow-sm transition hover:bg-white"
            >
              Logout
            </button>
          </div>
        </div>

        {/* Title bar */}
        <div
          className={`mb-8 rounded-2xl bg-white py-5 text-center text-2xl sm:text-3xl font-medium text-[#809CBB] shadow-sm ${kalnia.className}`}
        >
          Clock‑in & clock‑out
        </div>

        {/* Username (readonly) */}
        <div className="mx-auto my-20 w-full max-w-3xl flex justify-center">
          <input
            value={name}
            readOnly
            className="w-96 rounded-3xl border flex justify-center border-[#BFD0E0] bg-white px-10 py-4 text-center text-[#6E8197] shadow-inner"
            aria-label="Username"
          />
        </div>

        {/* Buttons */}
        <div className="flex flex-wrap items-center justify-center gap-10">
          <button
            onClick={() => doManual("in")}
            disabled={loading === "in"}
            className={`group rounded-full bg-[#809CBB] px-8 py-3 text-lg font-medium text-[#FFFBF0] shadow transition hover:bg-[#6E8197] disabled:opacity-60 ${kalnia.className}`}
          >
            {loading === "in" ? "Processing…" : "Clock‑in"}
          </button>

          <button
            onClick={() => doManual("out")}
            disabled={loading === "out"}
            className={`group rounded-full bg-[#809CBB] px-8 py-3 text-lg font-medium text-[#FFFBF0] shadow transition hover:bg-[#6E8197] disabled:opacity-60 ${kalnia.className}`}
          >
            {loading === "out" ? "Processing…" : "Clock‑out"}
          </button>
        </div>

        {/* Info */}
        <div className="mx-auto mt-8 w-full max-w-3xl px-4 py-3 text-center text-[#6E8197]">
          <div>Current time: {now}</div>
          {msg && <div className="mt-2 text-[#809CBB]">{msg}</div>}
        </div>
      </section>
    </main>
  );
}
