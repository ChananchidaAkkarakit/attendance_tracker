import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/router";
import { API, authHeader } from "@/lib/api";
import { kalnia } from "./_app";

type Snap = { file: File; url: string };
type RecogResp =
  | { found: true; score: number; user: { id: number; name: string; email: string } }
  | { found: false; score: number };

type Department = { id: number; name: string; lat: number; lng: number; radius_m: number };

type Attempt = {
  id: number;
  ts: string;
  user_id: number | null;
  email: string | null;
  action: "in" | "out";
  success: boolean;
  reason?: string | null;
  score?: number | null;
  lat?: number | null;
  lng?: number | null;
  accuracy?: number | null;
  distance_m?: number | null;
  department_id?: number | null;
  client_ip?: string | null;
  user_agent?: string | null;
  slot?: "morning" | "noon" | "afternoon" | "evening"; // ✅
};

function fmtTs(ts: string) {
  // ถ้า API ส่งมาไม่มี Z → เติม Z ให้เป็น UTC
  const iso = /Z$/.test(ts) ? ts : ts + "Z";
  const d = new Date(iso);
  return new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium",
    timeStyle: "medium",
    timeZone: "Asia/Bangkok",
  }).format(d);
}

const fmtNum = (n?: number | null, d = 2) => (typeof n === "number" ? n.toFixed(d) : "-");

function decodeNameFromJWT(token: string | null) {
  if (!token) return null;
  try {
    const payload = JSON.parse(
      atob((token.split(".")[1] ?? "").replace(/-/g, "+").replace(/_/g, "/"))
    );
    return payload?.name || payload?.username || payload?.sub || null;
  } catch {
    return null;
  }
}

