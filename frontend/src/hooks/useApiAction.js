import { useCallback, useState } from 'react';
import { ApiError } from '../api/client.js';

function formatError(err) {
  if (err instanceof ApiError) {
    if (err.status === 413) {
      return 'File is too large to send through the API gateway. The app now uploads directly to S3 — refresh the page and try again.';
    }
    if (err.status === 408) {
      return err.message;
    }
    if (err.status === 403) {
      const detail = err.data?.detail || err.data?.message;
      return detail || 'You do not have permission for this action.';
    }
    if (err.status === 500) {
      const detail = err.data?.detail || err.data?.message;
      return detail ? `Server error: ${detail}` : 'Server error (500). Check AWS Lambda logs or try again.';
    }
    const detail = err.data?.detail || err.data?.message;
    if (detail) {
      return `${err.status} ${err.message}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`;
    }
    if (err.data) {
      return `${err.message} ${JSON.stringify(err.data)}`;
    }
    return err.message;
  }
  return err?.message || String(err);
}

export function useApiAction(getToken) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [warning, setWarning] = useState(null);

  const clearMessages = useCallback(() => {
    setError(null);
    setNotice(null);
    setWarning(null);
  }, []);

  const run = useCallback(
    async (fn, { successMessage } = {}) => {
      setBusy(true);
      setError(null);
      setNotice(null);
      setWarning(null);
      try {
        const token = await getToken();
        if (!token) {
          throw new Error('No authentication token. Please sign in again.');
        }
        const result = await fn(token);
        if (successMessage) setNotice(successMessage);
        return result;
      } catch (err) {
        setError(formatError(err));
        return null;
      } finally {
        setBusy(false);
      }
    },
    [getToken],
  );

  return { busy, error, notice, warning, setNotice, setWarning, setError, clearMessages, run };
}
