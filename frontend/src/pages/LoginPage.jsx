import { useEffect } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext.jsx';

export default function LoginPage() {
  const { isAuthenticated, loading, error, signIn, setError } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    if (!loading && isAuthenticated) {
      navigate('/dashboard', { replace: true });
    }
  }, [loading, isAuthenticated, navigate]);

  if (loading) {
    return (
      <div className="auth-shell">
        <p className="auth-message">Loading…</p>
      </div>
    );
  }

  if (isAuthenticated) {
    return <Navigate to="/dashboard" replace />;
  }

  const callback = import.meta.env.VITE_COGNITO_REDIRECT_URI || '(not set)';

  return (
    <div className="auth-shell">
      <div className="auth-card">
        <h1>Aussie EcoLens</h1>
        <p className="auth-subtitle">Sign in to upload media and run wildlife queries.</p>

        {error ? (
          <p className="auth-error" role="alert">
            {error}
          </p>
        ) : null}

        <button type="button" className="btn-primary" onClick={() => signIn()}>
          Sign in with Cognito
        </button>

        <p className="auth-hint">
          After Cognito, you will return to <code>{callback}</code>, then be sent to the React
          dashboard.
        </p>

        <p className="auth-hint">
          Legacy tools: <a href="/prototype.html">prototype UI</a>
        </p>

        <button type="button" className="btn-link" onClick={() => setError(null)}>
          Dismiss message
        </button>
      </div>
    </div>
  );
}
