/** Customer payment link. Stays outside WalletGate. */
export function isPublicPayInvoicePath(pathname: string): boolean {
  return /^\/pay\/i\/[^/]+\/?$/.test(pathname);
}

/** Signed-in Nave Pay routes. Books follow the treasury group, not the chain pill. */
export function isPayAppPath(pathname: string): boolean {
  if (isPublicPayInvoicePath(pathname)) return false;
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  return path === '/pay' || path.startsWith('/pay/');
}
