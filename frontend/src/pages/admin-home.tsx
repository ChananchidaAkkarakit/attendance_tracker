// src/pages/admin-home.tsx
import { useRouter } from "next/router";
import { useEffect, useState } from "react";
import { kalnia } from "./_app";

// เหมือนหน้า clock-in: ดึง name จาก JWT ได้
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

export default function AdminHome() {
  const router = useRouter();
  const [adminName, setAdminName] = useState<string>("");

  useEffect(() => {
    const role = typeof window !== "undefined" ? localStorage.getItem("role") : null;
    if (role !== "admin") {
      router.replace("/login");
      return;
    }
    const stored = localStorage.getItem("name");
    const token = localStorage.getItem("token");
    setAdminName(stored || decodeNameFromJWT(token) || "Admin");

    // prefetch ให้ลื่น
    router.prefetch("/clock");
    router.prefetch("/admin");
  }, [router]);

  return (
    <main className="min-h-screen w-full bg-[#FFFBF0] p-10">
      {/* กล่องพื้นฟ้า เว้นขอบ 10px รอบด้าน */}
      <section className="w-full min-h-[calc(100vh-80px)] rounded-[28px] bg-[#DEE5ED] px-6 sm:px-14 py-6 sm:py-8">
        {/* Header */}
        <header className="flex items-center justify-between">
          <h1
            className={`text-[40px] sm:text-[45px] font-semibold leading-none text-[#809CBB] ${kalnia.className}`}
          >
            Hi, {adminName || "…"}
          </h1>

          <button
            onClick={() => {
              localStorage.clear();
              router.push("/login");
            }}
            className="rounded-full border border-[#BFD0E0] bg-white/80 px-6 py-3.5 text-[15px] text-[#6E8197] shadow-sm transition hover:bg-white"
            aria-label="Logout"
          >
            Logout
          </button>
        </header>

        {/* Tiles */}
        <section className="m-32 grid place-items-center justify-center gap-10 sm:grid-cols-2 sm:gap-16">
          {/* Clock-in/out */}
          <button
            onClick={() => router.push("/clock")}
            className="group h-[330px] w-full max-w-md rounded-[32px] border-2 border-[#BFD0E0] bg-white p-8 text-center shadow-sm transition hover:bg-[#6E8197] hover:shadow-md focus:outline-none"
            aria-label="Go to Clock-in & Clock-out"
          >
            <div className="mx-auto mb-16 flex h-[110px] w-[110px] items-center justify-center text-[#809CBB] transition-colors group-hover:text-[#FFFBF0]">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                className="h-full w-full"
                fill="none"
                stroke="currentColor"
                strokeWidth="4"
                strokeLinecap="round"
                strokeLinejoin="round"
                role="img"
                aria-label="Clock"
              >
                <circle cx="55" cy="55" r="50" />
                <path d="M55 25v30l20 10" />
              </svg>
            </div>
            <h3
              className={`text-[24px] sm:text-[35px] font-medium leading-none text-[#809CBB] transition-colors group-hover:text-[#FFFBF0] ${kalnia.className}`}
            >
              Clock-in & clock-out
            </h3>
          </button>

          {/* User Management */}
          <button
            onClick={() => router.push("/admin")}
            className="group h-[330px] w-full max-w-md rounded-[32px] border-2 border-[#BFD0E0] bg-white p-8 text-center shadow-sm transition hover:bg-[#6E8197] hover:shadow-md focus:outline-none"
            aria-label="Go to User Management"
          >
            <div className="mx-auto mb-16 flex h-[110px] w-[110px] items-center justify-center text-[#809CBB] transition-colors group-hover:text-[#FFFBF0]">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 24 24"
                className="h-full w-full"
                role="img"
                aria-label="Users"
              >
                <g
                  fill="none"
                  stroke="currentColor"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth="0.8"
                >
                  <path d="M14.5 7.5a5 5 0 1 0-10 0a5 5 0 0 0 10 0" />
                  <path d="M2.5 19.5a7 7 0 0 1 10-6.326M18 20c.93 0 1.74-.507 2.171-1.26M18 20c-.93 0-1.74-.507-2.171-1.26M18 20v1.5m0-6.5c.93 0 1.74.507 2.17 1.26M18 15c-.93 0-1.74.507-2.17 1.26M18 15v-1.5m3.5 2l-1.33.76M14.5 19.5l1.329-.76m5.671.76l-1.329-.76M14.5 15.5l1.33.76m4.34 0c.21.365.33.788.33 1.24s-.12.875-.329 1.24m-4.342 0a2.5 2.5 0 0 1-.329-1.24c0-.451.12-.875.33-1.24" />
                </g>
              </svg>
            </div>
            <h3
              className={`text-[24px] sm:text-[35px] font-medium leading-none text-[#809CBB] transition-colors group-hover:text-[#FFFBF0] ${kalnia.className}`}
            >
              User Management
            </h3>
          </button>
        </section>
      </section>
    </main>
  );
}
