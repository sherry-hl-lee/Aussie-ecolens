import { useCallback, useEffect, useState } from 'react';
import {
  getAuthConfig,
  listNotificationSubscriptions,
  subscribeNotifications,
  unsubscribeNotifications,
} from '../api/client.js';

export default function NotificationSection({ busy, getToken, onNotice }) {
  const [loading, setLoading] = useState(true);
  const [email, setEmail] = useState('');
  const [snsConfigured, setSnsConfigured] = useState(false);
  const [subscriptions, setSubscriptions] = useState([]);
  const [tagsInput, setTagsInput] = useState('canis dingo, megapodius reinwardt');
  const [error, setError] = useState(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const token = await getToken();
      if (!token) {
        setError('Your session has expired. Sign out (top right), then sign in again.');
        setLoading(false);
        return;
      }
      const [config, data] = await Promise.all([getAuthConfig(), listNotificationSubscriptions(token)]);
      setSnsConfigured(Boolean(config?.snsConfigured ?? data.snsConfigured));
      setEmail(data.email || '');
      setSubscriptions(Array.isArray(data.subscriptions) ? data.subscriptions : []);
    } catch (err) {
      const msg = err?.message || 'Failed to load subscriptions';
      if (err?.status === 401 || String(msg).includes('401')) {
        setError('Authentication failed (401). Sign out, sign in again, then try Subscribe.');
      } else if (err?.status === 500 || String(msg).includes('500')) {
        setError(
          'Server error (500). Often the ecolens-subscriptions DynamoDB table is missing, or Lambda IAM lacks DynamoDB permissions. Ask Member A to check CloudWatch logs.',
        );
        try {
          const config = await getAuthConfig();
          setSnsConfigured(Boolean(config?.snsConfigured));
        } catch {
          /* ignore */
        }
      } else {
        setError(
          msg === 'Failed to fetch'
            ? 'Cannot reach the API. Start the backend: uvicorn app:app --port 8001 (use http://127.0.0.1:8001 in VITE_API_BASE_URL).'
            : msg,
        );
      }
    } finally {
      setLoading(false);
    }
  }, [getToken]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  function parseTags() {
    return tagsInput
      .split(',')
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean);
  }

  async function handleSubscribe() {
    const tags = parseTags();
    if (!tags.length) {
      setError('Enter at least one tag.');
      return;
    }
    setError(null);
    try {
      const token = await getToken();
      const data = await subscribeNotifications({ tags, email }, token);
      const tagList = data.subscribed?.join(', ') || tags.join(', ');
      onNotice?.(
        data.snsConfigured
          ? `Subscribed to ${tagList}. Confirmation email sent (${data.notificationsSent ?? 0}). First time only: click AWS SNS confirm in inbox; more tags need no extra confirm.`
          : `Subscribed to ${tagList} (${data.notificationsSent ?? 0} notification(s) logged).`,
      );
      await refresh();
    } catch (err) {
      setError(err.message || 'Subscribe failed');
    }
  }

  async function handleUnsubscribe(tag) {
    setError(null);
    try {
      const token = await getToken();
      const data = await unsubscribeNotifications({ tags: [tag] }, token);
      onNotice?.(
        snsConfigured
          ? `Unsubscribed from ${tag}. AWS confirmation email sent (${data.notificationsSent ?? 0}).`
          : `Unsubscribed from ${tag} (${data.notificationsSent ?? 0} notification(s) logged).`,
      );
      await refresh();
    } catch (err) {
      setError(err.message || 'Unsubscribe failed');
    }
  }

  return (
    <section className="app-card notification-card">
      <h2>
        <span className="card-icon" aria-hidden="true">
          🔔
        </span>
        Tag notifications (SNS)
      </h2>
      <p className="muted notification-lead">
        Subscribe to species tags and get email when new media matches.
      </p>

      {loading ? <p className="muted">Loading subscriptions…</p> : null}
      {error ? <p className="inline-error">{error}</p> : null}

      <label htmlFor="notify-email">Notification email</label>
      <input
        id="notify-email"
        type="email"
        value={email}
        disabled={busy}
        placeholder="you@example.com"
        onChange={(e) => setEmail(e.target.value)}
      />

      <label htmlFor="notify-tags">Tags to subscribe (comma-separated)</label>
      <input
        id="notify-tags"
        type="text"
        value={tagsInput}
        disabled={busy}
        placeholder="canis dingo, megapodius reinwardt"
        onChange={(e) => setTagsInput(e.target.value)}
      />

      <div className="row-actions">
        <button type="button" className="btn-primary" disabled={busy || loading} onClick={handleSubscribe}>
          Subscribe
        </button>
        <button type="button" className="btn-secondary" disabled={busy || loading} onClick={refresh}>
          Refresh
        </button>
      </div>

      <div className="notification-status">
        <span className={`status-pill ${snsConfigured ? 'status-pill--ok' : 'status-pill--warn'}`}>
          {snsConfigured ? 'SNS configured' : 'SNS not configured (simulated)'}
        </span>
      </div>

      {subscriptions.length ? (
        <ul className="subscription-list">
          {subscriptions.map((sub) => (
            <li key={sub.tag}>
              <span className="tag-chip">{sub.tag}</span>
              <span className="muted">{sub.email}</span>
              <button
                type="button"
                className="btn-ghost btn-sm"
                disabled={busy}
                onClick={() => handleUnsubscribe(sub.tag)}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">No active subscriptions yet.</p>
      )}
    </section>
  );
}
