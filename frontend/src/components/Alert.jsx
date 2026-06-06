export function Alert({ type = 'info', message, onDismiss }) {
  if (!message) return null;
  const className =
    type === 'error'
      ? 'alert alert-error'
      : type === 'success'
        ? 'alert alert-success'
        : type === 'warning'
          ? 'alert alert-warning'
          : 'alert';
  return (
    <div className={className} role="alert">
      <span>{message}</span>
      {onDismiss ? (
        <button type="button" className="alert-dismiss" onClick={onDismiss} aria-label="Dismiss">
          ×
        </button>
      ) : null}
    </div>
  );
}
