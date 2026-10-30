/* Remote log for the TVs: errors, rejected promises and console.error go to POST /api/log (read them with
   GET /api/log), and the boot screen shows the error instead of a black page. ES5 on purpose: it must run
   even where app.js would not. Loaded before everything else. */
(function () {
  var url = window.APEXTV_LOG || '/api/log', sent = 0;
  function post(lvl, msg, extra) {
    if (sent++ > 200) return;   // a crash loop must not flood the server
    try {
      var e = { lvl: lvl, msg: String(msg), page: location.href, ua: navigator.userAgent }, k;
      for (k in extra || {}) e[k] = extra[k];
      var x = new XMLHttpRequest();
      x.open('POST', url, true);
      x.setRequestHeader('Content-Type', 'text/plain');   // a "simple" request: no CORS preflight
      x.send(JSON.stringify(e));
    } catch (err) { /* logging must never break the page */ }
  }
  function show(msg) {
    var b = document.getElementById('boot'), m = document.getElementById('boot-msg');
    if (b && m && b.style.display !== 'none') { m.textContent = msg; m.style.color = '#ff6b75'; }
  }
  window.tvlog = post;
  window.tvshow = show;
  window.onerror = function (msg, src, line, col, err) {
    post('error', msg, { src: src, line: line, col: col, stack: err && err.stack });
    show('Error: ' + msg + ' (' + String(src || '').split('/').pop() + ':' + line + ')');
  };
  window.addEventListener('unhandledrejection', function (e) {
    var r = e.reason;
    post('rejection', (r && r.message) || r, { stack: r && r.stack });
    show('Error: ' + ((r && r.message) || r));
  });
  var ce = console.error;
  console.error = function () {
    post('console', Array.prototype.join.call(arguments, ' '));
    if (ce) ce.apply(console, arguments);
  };
  post('info', 'page start', { screen: screen.width + 'x' + screen.height, viewport: window.innerWidth + 'x' + window.innerHeight });
})();
