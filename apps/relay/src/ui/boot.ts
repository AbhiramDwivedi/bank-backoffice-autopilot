/**
 * Applies the saved theme before first paint, so there is no light-then-dark flash. Loaded
 * synchronously in <head> (assets/boot.js), before app.css and app.js. No imports on purpose:
 * this file must not depend on, or drag in, any part of the main bundle.
 */
try {
  const v = window.localStorage.getItem('relay.theme');
  if (v === 'light' || v === 'dark') {
    document.documentElement.dataset.theme = v;
  }
  // 'system', missing, or unreadable: leave the attribute unset so tokens.css's
  // prefers-color-scheme media query decides.
} catch {
  // Storage blocked (private window, policy): fall back to the system theme.
}
