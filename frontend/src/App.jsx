import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider, useAuth } from './auth/AuthContext.jsx';
import { clearPostLoginRedirect, postLoginRedirectTarget } from './auth/cognitoHostedUi.js';
import RequireAuth from './auth/RequireAuth.jsx';
import LoginPage from './pages/LoginPage.jsx';
import DashboardPage from './pages/DashboardPage.jsx';
import './app.css';

function HomeRedirect() {
  const { loading, isAuthenticated } = useAuth();

  if (loading) {
    return (
      <div className="auth-shell auth-shell--loading">
        <div className="auth-bg-pattern" aria-hidden="true" />
        <div className="spinner" aria-label="Loading" />
        <p className="auth-message">Signing you in…</p>
      </div>
    );
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }

  const target = postLoginRedirectTarget() || '/dashboard';
  clearPostLoginRedirect();
  return <Navigate to={target} replace />;
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          <Route path="/" element={<HomeRedirect />} />
          <Route path="/login" element={<LoginPage />} />
          <Route
            path="/dashboard"
            element={
              <RequireAuth>
                <DashboardPage />
              </RequireAuth>
            }
          />
          <Route path="*" element={<Navigate to="/dashboard" replace />} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}
