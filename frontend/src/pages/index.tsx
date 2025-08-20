// src/pages/admin/index.tsx
import { useEffect } from "react";
import { useRouter } from "next/router";

export default function AdminUsers() {
  const router = useRouter();
  useEffect(() => {
    const role = localStorage.getItem("role");
    if (role !== "admin") router.replace("/login");
  }, [router]);

  return (
    <main className="min-h-screen bg-[#fbf7ec] p-6">
      <div className="mx-auto max-w-5xl rounded-3xl border border-slate-200 bg-white/70 p-6 sm:p-10">
        <h1 className="text-2xl font-semibold text-slate-700">User Management</h1>
        <p className="mt-2 text-slate-500">จัดการผู้ใช้: สร้าง/แก้ไข/ลบ/รีเซ็ตรหัสผ่าน …</p>
        {/* TODO: ใส่ตารางรายชื่อผู้ใช้ + ปุ่ม action ต่าง ๆ */}
      </div>
    </main>
  );
}
