"use client";

import { Eye, EyeOff, LockKeyhole, Mail } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { BrandMark } from "@/components/ui/brand-mark";
import { apiUrl } from "@/lib/api/url";

export default function LoginPage() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);

    try {
      const form = new FormData(event.currentTarget);
      const response = await fetch(apiUrl("/api/auth/login"), {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: form.get("owner-email"),
          password: form.get("owner-password"),
        }),
      });

      if (!response.ok) {
        setError("Invalid email or password.");
        return;
      }

      router.replace("/");
    } catch {
      setError("Could not reach the workspace. Try again in a moment.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="login-page px-4 sm:px-6">
      <div className="login-orb login-orb-primary" aria-hidden="true" />
      <div className="login-orb login-orb-secondary" aria-hidden="true" />

      <section className="login-shell">
        <div className="login-brand">
          <BrandMark />
        </div>

        <form onSubmit={submit} className="login-card" autoComplete="off" noValidate>
          <div className="login-card-heading">
            <span className="login-security-icon" aria-hidden="true">
              <LockKeyhole className="size-4" strokeWidth={2.25} />
            </span>
            <div>
              <p className="text-overline">Secure access</p>
              <h1>Welcome back</h1>
              <p>Sign in to your personal forex workspace.</p>
            </div>
          </div>

          <div className="login-fields">
            <label className="login-field">
              <span>Email address</span>
              <span className="login-input-wrap">
                <Mail className="size-4" aria-hidden="true" />
                <input
                  autoComplete="off"
                  data-1p-ignore="true"
                  data-bwignore="true"
                  data-lpignore="true"
                  name="owner-email"
                  required
                  type="email"
                  placeholder="you@example.com"
                />
              </span>
            </label>

            <label className="login-field">
              <span>Password</span>
              <span className="login-input-wrap">
                <LockKeyhole className="size-4" aria-hidden="true" />
                <input
                  autoComplete="off"
                  data-1p-ignore="true"
                  data-bwignore="true"
                  data-lpignore="true"
                  name="owner-password"
                  required
                  type={showPassword ? "text" : "password"}
                  placeholder="Enter your password"
                />
                <button
                  type="button"
                  className="login-password-toggle"
                  onClick={() => setShowPassword((visible) => !visible)}
                  aria-label={showPassword ? "Hide password" : "Show password"}
                >
                  {showPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                </button>
              </span>
            </label>
          </div>

          {error ? <p className="login-error" role="alert">{error}</p> : null}

          <button disabled={busy} className="login-submit" type="submit">
            {busy ? "Signing in…" : "Sign in to workspace"}
          </button>
        </form>
      </section>
    </main>
  );
}
