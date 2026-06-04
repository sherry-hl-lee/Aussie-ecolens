export function isValidJwt(token) {
  return typeof token === 'string' && token.split('.').length === 3;
}

export function emailFromJwt(token) {
  try {
    const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    return payload.email || payload['cognito:username'] || payload.sub || '';
  } catch {
    return '';
  }
}

export function userFromJwt(token) {
  return {
    email: emailFromJwt(token),
    token,
  };
}
