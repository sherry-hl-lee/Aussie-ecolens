import { useCallback, useState } from 'react';
import { ApiError } from '../api/client.js';

function formatError(err) {
  if (err instanceof ApiError) {
    const detail = err.data ? ` ${JSON.stringify(err.data)}` : '';
    return `${err.message}${detail}`;
  }
  return err?.message || String(err);
}

export function useApiAction(getToken) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);

  const clearMessages = useCallback(() => {
    setError(null);
    setNotice(null);
  }, []);

  const run = useCallback(
    async (fn, { successMessage } = {}) => {
      setBusy(true);
      setError(null);
      setNotice(null);
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

  return { busy, error, notice, setNotice, setError, clearMessages, run };
}
