import { useEffect } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext.jsx';
import { clearPostLoginRedirect, postLoginRedirectTarget } from '../auth/cognitoHostedUi.js';

export default function LoginPage() {
  const { isAuthenticated, loading, error, signIn, setError } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    if (!loading && isAuthenticated) {
      const target = postLoginRedirectTarget() || '/dashboard';
      clearPostLoginRedirect();
      navigate(target, { replace: true });
    }
  }, [loading, isAuthenticated, navigate]);

  if (loading) {
    return (
      <div className="auth-shell auth-shell--loading">
        <div className="auth-bg-pattern" aria-hidden="true" />
        <div className="spinner" aria-label="Loading" />
        <p className="auth-message">Checking sign-in…</p>
      </div>
    );
  }

  if (isAuthenticated) {
    return <Navigate to="/dashboard" replace />;
  }

  return (
    <div className="auth-shell">
      <div className="auth-bg-pattern" aria-hidden="true" />
      <div className="auth-card">
        <div className="auth-brand">
          <div className="auth-logo" aria-hidden="true">
            🦘
          </div>
          <div>
            <h1>Aussie EcoLens</h1>
            <p className="auth-subtitle" style={{ margin: 0 }}>
              Wildlife media platform
            </p>
          </div>
        </div>

        <p className="auth-subtitle">
          Sign in to upload observations, search by species tags, and manage your media library.
        </p>

        {error ? (
          <p className="auth-error" role="alert">
            {error}
          </p>
        ) : null}

        <button type="button" className="btn-primary btn-block" onClick={() => signIn()}>
          Sign in with Cognito
        </button>

        <p className="auth-hint">
          Secure authentication via AWS Cognito Hosted UI. New users can register on the sign-in page.
        </p>

        {error ? (
          <button type="button" className="btn-link" onClick={() => setError(null)}>
            Dismiss message
          </button>
        ) : null}
      </div>
    </div>
  );
}
