import { useEffect, useRef, useState } from "react";
import { API, authHeader } from "@/lib/api";

type Resp = {
  ok?: boolean;
  action?: "in" | "out";
  score?: number;
  attendance_id?: number;
  user?: { id: number; name: string; email: string };
  detail?: string;
};

export default function ClockInOut() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const [busy, setBusy] = useState(false);
  const [lastScore, setLastScore] = useState<number | null>(null);
  const [lastUser, setLastUser] = useState<{ name: string; email: string } | null>(null);
  const [lastAction, setLastAction] = useState<"in" | "out" | null>(null);
  const [loc, setLoc] = useState<{ lat: number; lng: number; accuracy?: number } | null>(null);
  const [locError, setLocError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      // เปิดกล้อง
      const stream = await navigator.mediaDevices.getUserMedia({ video: true });
      if (videoRef.current) videoRef.current.srcObject = stream;
    })();
    return () => {
      const s = videoRef.current?.srcObject as MediaStream | undefined;
      s?.getTracks().forEach(t => t.stop());
    };
  }, []);

  // helper: promisify geolocation
  function getPosition(): Promise<GeolocationPosition> {
    return new Promise((resolve, reject) => {
      if (!("geolocation" in navigator)) {
        reject(new Error("เบราว์เซอร์นี้ไม่รองรับการระบุตำแหน่ง (Geolocation)"));
        return;
      }
      // หมายเหตุ: ต้องใช้ HTTPS หรือ localhost เท่านั้น
      if (location.protocol !== "https:" && location.hostname !== "localhost") {
        // ไม่ block แต่แจ้งเตือนเพื่อความเข้าใจ
        console.warn("Geolocation ต้องใช้ HTTPS หรือ localhost");
      }
      navigator.geolocation.getCurrentPosition(
        resolve,
        reject,
        { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
      );
    });
  }

  async function send(action: "in" | "out") {
    if (!videoRef.current || !canvasRef.current || busy) return;
    setBusy(true);
    setLocError(null);

    try {
      // 1) ขอพิกัดก่อน
      const pos = await getPosition().catch(err => {
        // แปลง error เป็นข้อความที่อ่านง่าย
        let msg = "ไม่สามารถอ่านพิกัดตำแหน่งได้";
        if (err?.code === 1) msg = "ผู้ใช้ไม่อนุญาตการเข้าถึงตำแหน่ง (Permission denied)";
        else if (err?.code === 2) msg = "อ่านพิกัดไม่ได้ (Position unavailable)";
        else if (err?.code === 3) msg = "ขอพิกัดนานเกินกำหนด (Timeout)";
        throw new Error(msg);
      });
      const { latitude, longitude, accuracy } = pos.coords;
      setLoc({ lat: latitude, lng: longitude, accuracy });

      // 2) แคปภาพจากกล้อง
      const w = videoRef.current.videoWidth;
      const h = videoRef.current.videoHeight;
      if (!w || !h) throw new Error("ไม่พบขนาดวิดีโอจากกล้อง");

      const c = canvasRef.current;
      c.width = w; c.height = h;
      const ctx = c.getContext("2d");
      if (!ctx) throw new Error("ไม่สามารถสร้าง context ของ canvas");
      ctx.drawImage(videoRef.current, 0, 0, w, h);

      const blob: Blob = await new Promise((res, rej) =>
        c.toBlob(b => b ? res(b) : rej(new Error("แปลงภาพไม่สำเร็จ")), "image/jpeg", 0.9)!
      );

      // 3) สร้าง FormData: file + lat + lng + accuracy
      const fd = new FormData();
      fd.append("file", blob, "frame.jpg");
      fd.append("lat", String(latitude));
      fd.append("lng", String(longitude));
      if (typeof accuracy === "number") fd.append("accuracy", String(accuracy));

      // 4) ยิง API
      const endpoint = action === "in" ? "clock-in" : "clock-out";
      const res = await fetch(`${API}/api/attendance/${endpoint}?th=0.35`, {
        method: "POST",
        // อย่าใส่ Content-Type เองเมื่อใช้ FormData
        headers: authHeader(),
        body: fd
      });

      // 5) จัดการผลลัพธ์
      const data: Resp = await res.json();

      if (res.ok && typeof data.score === "number") {
        setLastScore(data.score);
        setLastUser(data.user ?? null);
        setLastAction(action);
        const who = data.user ? `${data.user.name} <${data.user.email}>` : "unknown user";
        alert(`Clock-${action} success for ${who} • score=${data.score.toFixed(2)}`);
      } else {
        setLastScore(null);
        setLastUser(null);
        setLastAction(null);
        // Backend ส่ง detail มาในกรณีหลุดรัศมี/อื่นๆ
        alert(data.detail ?? `Clock-${action} failed`);
      }
    } catch (e: any) {
      setLocError(e?.message ?? "เกิดข้อผิดพลาด");
      alert(e?.message ?? "เกิดข้อผิดพลาด");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main style={{maxWidth:800, margin:"40px auto", fontFamily:"system-ui"}}>
      <h1>Clock-in / Clock-out</h1>

      <video
        ref={videoRef}
        autoPlay
        playsInline
        style={{width:"100%", maxWidth:640, borderRadius:12, border:"1px solid #ddd"}}
      />

      <div style={{marginTop:12, display:"flex", gap:8}}>
        <button onClick={() => send("in")} disabled={busy}>
          {busy ? "Processing..." : "Clock-in"}
        </button>
        <button onClick={() => send("out")} disabled={busy}>
          {busy ? "Processing..." : "Clock-out"}
        </button>
      </div>

      <canvas ref={canvasRef} style={{display:"none"}} />

      {/* แสดงสถานะพิกัดล่าสุด */}
      <div style={{marginTop:12, padding:12, border:"1px solid #eee", borderRadius:10}}>
        <b>Location:</b>{" "}
        {loc
          ? <>lat {loc.lat.toFixed(6)}, lng {loc.lng.toFixed(6)} {typeof loc.accuracy === "number" ? `(±${Math.round(loc.accuracy)} m)` : ""}</>
          : <i>ยังไม่อ่านพิกัด</i>}
        {locError && <div style={{color:"#b00020", marginTop:6}}>{locError}</div>}
      </div>

      {/* สรุปผลล่าสุด */}
      {lastScore !== null && (
        <div style={{marginTop:12, padding:12, border:"1px solid #eee", borderRadius:10}}>
          <p style={{margin:0}}>
            <b>Last:</b> {lastAction?.toUpperCase()} •{" "}
            {lastUser ? (
              <span>{lastUser.name} &lt;{lastUser.email}&gt;</span>
            ) : (
              <span>unknown</span>
            )}
          </p>
          <p style={{margin:"6px 0 0 0"}}>Score: {lastScore.toFixed(2)}</p>
        </div>
      )}
    </main>
  );
}
