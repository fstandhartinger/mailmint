/* Light/dark toggle for the header button. The saved choice is applied before
   first paint by a two-line inline script in each page's <head>; this file only
   wires the button. No dependencies, nothing loaded from anywhere else. */
(function () {
  'use strict';
  var root = document.documentElement;
  var dark = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  function current() {
    var t = root.getAttribute('data-theme');
    if (t === 'light' || t === 'dark') return t;
    return dark && dark.matches ? 'dark' : 'light';
  }
  function label(btn) {
    btn.setAttribute('aria-label', current() === 'dark' ? 'Switch to light theme' : 'Switch to dark theme');
  }
  var buttons = Array.prototype.slice.call(document.querySelectorAll('[data-theme-toggle]'));
  buttons.forEach(function (btn) {
    label(btn);
    btn.addEventListener('click', function () {
      var next = current() === 'dark' ? 'light' : 'dark';
      root.setAttribute('data-theme', next);
      try { localStorage.setItem('mint-theme', next); } catch (e) { /* private mode */ }
      buttons.forEach(label);
    });
  });
})();