export default function AdminUserManagement() {
  const router = useRouter();

  // ===== name on header (like clock-in) =====
  const [adminName, setAdminName] = useState<string>("");

  // camera
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);

  // forms
  const [regEmail, setRegEmail] = useState("");
  const [regName, setRegName] = useState("");
  const [regPw, setRegPw] = useState("");
  const [regDepartmentId, setRegDepartmentId] = useState<string>("");

  const [enrollEmail, setEnrollEmail] = useState("");
  const [snaps, setSnaps] = useState<Snap[]>([]);
  const [busy, setBusy] = useState(false);

  // departments
  const [deps, setDeps] = useState<Department[]>([]);
  const [loadingDeps, setLoadingDeps] = useState(true);

  // logs
  const [attempts, setAttempts] = useState<Attempt[]>([]);
  const [loadingAttempts, setLoadingAttempts] = useState(false);

  // modals
  const [openDeptModal, setOpenDeptModal] = useState(false);
  const [openLogModal, setOpenLogModal] = useState(false);

  // create department modal form
  const [depName, setDepName] = useState("");
  const [depLat, setDepLat] = useState("");
  const [depLng, setDepLng] = useState("");
  const [depRadius, setDepRadius] = useState("200");

  // recognize
  const [lastRecognized, setLastRecognized] =
    useState<{ name: string; email: string; score: number } | null>(null);

  // ===== guard + load name =====
  useEffect(() => {
    const role = typeof window !== "undefined" ? localStorage.getItem("role") : null;
    if (role !== "admin") {
      alert("Admin only");
      router.replace("/login");
      return;
    }
    const stored = localStorage.getItem("name");
    const token = localStorage.getItem("token");
    setAdminName(stored || decodeNameFromJWT(token) || "Admin");

    // prefetch เพื่อความลื่น
    router.prefetch("/clock");
  }, [router]);

  // ===== departments =====
  async function loadDepartments() {
    setLoadingDeps(true);
    try {
      const res = await fetch(`${API}/api/admin/departments`, { headers: authHeader() });
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      const items: Department[] = data.items || data.departments || [];
      setDeps(items);
    } catch {
      setDeps([]);
    } finally {
      setLoadingDeps(false);
    }
  }
  useEffect(() => { loadDepartments(); }, []);

  // ===== camera =====
  async function startCamera() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      streamRef.current = stream;
      if (videoRef.current) videoRef.current.srcObject = stream;
    } catch (e) {
      alert("เปิดกล้องไม่สำเร็จ: " + (e as Error).message);
    }
  }
  function stopCamera() {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    if (videoRef.current) (videoRef.current as any).srcObject = null;
  }
  useEffect(() => { startCamera(); return () => stopCamera(); }, []);

  // capture helpers
  async function capture() {
    const v = videoRef.current, c = canvasRef.current;
    if (!v || !c) return;
    const vw = v.videoWidth, vh = v.videoHeight;
    if (!vw || !vh) return;
    const maxW = 640, scale = Math.min(1, maxW / vw);
    const w = Math.round(vw * scale), h = Math.round(vh * scale);
    c.width = w; c.height = h;
    const ctx = c.getContext("2d"); if (!ctx) return;
    ctx.drawImage(v, 0, 0, w, h);
    const blob: Blob = await new Promise((res) => c.toBlob((b) => res(b as Blob), "image/jpeg", 0.9)!);
    const file = new File([blob], `snap_${Date.now()}.jpg`, { type: "image/jpeg" });
    const url = URL.createObjectURL(blob);
    setSnaps((prev) => [...prev, { file, url }]);
  }
  function removeSnap(idx: number) {
    setSnaps(prev => { const cp = [...prev]; URL.revokeObjectURL(cp[idx].url); cp.splice(idx, 1); return cp; });
  }
  function clearSnaps() { snaps.forEach(s => URL.revokeObjectURL(s.url)); setSnaps([]); setLastRecognized(null); }
  async function burst(n = 5, delayMs = 600) {
    for (let i = 0; i < n; i++) { await capture(); await new Promise(r => setTimeout(r, delayMs)); }
  }

  // ===== API helpers =====
  async function createUserOnly(): Promise<number> {
    if (!regEmail || !regName || !regPw) { alert("กรอก Email/Name/Password ให้ครบ"); throw new Error("missing fields"); }
    const fd = new FormData(); fd.append("email", regEmail); fd.append("name", regName); fd.append("password", regPw);
    const res = await fetch(`${API}/api/admin/users`, { method: "POST", headers: authHeader(), body: fd });
    const data = await res.json(); if (!res.ok) throw new Error(data?.detail ?? "Create user failed");
    return data.id as number;
  }
  async function assignDepartment(userId: number, departmentId: number) {
    const r = await fetch(`${API}/api/admin/assign-department`, {
      method: "POST", headers: { ...authHeader(), "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: userId, department_id: departmentId }),
    });
    const d = await r.json(); if (!r.ok) throw new Error(d?.detail ?? "Assign department failed");
  }
  async function enrollOnly(targetEmail: string) {
    if (!targetEmail) return alert("กรอกอีเมลผู้ใช้ที่จะ enroll");
    if (snaps.length < 3) return alert("ถ่ายอย่างน้อย 3 รูป เพื่อความแม่นยำ");
    const fd = new FormData(); fd.append("email", targetEmail); snaps.forEach(s => fd.append("files", s.file));
    const res = await fetch(`${API}/api/admin/enroll`, { method: "POST", headers: authHeader(), body: fd });
    const text = await res.text(); if (!res.ok) throw new Error(text); return text;
  }
  async function recognizeNow() {
    if (!snaps.length) return alert("ถ่ายอย่างน้อย 1 รูปก่อน");
    setBusy(true);
    try {
      const fd = new FormData(); fd.append("file", snaps[0].file);
      const res = await fetch(`${API}/api/admin/recognize?th=0.35`, { method: "POST", headers: authHeader(), body: fd });
      const data: RecogResp = await res.json();
      if (!res.ok) throw new Error((data as any)?.detail ?? "recognize failed");
      if (data.found) {
        setLastRecognized({ name: data.user.name, email: data.user.email, score: data.score });
        setEnrollEmail(data.user.email);
        alert(`พบผู้ใช้: ${data.user.name} <${data.user.email}> (score=${data.score.toFixed(2)})`);
      } else { setLastRecognized(null); alert(`ยังไม่พบผู้ใช้ที่ตรง (score=${data.score.toFixed(2)})`); }
    } catch (e: any) { alert(e.message ?? e); } finally { setBusy(false); }
  }

  async function onCreateUser() {
    try {
      setBusy(true);
      const userId = await createUserOnly();
      alert(`Create User สำเร็จ (id=${userId})`);
      if (regDepartmentId) { await assignDepartment(userId, Number(regDepartmentId)); alert("Assign department สำเร็จ"); }
      setEnrollEmail(regEmail);
    } catch (e: any) {
      if (String(e.message || "").toLowerCase().includes("exists")) {
        alert("อีเมลนี้มีอยู่แล้ว (จะข้ามการสร้างผู้ใช้)"); setEnrollEmail(regEmail);
      } else { alert(e.message ?? e); }
    } finally { setBusy(false); }
  }
  async function onEnroll() {
    try { setBusy(true); const msg = await enrollOnly(enrollEmail); alert(`Enroll สำเร็จ: ${msg}`); clearSnaps(); }
    catch (e: any) { alert(e.message ?? e); } finally { setBusy(false); }
  }
  async function onCreateAndEnroll() {
    try {
      setBusy(true);
      let userId: number | null = null;
      try { userId = await createUserOnly(); }
      catch (e: any) { if (!String(e.message || "").toLowerCase().includes("exists")) throw e; }
      if (userId && regDepartmentId) await assignDepartment(userId, Number(regDepartmentId));
      const email = enrollEmail || regEmail; if (!email) throw new Error("ไม่มีอีเมลเป้าหมายสำหรับ enroll");
      const msg = await enrollOnly(email);
      alert(`Create + Enroll สำเร็จ: ${msg}`); clearSnaps(); if (!enrollEmail) setEnrollEmail(email);
    } catch (e: any) { alert(e.message ?? e); } finally { setBusy(false); }
  }

  // ===== department modal submit =====
  async function onCreateDepartment(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!depName || !depLat || !depLng) return alert("กรอกชื่อ/lat/lng ให้ครบ");
    try {
      setBusy(true);
      const payload = { name: depName.trim(), lat: Number(depLat), lng: Number(depLng), radius_m: Number(depRadius) || 200 };
      const res = await fetch(`${API}/api/admin/departments`, {
        method: "POST", headers: { ...authHeader(), "Content-Type": "application/json" }, body: JSON.stringify(payload),
      });
      const data = await res.json(); if (!res.ok) throw new Error(data?.detail ?? "Create department failed");
      alert(`สร้างแผนกสำเร็จ: ${data?.department?.name ?? depName}`);
      setDepName(""); setDepLat(""); setDepLng(""); setDepRadius("200");
      await loadDepartments(); setOpenDeptModal(false);
    } catch (e: any) { alert(e.message ?? e); } finally { setBusy(false); }
  }

  // ===== logs modal =====
  async function loadAttempts() {
    setLoadingAttempts(true);
    try {
      const url = new URL(`${API}/api/admin/attendance-attempts`);
      url.searchParams.set("days", "7");
      const res = await fetch(url.toString(), { headers: authHeader() });
      if (res.status === 401) { alert("ต้องเป็นแอดมินและต้องส่ง Bearer token"); router.replace("/login"); return; }
      const data = await res.json();
      const items: Attempt[] = (data && (data.items ?? data)) || [];
      setAttempts(items);
    } catch (e: any) { alert(e.message ?? e); setAttempts([]); }
    finally { setLoadingAttempts(false); }
  }
  useEffect(() => { if (openLogModal) loadAttempts(); }, [openLogModal]);

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
                  router.push("/admin-home"); // fallback ถ้าไม่มี history
                }
              }}
              aria-label="Back"
              className="rounded-full border border-[#BFD0E0] bg-white/80 p-2.5 text-[#6E8197] shadow-sm transition hover:bg-white"
            >
              <svg
                viewBox="0 0 24 24"
                className="h-6 w-6"
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
              Hi, {adminName || "…"}
            </h1>
          </div>

          <div className="flex flex-wrap gap-3">
            <button
              className="rounded-full border border-[#BFD0E0] bg-white/80 px-6 py-3.5 text-[15px] text-[#6E8197] shadow-sm transition hover:bg-white"
              onClick={() => setOpenDeptModal(true)}
            >
              Create Department/Site
            </button>
            <button
              className="rounded-full border border-[#BFD0E0] bg-white/80 px-6 py-3.5 text-[15px] text-[#6E8197] shadow-sm transition hover:bg-white"
              onClick={() => setOpenLogModal(true)}
            >
              View Log
            </button>
            <button
              onClick={() => { localStorage.clear(); router.push("/login"); }}
              className="rounded-full border border-[#BFD0E0] bg-white/80 px-6 py-3.5 text-[15px] text-[#6E8197] shadow-sm transition hover:bg-white"
            >
              Logout
            </button>
          </div>
        </div>

        {/* title bar */}
        <div className={`mb-8 rounded-2xl bg-white py-5 text-center text-2xl sm:text-3xl font-medium text-[#809CBB] shadow-sm ${kalnia.className}`}>
          User Management
        </div>

        {/* main grid */}
        <div className="mt-6 grid gap-16 md:grid-cols-[1fr,2fr]">
          {/* Create User */}
          <section className="rounded-3xl bg-[#E9EEF3] p-6 shadow-sm">
            <h2 className={`mb-4 text-[15px] sm:text-[20px] font-medium leading-none text-[#809CBB] ${kalnia.className}`}> Create User (Register)</h2>
            <div className="grid gap-3">
              <input
                className="rounded-[23px] flex justify-center border border-[#C3D0DF] text-[#475c74] placeholder-[#809CBB] bg-white px-4 py-3.5 outline-none focus:border-[#809CBB] focus:ring-2 focus:ring-[#809CBB]/20"
                placeholder="Username (Email)"
                value={regEmail}
                onChange={(e) => setRegEmail(e.target.value)}
              />
              <input
                className="rounded-[23px] flex justify-center border border-[#C3D0DF] text-[#475c74] placeholder-[#809CBB] bg-white px-4 py-3.5 outline-none focus:border-[#809CBB] focus:ring-2 focus:ring-[#809CBB]/20"
                placeholder="Display Name"
                value={regName}
                onChange={(e) => setRegName(e.target.value)}
              />
              <input
                className="rounded-[23px] flex justify-center border border-[#C3D0DF] text-[#475c74] placeholder-[#809CBB] bg-white px-4 py-3.5 outline-none focus:border-[#809CBB] focus:ring-2 focus:ring-[#809CBB]/20"
                placeholder="Password"
                type="password"
                value={regPw}
                onChange={(e) => setRegPw(e.target.value)}
              />
              <div className="relative">
                <select
                  className="w-full appearance-none rounded-[23px] flex justify-center border border-[#C3D0DF] bg-white
               px-4 py-3.5 pr-12 text-[#475c74] outline-none
               focus:border-[#809CBB] focus:ring-2 focus:ring-[#809CBB]/20"
                  value={regDepartmentId}
                  onChange={(e) => setRegDepartmentId(e.target.value)}
                >
                  <option value="">{loadingDeps ? "Loading departments..." : "(Department / Position)"}</option>
                  {deps.map((d) => (
                    <option key={d.id} value={d.id}>{d.name}</option>
                  ))}
                </select>

                {/* ไอคอนลูกศรขวา เว้นจากขอบเล็กน้อย */}
                <svg
                  className="pointer-events-none absolute right-3 top-1/2 h-5 w-5 -translate-y-1/2 text-[#809CBB]"
                  viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                  strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
                >
                  <path d="M6 9l6 6 6-6" />
                </svg>
              </div>

              <button
                onClick={onCreateUser}
                disabled={busy}
                className={`mb-13 rounded-[23px] py-3.5 text-center text-[15px] sm:text-[20px] font-semibold shadow-sm  bg-[#6E8197] px-5  text-white hover:bg-[#6E8197] disabled:opacity-50 ${kalnia.className}`}
              >
                {busy ? "Processing..." : "Create"}
              </button>

              <p className="text-sm text-slate-500">
                * When you click on Create User, Username in the Face Registration field will appear automatically.
              </p>
            </div>
          </section>

          {/* Enroll Face */}
          <section className="rounded-3xl bg-[#E9EEF3] p-6 shadow-sm">
            <h2 className={`mb-4 text-[15px] sm:text-[20px] font-medium leading-none text-[#809CBB] ${kalnia.className}`}>Enroll Face</h2>

            <input
              className="w-full rounded-[23px] flex justify-center border border-[#C3D0DF] text-[#809CBB] placeholder-[#809CBB] bg-white px-4 py-3.5 mb-3 outline-none focus:border-[#809CBB] focus:ring-2 focus:ring-[#809CBB]/20"
              placeholder="Username (Email)"
              value={enrollEmail}
              onChange={(e) => setEnrollEmail(e.target.value)}
            />

            <div className="mx-36 mb-3 grid h-64 place-items-center overflow-hidden rounded-xl border border-dashed border-slate-300 bg-[#f3f6fa]">
              <video ref={videoRef} autoPlay playsInline className="h-full w-full object-cover" />
            </div>

            {/* buttons */}
            <div className="mt-3 flex flex-wrap gap-2">
              {/* <button onClick={startCamera} className="rounded-lg border border-gray-300 bg-white px-4 py-2 hover:bg-gray-100">
                Start Camera
              </button> */}
              <button onClick={capture} className="rounded-3xl border text-[#809CBB] border-[#C3D0DF] bg-white px-4 py-2 hover:bg-slate-50">
                Capture
              </button>
              <button onClick={() => burst(5, 600)} className="rounded-3xl border text-[#809CBB] border-[#C3D0DF] bg-white px-4 py-2 hover:bg-slate-50">
                Auto-Capture x5
              </button>
              <button
                onClick={recognizeNow}
                disabled={busy || !snaps.length}
                className="rounded-3xl border text-[#809CBB] border-[#C3D0DF] bg-white px-4 py-2 hover:bg-slate-50 disabled:opacity-50"
              >
                Recognize Now
              </button>
              <button
                onClick={clearSnaps}
                disabled={!snaps.length}
                className="rounded-3xl border text-[#809CBB] border-[#C3D0DF] bg-white px-4 py-2 hover:bg-slate-50 disabled:opacity-50"
              >
                Clear
              </button>
              <button
                onClick={onEnroll}
                disabled={busy || !snaps.length}
                className="rounded-3xl border text-[#809CBB] border-[#C3D0DF] bg-white px-4 py-2 hover:bg-slate-50 disabled:opacity-50"
              >
                Upload & Enroll
              </button>
              <button
                onClick={onCreateAndEnroll}
                disabled={busy || !snaps.length}
                className="rounded-3xl border text-[#809CBB] border-[#C3D0DF] bg-white px-4 py-2 hover:bg-slate-50 disabled:opacity-50"
              >
                {busy ? "Processing..." : "Create & Enroll"}
              </button>
            </div>

            {lastRecognized && (
              <div className="mt-3 rounded-xl border border-slate-200 bg-white p-3 text-sm">
                <b>Found user:</b> {lastRecognized.name} &lt;{lastRecognized.email}&gt; • Score: {lastRecognized.score.toFixed(2)}
              </div>
            )}

            {snaps.length > 0 && (
              <>
                <h4 className="mt-4 text-[#6E8197]">Pictures that can be taken ({snaps.length})</h4>
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
                  {snaps.map((s, i) => (
                    <div key={i} className="rounded-lg border border-slate-200 p-2 text-center">
                      <img src={s.url} alt={`snap ${i}`} className="w-full rounded-md" />
                      <button
                        onClick={() => removeSnap(i)}
                        className="mt-2 rounded-full text-[#809CBB] border border-gray-300 bg-white px-3 py-1 text-sm hover:bg-gray-100"
                      >
                        Delete
                      </button>
                    </div>
                  ))}
                </div>
              </>
            )}

            <canvas ref={canvasRef} className="hidden" />
            <p className="mt-3 text-sm text-slate-500">
              The camera must be running on https or http://localhost.
            </p>
          </section>
        </div>
      </section>

      {/* ===== Department Modal ===== */}
      {openDeptModal && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/30 p-3">
          <div className="w-[min(720px,96vw)] rounded-2xl bg-white p-5 shadow-2xl">
            <div className="mb-3 flex items-center justify-between">
              <h3 className={`mb-4 text-[15px] sm:text-[20px] font-medium leading-none text-[#809CBB] ${kalnia.className}`}>Create Department / Site</h3>
              <button className="rounded-full border border-[#BFD0E0] bg-white/80 px-6 py-3.5 text-[15px] text-[#6E8197] shadow-sm transition hover:bg-slate-200 " onClick={() => setOpenDeptModal(false)}>
                Close
              </button>
            </div>
            <form onSubmit={onCreateDepartment} className="grid gap-3">
              <input
                className="rounded-[23px] flex justify-center border border-[#C3D0DF] text-[#475c74] placeholder-[#809CBB] bg-white px-4 py-3.5 outline-none focus:border-[#809CBB] focus:ring-2 focus:ring-[#809CBB]/20"
                placeholder="Dapartment Name"
                value={depName}
                onChange={(e) => setDepName(e.target.value)}
              />
              <div className="grid grid-cols-2 gap-3">
                <input
                  className="rounded-[23px] flex justify-center border border-[#C3D0DF] text-[#475c74] placeholder-[#809CBB] bg-white px-4 py-3.5 outline-none focus:border-[#809CBB] focus:ring-2 focus:ring-[#809CBB]/20"
                  placeholder="Latitude"
                  value={depLat}
                  onChange={(e) => setDepLat(e.target.value)}
                />
                <input
                  className="rounded-[23px] flex justify-center border border-[#C3D0DF] text-[#475c74] placeholder-[#809CBB] bg-white px-4 py-3.5 outline-none focus:border-[#809CBB] focus:ring-2 focus:ring-[#809CBB]/20"
                  placeholder="Longitude"
                  value={depLng}
                  onChange={(e) => setDepLng(e.target.value)}
                />
              </div>
              <input
                className="rounded-[23px] flex justify-center border border-[#C3D0DF] text-[#475c74] placeholder-[#809CBB] bg-white px-4 py-3.5 outline-none focus:border-[#809CBB] focus:ring-2 focus:ring-[#809CBB]/20"
                placeholder="Radius (m)"
                value={depRadius}
                onChange={(e) => setDepRadius(e.target.value)}
              />
              <button
                type="submit"
                disabled={busy}
                className={`rounded-[23px] border border-[#BFD0E0] bg-[#6E8197] px-6 py-3.5 text-[18px] text-[#FFFBF0] shadow-sm transition hover:bg-white disabled:opacity-50 ${kalnia.className}`}
              >
                {busy ? "Saving..." : "Create"}
              </button>

              <div className="text-md text-slate-600">
                Existing Department / Site:
                <ul className="mt-2 list-disc space-y-1 pl-5">
                  {deps.map((d) => (
                    <li key={d.id}>{d.name} — lat {d.lat}, lng {d.lng}, r={d.radius_m}m</li>
                  ))}
                </ul>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ===== Logs Modal ===== */}
      {openLogModal && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/30 p-3">
          <div className="w-[min(1000px,96vw)] rounded-2xl bg-white p-5 shadow-2xl">
            <div className="mb-3 flex items-center justify-between">
              <h3 className={`mb-4 text-[15px] sm:text-[20px] font-medium leading-none text-[#809CBB] ${kalnia.className}`}>Attendance Logs (7 days)</h3>
              <div className="flex gap-4">
                <button
                  onClick={loadAttempts}
                  disabled={loadingAttempts}
                  className="rounded-full border border-[#BFD0E0] bg-white/80 px-6 py-3.5 text-[15px] text-[#6E8197] shadow-sm transition hover:bg-slate-200 disabled:opacity-50"
                >
                  {loadingAttempts ? "Loading..." : "Refresh"}
                </button>
                <button
                  className="rounded-full border border-[#BFD0E0] bg-white/80 px-6 py-3.5 text-[15px] text-[#6E8197] shadow-sm transition hover:bg-slate-200 "
                  onClick={() => setOpenLogModal(false)}
                >
                  Close
                </button>
              </div>
            </div>

            <div className="max-h-[70vh] overflow-auto rounded-xl border border-slate-200">
              {!attempts.length ? (
                <div className="p-4 text-slate-500">{loadingAttempts ? "Loading..." : "No data"}</div>
              ) : (
                <table className="min-w-[900px] w-full border-collapse text-sm">
                  <thead className="bg-slate-50">
                    <tr>
                      {["Time", "Email", "Action", "Slot", "Success", "Score", "Lat", "Lng", "Acc (m)", "Dist (m)", "Reason",].map((h) => (
                        <th key={h} className="border-b border-slate-200 px-3 py-2 text-left">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {attempts.map((a) => (
                      <tr key={a.id} className="odd:bg-white even:bg-slate-50/30">
                        <td className="border-b border-slate-100 px-3 py-2">{fmtTs(a.ts)}</td>
                        <td className="border-b border-slate-100 px-3 py-2">{a.email ?? "-"}</td>
                        <td className="border-b border-slate-100 px-3 py-2">{a.action}</td>
                        <td className="border-b border-slate-100 px-3 py-2">{a.slot ?? "-"}</td>
                        <td className="border-b border-slate-100 px-3 py-2">{a.success ? "✅" : "❌"}</td>
                        <td className="border-b border-slate-100 px-3 py-2">{fmtNum(a.score)}</td>
                        <td className="border-b border-slate-100 px-3 py-2">{fmtNum(a.lat, 5)}</td>
                        <td className="border-b border-slate-100 px-3 py-2">{fmtNum(a.lng, 5)}</td>
                        <td className="border-b border-slate-100 px-3 py-2">{a.accuracy ?? "-"}</td>
                        <td className="border-b border-slate-100 px-3 py-2">{a.distance_m ?? "-"}</td>
                        <td className="border-b border-slate-100 px-3 py-2 max-w-[280px] whitespace-pre-wrap">{a.reason ?? "-"}</td>

                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
