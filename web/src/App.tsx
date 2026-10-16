import { Navigate, NavLink, Route, Routes, useLocation } from "react-router";
import { useAuth } from "./auth";
import { LoginPage } from "./pages/Login";
import { CatalogPage } from "./pages/Catalog";
import { InventoryPage } from "./pages/Inventory";

export function App() {
  const { state, logout } = useAuth();
  const location = useLocation();

  if (state.status === "loading") return <div className="center muted">Restoring session…</div>;

  if (state.status === "anon") {
    if (location.pathname !== "/login") return <Navigate to="/login" replace state={{ from: location.pathname }} />;
    return <LoginPage notice={state.notice} />;
  }

  const user = state.user;
  const isAdmin = user.role === "admin";

  return (
    <div className="app">
      <header className="header">
        <div className="brand">
          <strong>{user.tenantName}</strong>
          <span className="muted">pharmacy portal</span>
        </div>
        <nav className="tabs">
          <NavLink to="/inventory">Inventory</NavLink>
          {isAdmin && <NavLink to="/catalog">Catalog</NavLink>}
        </nav>
        <div className="who">
          <span>{user.email}</span>
          <span className={`badge badge-${user.role}`}>{user.role}</span>
          <button className="secondary" onClick={() => void logout()}>
            Logout
          </button>
        </div>
      </header>
      <main className="main">
        <Routes>
          <Route path="/inventory" element={<InventoryPage />} />
          <Route
            path="/catalog"
            element={
              isAdmin ? (
                <CatalogPage />
              ) : (
                <div className="notice error">
                  <strong>Not authorized.</strong> The catalog page is for admins only; you are logged in as a{" "}
                  <code>{user.role}</code>.
                </div>
              )
            }
          />
          <Route path="*" element={<Navigate to="/inventory" replace />} />
        </Routes>
      </main>
    </div>
  );
}
