// src/pages/facescan.tsx
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/router";
import { kalnia } from "./_app";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE || process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";

const SLOT_LABEL: Record<string, string> = {
  morning: "เช้า",
  noon: "กลางวัน",
  afternoon: "บ่าย",
  evening: "เย็น",
};

function detectDefaultSlot() {
  const h = new Date().getHours();
  if (h < 10) return "morning";
  if (h < 13) return "noon";
  if (h < 17) return "afternoon";
  return "evening";
}

export default function FaceScanPage() {
  const router = useRouter();
  const videoRef = useRef<HTMLVideoElement>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [name, setName] = useState("Guest");
  const [slot, setSlot] = useState<"morning" | "noon" | "afternoon" | "evening">(detectDefaultSlot() as any);

  useEffect(() => {
    // เปิดกล้อง
    (async () => {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user" } });
      if (videoRef.current) videoRef.current.srcObject = stream;
    })().catch(() => setMsg("⚠️ Cannot access camera"));
    return () => {
      const s = videoRef.current?.srcObject as MediaStream | undefined;
      s?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  async function snapBlob(): Promise<Blob> {
    const v = videoRef.current!;
    const c = document.createElement("canvas");
    c.width = v.videoWidth || 640;
    c.height = v.videoHeight || 480;
    const ctx = c.getContext("2d")!;
    ctx.drawImage(v, 0, 0);
    return await new Promise((res) => c.toBlob((b) => res(b!), "image/jpeg", 0.9));
  }

  function getGeo(): Promise<GeolocationPosition> {
    return new Promise((res, rej) =>
      navigator.geolocation.getCurrentPosition(res, rej, { enableHighAccuracy: true, timeout: 8000 })
    );
  }

  async function clock(action: "in" | "out") {
    try {
      setBusy(true);
      setMsg(null);
      const [blob, pos] = await Promise.all([snapBlob(), getGeo()]);

      const fd = new FormData();
      fd.append("action", action);
      fd.append("file", blob, "face.jpg");
      fd.append("lat", String(pos.coords.latitude));
      fd.append("lng", String(pos.coords.longitude));
      if (pos.coords.accuracy != null) fd.append("accuracy", String(Math.round(pos.coords.accuracy)));

      const r = await fetch(`${API_BASE}/api/attendance/anonymous-clock`, { method: "POST", body: fd });
      const data = await r.json();
      if (!r.ok) throw new Error(data?.detail || "failed");

      setName(data.user.name);
      setMsg(`✅ ${data.user.name} clock-${data.action} (${data.slot}) • ~${data.distance_m} m`);

    } catch (e: any) {
      setMsg(`❌ ${e?.message || "error"}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="min-h-screen w-full bg-[#FFFBF0] p-10">
      {/* กล่องพื้นฟ้า เว้นขอบ */}
      <section className="w-full min-h-[calc(100vh-80px)] rounded-[28px] bg-[#DEE5ED] px-6 sm:px-14 py-6 sm:py-9 ">
        {/* Header */}
        <div className="mb-11 flex items-center justify-between">
          <div className="flex items-center gap-3">
            {/* ปุ่มย้อนกลับ */}
            <button
              onClick={() => {
                if (typeof window !== "undefined" && window.history.length > 1) {
                  router.back();
                } else {
                  router.push("/admin-home");
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
        </div>

        {/* Title bar */}
        <div
          className={`mb-6 rounded-2xl bg-white py-5 text-center text-2xl sm:text-3xl font-medium text-[#809CBB] shadow-sm ${kalnia.className}`}
        >
          Face Scan Clock in-out
        </div>

        {/* กล้อง */}
        <div className="mx-auto w-[500px] h-[320px] rounded-2xl bg-white/50 overflow-hidden flex items-center justify-center mb-8">
          <video ref={videoRef} autoPlay playsInline className="w-full h-full object-cover" />
        </div>

        {/* ปุ่ม */}
        <div className="flex gap-10 justify-center">
          <button
            disabled={busy}
            onClick={() => clock("in")}
            className={`group rounded-full bg-[#809CBB] px-8 py-3 text-lg font-medium text-[#FFFBF0] shadow transition hover:bg-[#6E8197] disabled:opacity-60 ${kalnia.className}`}
          >
            {busy ? "Processing…" : "Clock-in"}
          </button>
          <button
            disabled={busy}
            onClick={() => clock("out")}
            className={`group rounded-full bg-[#809CBB] px-8 py-3 text-lg font-medium text-[#FFFBF0] shadow transition hover:bg-[#6E8197] disabled:opacity-60 ${kalnia.className}`}
          >
            {busy ? "Processing…" : "Clock-out"}
          </button>
        </div>

        {msg && <p className="text-center mt-6 text-[#5A6E88]">{msg}</p>}
      </section>
    </main>
  );
}
