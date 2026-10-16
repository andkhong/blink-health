import { useState, type FormEvent } from "react";
import { useLocation, useNavigate } from "react-router";
import { useAuth } from "../auth";
import { errorMessage } from "../api";

// Seed accounts from API.md (local test tool, so quick-fill is fine).
const SEED_PASSWORD = "password123";
const SEED_ACCOUNTS = [
  { email: "admin@cvs.test", tenant: "CVS", role: "admin" },
  { email: "user@cvs.test", tenant: "CVS", role: "user" },
  { email: "admin@walgreens.test", tenant: "Walgreens", role: "admin" },
  { email: "user@walgreens.test", tenant: "Walgreens", role: "user" },
] as const;

export function LoginPage({ notice }: { notice?: string }) {
  const { login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function doLogin(e: string, p: string) {
    setBusy(true);
    setError(null);
    try {
      await login(e, p);
      const from = (location.state as { from?: string } | null)?.from;
      navigate(from && from !== "/login" ? from : "/inventory", { replace: true });
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    void doLogin(email, password);
  }

  return (
    <div className="login">
      <h1>Pharmacy inventory portal</h1>
      {notice && <div className="notice warn">{notice}</div>}
      <form onSubmit={onSubmit} className="card">
        <label>
          Email
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" required />
        </label>
        <label>
          Password
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
          />
        </label>
        <button type="submit" disabled={busy}>
          {busy ? "Logging in…" : "Log in"}
        </button>
        {error && <div className="error-text">{error}</div>}
      </form>

      <div className="card">
        <h3>Seed accounts</h3>
        <p className="muted small">
          Password for all: <code>{SEED_PASSWORD}</code>. "Fill" populates the form; "Log in" signs in directly.
        </p>
        <table>
          <thead>
            <tr>
              <th>Email</th>
              <th>Tenant</th>
              <th>Role</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {SEED_ACCOUNTS.map((a) => (
              <tr key={a.email}>
                <td>
                  <code>{a.email}</code>
                </td>
                <td>{a.tenant}</td>
                <td>
                  <span className={`badge badge-${a.role}`}>{a.role}</span>
                </td>
                <td className="actions">
                  <button
                    type="button"
                    className="secondary"
                    disabled={busy}
                    onClick={() => {
                      setEmail(a.email);
                      setPassword(SEED_PASSWORD);
                    }}
                  >
                    Fill
                  </button>
                  <button type="button" disabled={busy} onClick={() => void doLogin(a.email, SEED_PASSWORD)}>
                    Log in
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
