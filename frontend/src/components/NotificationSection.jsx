import { useCallback, useEffect, useState } from 'react';
import {
  getApiBaseUrl,
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
  const [tagsInput, setTagsInput] = useState('dingo, koala');
  const [error, setError] = useState(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const token = await getToken();
      if (!token) {
        setError('登录已过期，请点击右上角 Sign out 后重新登录。');
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
        setError('认证失败（401）：请 Sign out 后重新登录，再试 Subscribe。');
      } else if (err?.status === 500 || String(msg).includes('500')) {
        setError(
          '服务器错误（500）：通常是 DynamoDB 表 ecolens-subscriptions 未创建，或 Lambda IAM 缺少 DynamoDB 权限。请让 Member A 检查 CloudWatch 日志。',
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
            ? '无法连接后端 API。请确认 backend 已启动：uvicorn app:app --port 8001（建议 API 地址用 http://127.0.0.1:8001）'
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
          ? `Subscribed to ${tagList}. AWS confirmation email sent (${data.notificationsSent ?? 0}). Check inbox (confirm SNS if first time).`
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
      <p className="muted">
        Subscribe to species tags and receive email when new media matches. AWS SNS uses filter policies per tag.
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
        placeholder="dingo, koala"
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
          {snsConfigured ? 'SNS configured (real AWS emails)' : 'SNS not configured (simulated logs)'}
        </span>
        <p className="muted api-base-hint">API: {getApiBaseUrl()}</p>
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
