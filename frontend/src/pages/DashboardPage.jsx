import { useState } from 'react';
import { getAuthMe } from '../api/client.js';
import { useAuth } from '../auth/AuthContext.jsx';

export default function DashboardPage() {
  const { user, signOut, getToken } = useAuth();
  const [verifyLoading, setVerifyLoading] = useState(false);
  const [verifyResult, setVerifyResult] = useState(null);
  const [verifyError, setVerifyError] = useState(null);

  async function handleVerify() {
    setVerifyLoading(true);
    setVerifyError(null);
    setVerifyResult(null);
    try {
      const token = await getToken();
      if (!token) {
        throw new Error('No token available. Sign in again.');
      }
      const data = await getAuthMe(token);
      setVerifyResult(data);
    } catch (err) {
      setVerifyError(err.message || String(err));
    } finally {
      setVerifyLoading(false);
    }
  }

  return (
    <div className="app-shell">
      <header className="app-topbar">
        <div>
          <h1>Aussie EcoLens</h1>
          <p>Signed in as {user?.email || 'unknown user'}</p>
        </div>
        <div className="app-topbar-actions">
          <button type="button" className="btn-secondary" onClick={handleVerify} disabled={verifyLoading}>
            {verifyLoading ? 'Verifying…' : 'Verify API token'}
          </button>
          <button type="button" className="btn-danger" onClick={() => signOut()}>
            Sign out
          </button>
        </div>
      </header>

      <main className="app-main">
        <section className="app-card">
          <h2>Dashboard</h2>
          <p>Step 2 complete: auth guard and Cognito session are wired. Upload and query UI come in step 3.</p>
          <p>
            <a href="/prototype.html">Open prototype UI</a> for full API testing until step 3 is done.
          </p>
        </section>

        {verifyError ? (
          <section className="app-card app-card-error">
            <h3>Verification failed</h3>
            <pre>{verifyError}</pre>
          </section>
        ) : null}

        {verifyResult ? (
          <section className="app-card">
            <h3>/auth/me response</h3>
            <pre>{JSON.stringify(verifyResult, null, 2)}</pre>
          </section>
        ) : null}
      </main>
    </div>
  );
}
