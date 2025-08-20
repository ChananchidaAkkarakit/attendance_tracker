import { useState } from "react";
import { useRouter } from "next/router";
import { login } from "@/lib/api";
import { Eye, EyeOff, LogIn, ScanFace } from "lucide-react";
import { kalnia } from "./_app";

export default function Login() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      // Expect: { access_token, role, name }
      const data = await login(email, password);
      localStorage.setItem("token", data.access_token);
      localStorage.setItem("role", data.role || "");
      localStorage.setItem("name", data.name || "");

      // Redirect by role
      if (data.role === "admin") {
        router.push("/admin-home");
      } else {
        router.push("/clock");
      }
    } catch (err: any) {
      setError(err?.message ?? "Login failed");
    } finally {
      setLoading(false);
    }
  }

  const supportEmail =
    process.env.NEXT_PUBLIC_SUPPORT_EMAIL || "admin@yourcompany.com";
  const supportPhone =
    process.env.NEXT_PUBLIC_SUPPORT_PHONE || "02-123-4567";

  const [showContact, setShowContact] = useState(false);

  return (
    <div className="min-h-screen bg-[#FFFBF0] flex items-center justify-center p-4">
      <div className="w-full max-w-sm">
        {/* Card */}
        <div className="rounded-3xl border border-slate-200 shadow-sm bg-[#DEE5ED] backdrop-blur p-6 sm:p-8">
          <header className="mb-6">
            <h1 className={`text-2xl font-bold text-[#809CBB] ${kalnia.className}`}>
              Login
            </h1>
            <p className="text-sm text-[#6E8197] mt-1">
              Log in to record your time in or out.
            </p>
          </header>

          {error && (
            <div
              role="alert"
              className="mb-4 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700"
            >
              {error}
            </div>
          )}

          <form onSubmit={onSubmit} className="grid gap-4">
            {/* Username */}
            <label className="block">
              <span className="sr-only">Username</span>
              <div className="relative">
                <input
                  className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 pr-10 text-slate-700 outline-none ring-0 placeholder:text-slate-400 focus:border-slate-400"
                  placeholder="Username"
                  type="text"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  autoComplete="username"
                  required
                />
              </div>
            </label>

            {/* Password */}
            <label className="block">
              <span className="sr-only">Password</span>
              <div className="relative">
                <input
                  className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 pr-12 text-slate-700 outline-none placeholder:text-slate-400 focus:border-slate-400"
                  placeholder="Password"
                  type={showPw ? "text" : "password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="current-password"
                  required
                />
                <button
                  type="button"
                  onClick={() => setShowPw((v) => !v)}
                  className="absolute inset-y-0 right-2 my-auto inline-flex h-9 w-9 items-center justify-center rounded-xl text-slate-400 hover:bg-slate-100"
                  aria-label={showPw ? "Hide password" : "Show password"}
                >
                  {showPw ? <EyeOff className="h-5 w-5" /> : <Eye className="h-5 w-5" />}
                </button>
              </div>
            </label>

            {/* Remember + Forgot */}
            <div className="flex items-center justify-between text-sm">
              <label className="inline-flex items-center gap-2 text-slate-600">
                <input type="checkbox" className="h-4 w-4 rounded border-slate-300" />
                Remember me
              </label>
              <button
                type="button"
                onClick={() => setShowContact(true)}
                className="text-slate-500 hover:text-slate-700 underline underline-offset-2"
              >
                Forgot password?
              </button>
            </div>

            {/* Submit */}
            <button
              type="submit"
              disabled={loading}
              className={`group inline-flex items-center justify-center gap-2 rounded-2xl bg-[#6E8197] px-5 py-3 font-medium text-white shadow-sm transition hover:bg-slate-600 disabled:opacity-60 ${kalnia.className}`}
            >
              <LogIn className="h-5 w-5 transition group-hover:translate-x-0.5" />
              {loading ? "Logging in..." : "Login"}
            </button>
          </form>

          {/* Divider */}
          <div className="my-6 grid grid-cols-[1fr_auto_1fr] items-center gap-3 text-[#809CBB]">
            <div className="h-px bg-[#809CBB]" />
            <span className="text-[15px]">or</span>
            <div className="h-px bg-[#809CBB]" />
          </div>

          {/* Face Scan CTA */}
          <button
            type="button"
            onClick={() => router.push("/facescan")}
            className={`inline-flex w-full items-center justify-center gap-2 rounded-2xl border border-slate-200 bg-white px-5 py-3 font-medium text-[#809CBB] shadow-sm hover:bg-slate-50 ${kalnia.className}`}
          >
            <ScanFace className="h-5 w-5" />
            Face scan clock in/out
          </button>
        </div>

        {/* Footer helper text */}
        <p className="mt-4 text-center text-xs text-slate-400">
          By continuing, you agree to our Terms and Privacy Policy.
        </p>
      </div>

      {/* === Contact Popup (English) === */}
      {showContact && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4"
          onClick={() => setShowContact(false)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl"
          >
            <div className="mb-2 flex items-center justify-between">
              <h3 className={`text-xl font-normal text-[#809CBB] ${kalnia.className}`}>Forgot password</h3>
              <button
                onClick={() => setShowContact(false)}
                className="rounded-full p-2 text-slate-500 hover:bg-slate-100"
                aria-label="Close"
              >
                <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M6 6l12 12M18 6l-12 12" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
            </div>

            <p className="text-slate-600">
              Forgot your password? Please contact your administrator to reset your account.
            </p>

            <div className="mt-4 space-y-2 rounded-xl border border-slate-200 bg-slate-50 p-4">
              <div className="flex items-center gap-2">
                <span className="text-slate-500">Email:</span>
                <a href={`mailto:${supportEmail}`} className="font-medium text-[#6E8197] hover:underline">
                  {supportEmail}
                </a>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-slate-500">Phone:</span>
                <a href={`tel:${supportPhone}`} className="font-medium text-[#6E8197] hover:underline">
                  {supportPhone}
                </a>
              </div>
            </div>

            <div className="mt-4 flex justify-end">
              <button
                onClick={() => setShowContact(false)}
                className="rounded-full border border-[#BFD0E0] bg-slate-200 px-6 py-2.5 text-[15px] text-[#6E8197] shadow-sm transition hover:bg-white/80"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
