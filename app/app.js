/* APEX TV front end. Plain ES2017 without ?. or ?? so Tizen 4+ (Chromium 56) and webOS run it.
   Remote: arrows, OK (Enter), Back (Tizen 10009, webOS 461, Esc, Backspace outside the search box).
   Live: one tile per channel; its versions (4K/FHD/HD/SD/H265) come best first from the server. OK plays the best
   version and falls back to the next one if it fails. Live video comes straight from Dispatcharr's MPEG-TS
   proxy and plays through mpegts.js (MSE).
   Movies / Series: posters by category from /api/vod, a details page (seasons and episodes for a series) and
   MP4 played by the <video> element itself from Dispatcharr's VOD proxy, with seeking and Continue watching. */
(function () {
  'use strict';
  var KEY = { L: 37, U: 38, R: 39, D: 40, OK: 13, CHUP: [427, 33], CHDN: [428, 34], BACK: [10009, 461, 27, 8], FAV: [405, 70], INFO: [457, 73],
    PLAYPAUSE: [10252, 415, 19], STOP: [413], FF: [417], RW: [412] };
  var store = {
    get: function (k, d) { try { var v = localStorage.getItem('apextv.' + k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
    set: function (k, v) { try { localStorage.setItem('apextv.' + k, JSON.stringify(v)); } catch (e) { /* private mode: keep in memory only */ } }
  };
  var $ = function (id) { return document.getElementById(id); };
  // Served by server.py these are same-origin. The TizenBrew module runs from 127.0.0.1:8081 on the TV and sets
  // window.APEXTV_API / APEXTV_DISPATCHARR to the LAN server before this script.
  var API = window.APEXTV_API || '';
  var DISPATCHARR = window.APEXTV_DISPATCHARR || ('http://' + location.hostname + ':9191');
  var TABS = ['live', 'movies', 'series', 'search'];
  var ROW_FIRST = 14;           // tiles drawn per row before the row gets focus
  var GRID_STEP = 120;          // tiles drawn per step in a grid (a movie category has up to 2500)
  var START_MS = 25000;         // a live version may take this long to show its first frame while Dispatcharr connects
  var STALL_MS = 10000;         // once playing, this long without a new frame is a failure

  // Browse state of the tab on screen. The VIEW fields are swapped with CTX[tab] when the tab changes,
  // so each tab keeps its own sidebar, rows and focus.
  var VIEW = ['side', 'rows', 'list', 'sideIdx', 'rowIdx', 'rowCol', 'rowFull', 'tileIdx', 'gridShown'];
  function fresh() { return { side: [], rows: [], list: [], sideIdx: 0, rowIdx: 0, rowCol: [], rowFull: {}, tileIdx: 0, gridShown: 0 }; }
  var CTX = { live: fresh(), movies: fresh(), series: fresh(), search: fresh() };
  var S = {
    T: [], byKey: {}, cats: [], nets: [],
    favs: store.get('favs2', []), recent: store.get('recent2', []), pref: store.get('ver', {}),
    cw: store.get('cw', []), epos: store.get('epos', {}),
    tab: 'live', zone: 'side', tabIdx: 0, epg: {},
    playing: null, playList: [], playIdx: 0, vIdx: 0, bad: {}, player: null, loadTimer: null, osdTimer: null,
    osdBtn: -1, picker: false, pickIdx: 0, watch: null, vod: null, det: null
  };
  var k0 = fresh(); for (var f in k0) S[f] = k0[f];
  var VOD = { movie: null, series: null }, vodWait = {}, vodFailed = {};

  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function norm(s) { return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, ''); }
  function two(n) { return (n < 10 ? '0' : '') + n; }
  function hm(ts) { var d = new Date(ts * 1000); return two(d.getHours()) + ':' + two(d.getMinutes()); }
  function clockTime(s) { s = Math.max(0, Math.floor(s || 0)); var h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60; return (h ? h + ':' + two(m) : m) + ':' + two(s % 60); }
  function runtime(s) { var m = Math.round((s || 0) / 60); return m >= 60 ? Math.floor(m / 60) + ' h ' + two(m % 60) + ' min' : m + ' min'; }
  function isKey(code, list) { return list.indexOf(code) >= 0; }
  function tilesOf(keys) { return keys.map(function (k) { return S.byKey[k]; }).filter(Boolean); }
  function getJson(url) {
    return fetch(url).then(function (r) {
      return r.json().then(function (d) { if (!r.ok) throw new Error(d && d.error || 'HTTP ' + r.status); return d; });
    });
  }

  // ---------- data ----------
  function load() {
    return fetch(API + 'api/live').then(function (r) { return r.json(); }).then(function (d) {
      S.T = d.tiles.map(function (t, i) {
        return { kind: 'ch', i: i, key: t[0], name: t[1], logo: t[2], tvg: t[3], brand: t[4], nkey: norm(t[1]),
          v: t[5].map(function (v) { return { id: v[0], label: v[1], num: v[2] }; }) };
      });
      S.byKey = {}; S.T.forEach(function (t) { S.byKey[t.key] = t; });
      var pick = function (ids) { return ids.map(function (i) { return S.T[i]; }); };
      S.cats = d.cats.map(function (c) { return { kind: 'cat', name: c.name, t: pick(c.t) }; });
      S.nets = d.nets.map(function (n) { return { kind: 'net', name: n.name, t: pick(n.t) }; });
      S.serverRows = d.rows.map(function (r) { return { name: r.name, t: pick(r.t) }; });
      build();
    });
  }

  function build() {   // the Live tab's sidebar and Home rows
    var favs = tilesOf(S.favs), rec = tilesOf(S.recent);
    S.side = [{ kind: 'home', name: 'Home', t: [] }, { kind: 'list', name: '★ Favorites', t: favs }]
      .concat(rec.length ? [{ kind: 'list', name: 'Recently watched', t: rec }] : [])
      .concat([{ kind: 'hdr', name: 'Networks' }], S.nets, [{ kind: 'hdr', name: 'Provider categories' }], S.cats);
    S.rows = [{ name: '★ Favorites', t: favs, empty: 'Press ★ (yellow) or F on a channel, or ★ Favorite in the player.' }]
      .concat(rec.length ? [{ name: 'Recently watched', t: rec }] : [], S.serverRows);
    if (!favs.length && rec.length) S.rows.push(S.rows.shift());   // an empty favorites row goes last, not first
  }

  function loadVod(kind) {
    if (VOD[kind]) return Promise.resolve(VOD[kind]);
    if (!vodWait[kind]) {
      vodWait[kind] = getJson(API + 'api/vod?kind=' + kind).then(function (d) {
        var items = d.items.map(function (x, i) {
          return { kind: kind, i: i, id: x[0], name: x[1], year: x[2], logo: x[3], rating: x[4], tag: x[5], nkey: norm(x[1]) };
        });
        var byId = {}; items.forEach(function (t) { byId[t.id] = t; });
        var cats = d.cats.map(function (c) {
          return c.hdr ? { kind: 'hdr', name: c.hdr } : { kind: 'cat', name: c.name, t: c.t.map(function (i) { return items[i]; }) };
        });
        VOD[kind] = { items: items, byId: byId, cats: cats, rows: d.rows.map(function (i) { return cats[i]; }) };
        vodFailed[kind] = false;
        return VOD[kind];
      }).catch(function (e) {
        vodWait[kind] = null; vodFailed[kind] = true;
        window.tvlog('error', kind + ' catalog failed: ' + (e && e.message || e));
        throw e;
      });
    }
    return vodWait[kind];
  }
  function tabKind(tab) { return tab === 'movies' ? 'movie' : 'series'; }
  function vodBuild(tab) {   // a Movies or Series tab: Home (Continue watching + category rows), then the categories
    var V = VOD[tabKind(tab)], cw = cwItems(tabKind(tab));
    S.side = [{ kind: 'home', name: 'Home', t: [] }].concat(cw.length ? [{ kind: 'list', name: 'Continue watching', t: cw }] : [], V.cats);
    S.rows = (cw.length ? [{ name: 'Continue watching', t: cw }] : []).concat(V.rows);
  }

  function fetchEpg(tiles) {
    var ids = [], seen = {};
    tiles.forEach(function (t) { if (t && t.tvg && !seen[t.tvg] && !S.epg[t.tvg]) { seen[t.tvg] = 1; ids.push(t.tvg); } });
    if (!ids.length) return Promise.resolve();
    var batches = [];
    for (var i = 0; i < ids.length; i += 400) batches.push(ids.slice(i, i + 400));
    return Promise.all(batches.map(function (b) {
      return fetch(API + 'api/epg?ids=' + encodeURIComponent(b.join(','))).then(function (r) { return r.json(); })
        .then(function (d) { for (var k in d) S.epg[k] = d[k]; });
    })).catch(function () { /* EPG is optional */ });
  }
  function nowProg(t) {
    var p = S.epg[t.tvg], now = Date.now() / 1000;
    if (!p) return null;
    for (var i = 0; i < p.length; i++) if (p[i][0] <= now && p[i][1] > now) return { now: p[i], next: p[i + 1] || null };
    return p[0] && p[0][0] > now ? { now: null, next: p[0] } : null;
  }
  function pct(p) { var t = Date.now() / 1000; return Math.max(0, Math.min(100, (t - p[0]) / (p[1] - p[0]) * 100)); }

  // ---------- Continue watching (this device only) ----------
  // S.cw: newest first, one entry per movie or series: {k, kind, id, pos, dur, at, ep: {uuid, s, e, title} for a series}.
  // S.epos: position per episode uuid [pos, dur], for the bars in the episode list.
  function cwOf(t) { var k = t.kind + ':' + t.id; for (var i = 0; i < S.cw.length; i++) if (S.cw[i].k === k) return S.cw[i]; return null; }
  function cwItems(kind) {
    var V = VOD[kind];
    return V ? S.cw.filter(function (e) { return e.kind === kind; }).map(function (e) { return V.byId[e.id]; }).filter(Boolean) : [];
  }
  function cwSave(ended) {
    var v = S.vod, el = $('video');
    if (!v || !v.started) return;
    var pos = ended ? vodDur() : (v.seekTo >= 0 ? v.seekTo : el.currentTime || 0), dur = vodDur();
    var t = v.item, k = t.kind + ':' + t.id, done = ended || (dur > 0 && pos > dur * 0.95), entry = null;
    if (v.ep) {
      S.epos[v.ep.uuid] = [Math.floor(done ? dur : pos), Math.floor(dur)];
      var ks = Object.keys(S.epos); if (ks.length > 600) ks.slice(0, ks.length - 500).forEach(function (x) { delete S.epos[x]; });
      store.set('epos', S.epos);
      var nx = done ? nextEp(v) : v.ep;
      if (nx && (done || pos >= 30)) entry = { ep: { uuid: nx.uuid, s: nx.s, e: nx.e, title: nx.title }, pos: done ? 0 : Math.floor(pos), dur: done ? nx.dur : Math.floor(dur) };
      if (!entry && !done) return;            // a few seconds of another episode: keep the old place
    } else if (!done && pos >= 30) entry = { pos: Math.floor(pos), dur: Math.floor(dur) };
    S.cw = S.cw.filter(function (e) { return e.k !== k; });
    if (entry) { entry.k = k; entry.kind = t.kind; entry.id = t.id; entry.at = Date.now(); S.cw.unshift(entry); }
    S.cw = S.cw.slice(0, 40);
    store.set('cw', S.cw);
  }

  // ---------- tiles ----------
  function tileHtml(t) { return t.kind === 'ch' ? chanHtml(t) : posterHtml(t); }
  function dataK(t) { return (t.kind === 'ch' ? 'c' : t.kind === 'movie' ? 'm' : 's') + ':' + t.i; }
  function itemOf(el) {
    var k = el.getAttribute('data-k').split(':'), i = +k[1];
    return k[0] === 'c' ? S.T[i] : VOD[k[0] === 'm' ? 'movie' : 'series'].items[i];
  }
  function chanHtml(t) {
    var p = nowProg(t), fav = S.favs.indexOf(t.key) >= 0, best = t.v[0];
    var vers = (best.label !== 'Standard' ? best.label.split(' ')[0] : '') + (t.v.length > 1 ? ' +' + (t.v.length - 1) : '');
    return '<div class="tile" data-k="' + dataK(t) + '"><div class="art">' +
      (best.num ? '<span class="num">' + esc(best.num) + '</span>' : '') + (fav ? '<span class="fav">★</span>' : '') +
      (t.logo ? '<img data-src="' + esc(t.logo) + '" alt="">' : '') + (vers ? '<span class="vers">' + esc(vers) + '</span>' : '') +
      '</div><div class="meta"><div class="name">' + esc(t.name) + '</div><div class="now">' + (p && p.now ? esc(p.now[2]) : '') + '</div>' +
      '<div class="bar"><i style="width:' + (p && p.now ? pct(p.now) : 0) + '%"></i></div></div></div>';
  }
  function posterUrl(t) { return DISPATCHARR + '/api/vod/vodlogos/' + t.logo + '/cache/'; }
  function imgUrl(p) { return !p ? '' : /^https?:/.test(p) ? p : DISPATCHARR + p; }
  function posterHtml(t) {
    var c = cwOf(t), p = c && c.dur ? Math.min(100, c.pos / c.dur * 100) : 0;
    var sub = c && c.ep ? 'S' + c.ep.s + ' E' + c.ep.e + (c.pos ? ' · ' + clockTime(c.pos) : ' · next')
      : c && c.dur ? runtime(c.dur - c.pos) + ' left' : (t.year || '') + (t.rating ? '  ★ ' + t.rating : '');
    return '<div class="tile poster" data-k="' + dataK(t) + '"><div class="art"><span class="ph">' + esc(t.name) + '</span>' +
      (t.logo ? '<img data-src="' + esc(posterUrl(t)) + '" alt="">' : '') + (t.tag ? '<span class="vers">' + esc(t.tag) + '</span>' : '') +
      '</div><div class="meta"><div class="name">' + esc(t.name) + '</div><div class="now">' + esc(sub) + '</div>' +
      (p ? '<div class="bar"><i style="width:' + p + '%"></i></div>' : '') + '</div></div>';
  }
  var io = 'IntersectionObserver' in window ? new IntersectionObserver(function (es) {
    es.forEach(function (e) { if (e.isIntersecting) { var im = e.target; im.src = im.getAttribute('data-src'); io.unobserve(im); } });
  }, { rootMargin: '300px 600px' }) : null;
  function lazyImgs(root) {
    var ims = root.querySelectorAll('img[data-src]:not([src])');
    for (var i = 0; i < ims.length; i++) {
      ims[i].onerror = function () { this.style.display = 'none'; };
      if (io) io.observe(ims[i]); else ims[i].src = ims[i].getAttribute('data-src');
    }
  }
  function refreshNow(root) {
    var els = root.querySelectorAll('.tile[data-k^="c:"]');
    for (var i = 0; i < els.length; i++) {
      var p = nowProg(itemOf(els[i]));
      els[i].querySelector('.now').textContent = p && p.now ? p.now[2] : '';
      els[i].querySelector('.bar i').style.width = (p && p.now ? pct(p.now) : 0) + '%';
    }
  }
  function keepVisible(box, el) {
    if (!el) return;
    var top = el.offsetTop - box.offsetTop, pad = 40;
    if (top - pad < box.scrollTop) box.scrollTop = Math.max(0, top - pad);
    else if (top + el.offsetHeight + pad > box.scrollTop + box.clientHeight) box.scrollTop = top + el.offsetHeight + pad - box.clientHeight;
  }
  function activate(list, i) {   // OK on a tile: a channel plays, a movie or series opens its page
    var t = list[i];
    if (!t) return;
    if (t.kind === 'ch') play(list, i); else openDetails(t);
  }

  // ---------- sidebar ----------
  function renderSide() {
    $('cats').innerHTML = S.side.map(function (c) {
      return c.kind === 'hdr' ? '<div class="cat hdr">' + esc(c.name) + '</div>'
        : '<div class="cat">' + esc(c.name) + (c.kind === 'home' ? '' : '<span class="n">' + c.t.length + '</span>') + '</div>';
    }).join('');
    focusSide();
  }
  function focusSide() {
    if (S.tab === 'search') return;
    var els = $('cats').children;
    for (var i = 0; i < els.length && i < S.side.length; i++) {
      if (S.side[i].kind === 'hdr') continue;
      els[i].className = 'cat' + (i === S.sideIdx ? ' active' : '') + (S.zone === 'side' && i === S.sideIdx ? ' focus' : '');
    }
    keepVisible($('cats'), els[S.sideIdx]);
  }
  function stepSide(d) {
    var i = S.sideIdx + d;
    while (S.side[i] && S.side[i].kind === 'hdr') i += d;
    if (S.side[i]) showSide(i);
  }
  function showSide(i) {
    S.sideIdx = i;
    var item = S.side[i];
    $('rows').classList.toggle('hidden', item.kind !== 'home');
    $('grid').classList.toggle('hidden', item.kind === 'home');
    if (item.kind === 'home') renderRows();
    else { S.list = item.t; S.tileIdx = 0; renderGrid(S.list, item.name === '★ Favorites' ? 'No favorites yet.' : 'Nothing here.'); }
    focusSide();
  }

  // ---------- rows (Home of each tab, and the search results) ----------
  function rowsBox() { return S.tab === 'search' ? $('srows') : $('rows'); }
  function renderRows(emptyMsg) {
    var box = rowsBox();
    box.innerHTML = !S.rows.length ? '<div class="msg big">' + esc(emptyMsg || '') + '</div>' : S.rows.map(function (r) {
      return '<div class="row"><h3>' + esc(r.name) + '</h3><div class="track"><div class="strip">' +
        (r.t.length ? r.t.slice(0, ROW_FIRST).map(tileHtml).join('') : '<div class="msg">' + esc(r.empty || '') + '</div>') + '</div></div></div>';
    }).join('');
    S.rowCol = S.rows.map(function () { return 0; });
    S.rowFull = {};
    box.scrollTop = 0;
    lazyImgs(box);
    var vis = []; S.rows.forEach(function (r) { vis = vis.concat(r.t.slice(0, ROW_FIRST)); });
    fetchEpg(vis).then(function () { refreshNow(box); });
    focusRow();
  }
  function fillRow(ri) {
    if (S.rowFull[ri] || S.rows[ri].t.length <= ROW_FIRST) return;
    S.rowFull[ri] = 1;
    var strip = rowsBox().children[ri].querySelector('.strip');
    strip.insertAdjacentHTML('beforeend', S.rows[ri].t.slice(ROW_FIRST).map(tileHtml).join(''));
    lazyImgs(strip);
    fetchEpg(S.rows[ri].t).then(function () { refreshNow(strip); });
  }
  function focusRow() {
    var box = rowsBox(), rows = box.children;
    if (!S.rows.length) return;
    var old = box.querySelector('.tile.focus'); if (old) old.classList.remove('focus');
    for (var r = 0; r < rows.length; r++) rows[r].className = 'row' + (S.zone === 'rows' && r === S.rowIdx ? ' focus' : '');
    var row = rows[S.rowIdx]; if (!row) return;
    var tiles = row.querySelectorAll('.tile'), c = S.rowCol[S.rowIdx], el = tiles[c];
    if (el && S.zone === 'rows') el.classList.add('focus');
    if (el) {
      var w = el.offsetWidth + parseFloat(getComputedStyle(el).marginRight);
      row.querySelector('.strip').style.transform = 'translateX(' + (-Math.max(0, c - 1) * w) + 'px)';
    }
    keepVisible(box, row);
  }

  // ---------- grid (a network, category or list), drawn GRID_STEP tiles at a time ----------
  function renderGrid(list, emptyMsg) {
    var g = $('grid');
    S.gridShown = Math.min(list.length, GRID_STEP);
    g.innerHTML = list.length ? list.slice(0, S.gridShown).map(tileHtml).join('') : '<div class="msg">' + esc(emptyMsg) + '</div>';
    g.scrollTop = 0;
    lazyImgs(g);
    focusTile();
    fetchEpg(list.slice(0, S.gridShown)).then(function () { refreshNow(g); });
  }
  function growGrid(upTo) {
    if (upTo < S.gridShown || S.gridShown >= S.list.length) return;
    var g = $('grid'), from = S.gridShown;
    S.gridShown = Math.min(S.list.length, upTo + GRID_STEP);
    var part = S.list.slice(from, S.gridShown);
    g.insertAdjacentHTML('beforeend', part.map(tileHtml).join(''));
    lazyImgs(g);
    fetchEpg(part).then(function () { refreshNow(g); });
  }
  function focusTile() {
    if (S.tab === 'search') return;
    var g = $('grid');
    growGrid(S.tileIdx + cols() * 4);
    var old = g.querySelector('.tile.focus'); if (old) old.classList.remove('focus');
    var el = g.querySelectorAll('.tile')[S.tileIdx];
    if (el && S.zone === 'grid') el.classList.add('focus');
    if (el) keepVisible(g, el);
  }
  function cols() {
    var g = $('grid'), t = g.querySelector('.tile');
    if (!t) return 1;
    var w = t.offsetWidth + parseFloat(getComputedStyle(t).marginRight);
    return Math.max(1, Math.floor((g.clientWidth - 20) / w));
  }

  // ---------- tabs ----------
  function setTab(t) {
    if (t !== S.tab) {
      VIEW.forEach(function (k) { CTX[S.tab][k] = S[k]; });
      S.tab = t;
      VIEW.forEach(function (k) { S[k] = CTX[t][k]; });
    }
    $('view-browse').classList.toggle('hidden', t === 'search');
    $('view-search').classList.toggle('hidden', t !== 'search');
    renderTabs();
    if (t === 'live') { if (S.T.length) redrawBrowse(); }
    else if (t === 'search') renderRows(S.rows.length ? '' : 'Search channels, movies and series.');
    else openVodTab(t);
  }
  function renderTabs() {
    var els = document.querySelectorAll('.tab');
    for (var i = 0; i < els.length; i++) els[i].className = 'tab' + (TABS[i] === S.tab ? ' active' : '') + (S.zone === 'tabs' && S.tabIdx === i ? ' focus' : '');
  }
  function openVodTab(tab) {
    if (VOD[tabKind(tab)]) { redrawBrowse(); return; }
    $('cats').innerHTML = '';
    $('grid').classList.add('hidden'); $('rows').classList.remove('hidden');
    S.side = []; S.rows = [];
    $('rows').innerHTML = '<div class="msg big">Loading ' + tab + '…</div>';
    loadVod(tabKind(tab)).then(function () {
      if (S.tab !== tab) return;
      vodBuild(tab); renderSide(); showSide(0);
      if (S.zone !== 'tabs') S.zone = 'rows';
      focusSide(); focusRow();
    }, function (e) {
      if (S.tab === tab) $('rows').innerHTML = '<div class="msg big">Cannot load ' + tab + ': ' + esc(e && e.message || e) + '</div>';
    });
  }

  // ---------- search: channels, movies and series ----------
  var qTimer = null;
  function match(list, q, max) {   // names starting with q first, then names containing it
    var a = [], b = [];
    for (var i = 0; i < list.length && a.length < max; i++) {
      var at = list[i].nkey.indexOf(q);
      if (at === 0) a.push(list[i]); else if (at > 0 && b.length < max) b.push(list[i]);
    }
    return a.concat(b).slice(0, max);
  }
  function runSearch() {
    var q = norm($('q').value.trim());
    S.rowIdx = 0;
    if (q.length < 2) { S.rows = []; renderRows('Type at least 2 letters.'); return; }
    var rows = [{ name: 'Channels', t: match(S.T, q, 80) }];
    if (VOD.movie) rows.push({ name: 'Movies', t: match(VOD.movie.items, q, 80) });
    if (VOD.series) rows.push({ name: 'Series', t: match(VOD.series.items, q, 80) });
    S.rows = rows.filter(function (r) { return r.t.length; });
    var missing = ['movie', 'series'].filter(function (k) { return !VOD[k] && !vodFailed[k]; });
    renderRows(missing.length ? 'Searching…' : 'Nothing matches "' + $('q').value.trim() + '".');
    if (missing.length) {
      Promise.all(missing.map(function (k) { return loadVod(k).catch(function () { return null; }); })).then(function () {
        if (S.tab === 'search' && norm($('q').value.trim()) === q) runSearch();
      });
    }
  }

  // ---------- favorites / recent ----------
  function toggleFav(t) {
    var i = S.favs.indexOf(t.key);
    if (i >= 0) S.favs.splice(i, 1); else S.favs.unshift(t.key);
    store.set('favs2', S.favs);
    if (S.tab === 'live') build();
  }
  function addRecent(t) {
    S.recent = [t.key].concat(S.recent.filter(function (x) { return x !== t.key; })).slice(0, 24);
    store.set('recent2', S.recent);
  }
  function redrawBrowse() {   // rebuild the tab on screen (favorites, recent, Continue watching changed), keep the focus
    var side = S.side[S.sideIdx], name = side && side.name, cols = {}, rowName = S.rows[S.rowIdx] && S.rows[S.rowIdx].name, tile = S.tileIdx;
    S.rows.forEach(function (r, ri) { cols[r.name] = S.rowCol[ri] || 0; });   // rows move when Recently watched appears
    if (S.tab === 'live') build(); else vodBuild(S.tab);
    var i = 0; while (i < S.side.length && S.side[i].name !== name) i++;
    S.sideIdx = i < S.side.length ? i : 0;
    renderSide();
    var home = S.side[S.sideIdx].kind === 'home';
    $('rows').classList.toggle('hidden', !home);
    $('grid').classList.toggle('hidden', home);
    if (home) {
      renderRows();
      S.rowIdx = Math.max(0, S.rows.map(function (r) { return r.name; }).indexOf(rowName));
      S.rowCol = S.rows.map(function (r) { return Math.min(cols[r.name] || 0, Math.max(0, r.t.length - 1)); });
      S.rows.forEach(function (r, ri) { if (S.rowCol[ri] >= ROW_FIRST) fillRow(ri); });
      focusRow();
    } else {
      S.list = S.side[S.sideIdx].t; renderGrid(S.list, 'Nothing here.');
      S.tileIdx = Math.min(tile, Math.max(0, S.list.length - 1));
      if (!S.list.length && S.zone === 'grid') S.zone = 'side';
      focusSide(); focusTile();
    }
  }

  // ---------- live player ----------
  function play(list, idx) {
    S.playList = list; S.playIdx = idx;
    $('player').classList.remove('hidden');
    tune(0);
  }
  function is4k(v) { return /^4K/.test(v.label); }
  function prefIdx(t) {   // the version Hugo picked last time for this channel, else the best one below 4K
    var id = S.pref[t.key];
    for (var i = 0; i < t.v.length; i++) if (t.v[i].id === id) return i;
    var n = nextWorking(t, 0);
    return n < 0 ? 0 : n;
  }
  function tune(delay, vIdx) {
    var t = S.playList[S.playIdx];
    S.playing = t; S.vIdx = vIdx === undefined ? prefIdx(t) : vIdx;
    closePicker();
    showOsd(true);
    status('');
    clearTimeout(S.loadTimer);
    stopVideo();
    // A short wait lets Up/Down skip through channels without opening a stream for each one.
    S.loadTimer = setTimeout(function () { startVideo(); }, delay);
    addRecent(t);
  }
  function nextWorking(t, from) {   // 4K is only played when picked in the Version picker
    for (var i = from; i < t.v.length; i++) if (!S.bad[t.v[i].id] && !is4k(t.v[i])) return i;
    return -1;
  }
  function failed(why) {   // this version did not play: try the next one down
    var t = S.playing, v = t.v[S.vIdx];
    S.bad[v.id] = 1;
    if (S.pref[t.key] === v.id) { delete S.pref[t.key]; store.set('ver', S.pref); }   // a picked version that fails is not kept
    stopVideo();
    if (why) window.tvlog('play', t.name + ' ' + v.label + ': ' + why, { stream: v.id });
    var n = nextWorking(t, S.vIdx + 1);
    if (n < 0) n = nextWorking(t, 0);
    if (n >= 0) { S.vIdx = n; status('Trying ' + (t.v[n].label || 'another version') + '…'); S.loadTimer = setTimeout(startVideo, 400); }
    else status('Channel unavailable. ▲▼ for another channel.');
    showOsd(true);
  }
  function verdict(w, now) {   // why a live version counts as failed, or '' while it is fine
    // Before the first frame Dispatcharr may still be connecting to the source (Pluto-style sources take 10 s or more);
    // a source that is down ends the stream instead, which fails at once (LOADING_COMPLETE / ERROR).
    if (!w.first) return now - w.start > START_MS ? 'no video' : '';
    // Progress means new decoded video frames, not a moving clock: audio alone moves currentTime under a frozen picture.
    return now - w.lastNew > STALL_MS ? 'stalled' : '';
  }
  function startVideo() {
    var t = S.playing, v = t.v[S.vIdx], url = DISPATCHARR + '/proxy/ts/stream/' + v.id, el = $('video');
    if (!$('status').textContent) status('Loading…');
    if (window.mpegts && mpegts.getFeatureList().mseLivePlayback) {
      var p = mpegts.createPlayer({ type: 'mpegts', isLive: true, url: url }, {
        enableWorker: true, lazyLoad: false, enableStashBuffer: true, stashInitialSize: 256 * 1024,
        liveBufferLatencyChasing: true, liveBufferLatencyMaxLatency: 8, liveBufferLatencyMinRemain: 2
      });
      S.player = p;
      p.on(mpegts.Events.ERROR, function () { if (S.player === p) failed('error'); });
      // A live stream that ends was closed by Dispatcharr: the source is down (it gives up after its own retries).
      p.on(mpegts.Events.LOADING_COMPLETE, function () { if (S.player === p) failed('stream ended'); });
      // A codec this device cannot decode (HEVC 4K in most PC browsers) plays its audio with no picture: skip it now.
      p.on(mpegts.Events.MEDIA_INFO, function (mi) {
        var c = mi && mi.videoCodec;
        if (S.player === p && c && window.MediaSource && !MediaSource.isTypeSupported('video/mp4; codecs="' + c + '"')) failed('codec ' + c);
      });
      p.attachMediaElement(el);
      p.load();
      var pr = p.play();
      if (pr && pr.catch) pr.catch(function () { /* autoplay may wait for a key press */ });
    } else {
      el.src = url;   // no MSE (older iPhone): the browser tries the stream itself
      el.play().catch(function () { status('This device cannot play live TV streams.'); });
    }
    var w = { start: Date.now(), first: 0, lastNew: 0, frames: -1 }, mine = S.player;
    clearInterval(S.watch);
    S.watch = setInterval(function () {
      if (S.player !== mine || S.vod) { clearInterval(S.watch); return; }
      var f = frames(el), now = Date.now();
      if (f > w.frames && el.videoWidth > 0) {
        if (!w.first) { w.first = now; window.tvlog('play', t.name + ' ' + v.label + ': playing after ' + ((now - w.start) / 1000).toFixed(1) + ' s', { stream: v.id }); }
        w.frames = f; w.lastNew = now;
        if ($('status').textContent) status('');
      } else if (!w.first && now - w.start > 6000 && $('status').textContent === 'Loading…') status('Still connecting…');
      var why = verdict(w, now);
      if (why) { clearInterval(S.watch); failed(why); }
    }, 1000);
  }
  function frames(el) {   // decoded video frames; falls back to the clock where the browser has no frame counter
    if (el.getVideoPlaybackQuality) return el.getVideoPlaybackQuality().totalVideoFrames;
    if (typeof el.webkitDecodedFrameCount === 'number') return el.webkitDecodedFrameCount;
    return Math.floor(el.currentTime * 10);
  }
  function stopVideo() {
    var p = S.player; S.player = null;
    clearInterval(S.watch);
    if (p) { try { p.pause(); p.unload(); p.detachMediaElement(); p.destroy(); } catch (e) { /* already gone */ } }
    var v = $('video');
    v.onloadedmetadata = v.onplaying = v.ontimeupdate = v.onerror = v.onended = v.onwaiting = null;
    v.removeAttribute('src'); try { v.load(); } catch (e) { /* ignore */ }
  }
  function closePlayer() {
    if (S.vod) { closeVod(); return; }
    clearTimeout(S.loadTimer); stopVideo(); closePicker();
    $('player').classList.add('hidden');
    showOsd(false); status('');
    var cur = S.playing;
    if (S.tab === 'live') {
      redrawBrowse();
      if (S.zone === 'rows') {
        var c = S.rows[S.rowIdx].t.indexOf(cur);
        if (c >= 0) { if (c >= ROW_FIRST) fillRow(S.rowIdx); S.rowCol[S.rowIdx] = c; }
        focusRow();
      } else { var i = S.list.indexOf(cur); if (i >= 0) S.tileIdx = i; S.zone = 'grid'; focusTile(); }
    } else { S.zone = 'rows'; focusRow(); }
  }
  function status(t) { $('status').textContent = t; $('status').classList.toggle('hidden', !t); }

  function showOsd(on) {
    clearTimeout(S.osdTimer);
    $('osd').classList.toggle('hidden', !on);
    if (!on) { S.osdBtn = -1; focusBtn(); return; }
    var t = S.playing, p = nowProg(t), v = t.v[S.vIdx];
    $('osd-num').textContent = v.num || '';
    $('osd-name').textContent = t.name;
    $('osd-q').textContent = v.label !== 'Standard' ? v.label : '';
    $('osd-group').textContent = (t.brand ? t.brand + ' · ' : '') + (S.playIdx + 1) + ' of ' + S.playList.length;
    $('osd-fav').classList.toggle('hidden', S.favs.indexOf(t.key) < 0);
    $('btn-fav').textContent = S.favs.indexOf(t.key) >= 0 ? '★ Remove favorite' : '★ Favorite';
    $('btn-ver').textContent = 'Version: ' + v.label + (t.v.length > 1 ? '  (' + t.v.length + ')' : '');
    var img = $('osd-logo'); img.style.display = t.logo ? '' : 'none'; if (t.logo) img.src = t.logo;
    $('osd-now').textContent = p && p.now ? hm(p.now[0]) + ' – ' + hm(p.now[1]) + '  ' + p.now[2] : 'No programme info';
    $('osd-bar').style.width = (p && p.now ? pct(p.now) : 0) + '%';
    $('osd-next').textContent = p && p.next ? 'Next  ' + hm(p.next[0]) + '  ' + p.next[2] : '';
    $('osd-desc').textContent = p && p.now ? p.now[3] : '';
    if (!S.epg[t.tvg]) fetchEpg([t]).then(function () { if (S.playing === t && S.epg[t.tvg] && !$('osd').classList.contains('hidden')) showOsd(true); });
    focusBtn();
    S.osdTimer = setTimeout(function () { if (S.osdBtn < 0 && !S.picker) showOsd(false); }, 6000);
  }
  function focusBtn() {
    var b = document.querySelectorAll('.osd-buttons .btn');
    for (var i = 0; i < b.length; i++) b[i].className = 'btn' + (i === S.osdBtn ? ' focus' : '');
  }
  function openPicker() {
    S.picker = true; S.pickIdx = S.vIdx;
    $('picker').classList.remove('hidden');
    renderPicker();
  }
  function renderPicker() {
    var t = S.playing;
    $('picker-list').innerHTML = t.v.map(function (v, i) {
      return '<div class="pv' + (i === S.vIdx ? ' cur' : '') + (i === S.pickIdx ? ' focus' : '') + (S.bad[v.id] ? ' bad' : '') + '">' +
        esc(v.label) + (v.num ? '<span class="muted">ch ' + esc(v.num) + '</span>' : '') + '</div>';
    }).join('');
    keepVisible($('picker-list'), $('picker-list').children[S.pickIdx]);
  }
  function closePicker() { S.picker = false; $('picker').classList.add('hidden'); }

  // ---------- movie / series page ----------
  function openDetails(t) {
    S.det = { item: t, info: null, err: '', zone: 'btns', btn: 0, si: 0, ei: 0, btns: [] };
    $('details').classList.remove('hidden');
    $('d-backdrop').style.backgroundImage = '';
    drawDetails();
    getJson(API + 'api/vod/info?kind=' + t.kind + '&id=' + t.id).then(function (d) {
      var D = S.det;
      if (!D || D.item !== t) return;
      D.info = d;
      var c = cwOf(t), at = c && c.ep ? findEp(d, c.ep.uuid) : null;
      if (at) { D.si = at[0]; D.ei = at[1]; }
      drawDetails();
    }).catch(function (e) {
      if (S.det && S.det.item === t) { S.det.err = e && e.message || String(e); drawDetails(); }
      window.tvlog('error', 'details ' + t.kind + ' ' + t.id + ': ' + (e && e.message || e));
    });
  }
  function closeDetails() {
    S.det = null;
    $('details').classList.add('hidden');
    if (S.tab === 'search') { S.zone = 'rows'; renderRows(); }   // posters show the new progress
    else redrawBrowse();
  }
  function findEp(d, uuid) {
    var ss = d.seasons || [];
    for (var s = 0; s < ss.length; s++) for (var e = 0; e < ss[s].eps.length; e++) if (ss[s].eps[e][0] === uuid) return [s, e];
    return null;
  }
  function epAt(d, si, ei) {
    var s = d.seasons[si], e = s && s.eps[ei];
    return e ? { uuid: e[0], s: s.n, e: e[1], title: e[2], dur: e[3], si: si, ei: ei } : null;
  }
  function epLabel(ep) { return 'S' + ep.s + ' E' + ep.e; }
  function detButtons() {
    var D = S.det, t = D.item, d = D.info, c = cwOf(t), out = [];
    if (!d) return out;
    if (t.kind === 'movie') {
      if (!d.uuid) return out;
      if (c && c.pos) out.push({ label: '▶ Resume  ' + clockTime(c.pos), act: 'resume' }, { label: '↺ From the start', act: 'start' });
      else out.push({ label: '▶ Play', act: 'start' });
      return out;
    }
    if (!d.seasons || !d.seasons.length) return out;
    var at = c && c.ep ? findEp(d, c.ep.uuid) : null, ep = at ? epAt(d, at[0], at[1]) : epAt(d, 0, 0);
    if (at && c.pos) out.push({ label: '▶ Resume ' + epLabel(ep) + '  ' + clockTime(c.pos), act: 'resume', ep: ep, pos: c.pos });
    else out.push({ label: '▶ Play ' + epLabel(ep), act: 'resume', ep: ep, pos: 0 });
    if (at && (at[0] || at[1])) out.push({ label: '↺ From S' + d.seasons[0].n + ' E' + d.seasons[0].eps[0][1], act: 'resume', ep: epAt(d, 0, 0), pos: 0 });
    return out;
  }
  function drawDetails() {
    var D = S.det, t = D.item, d = D.info;
    D.btns = detButtons();
    D.btn = Math.min(D.btn, Math.max(0, D.btns.length - 1));
    if (d && d.backdrop) $('d-backdrop').style.backgroundImage = 'url("' + imgUrl(d.backdrop) + '")';
    var pimg = $('d-poster'), psrc = t.logo ? posterUrl(t) : d && d.poster ? imgUrl(d.poster) : '';
    pimg.style.display = psrc ? '' : 'none';
    if (psrc && pimg.getAttribute('src') !== psrc) { pimg.onerror = function () { this.style.display = 'none'; }; pimg.src = psrc; }
    $('d-title').textContent = d && d.name ? d.name : t.name;
    var meta = [d && d.year || t.year, d && d.q, t.tag === 'LEG' ? 'Subtitled' : t.tag, t.rating ? '★ ' + t.rating : '',
      d && d.dur ? runtime(d.dur) : '', d && d.seasons ? d.seasons.length + (d.seasons.length === 1 ? ' season' : ' seasons') : '', d && d.genre];
    $('d-meta').textContent = meta.filter(Boolean).join('  ·  ');
    $('d-plot').textContent = d ? d.plot || '' : D.err ? 'Cannot load the details: ' + D.err : 'Loading…';
    $('d-credits').textContent = d ? [d.director ? 'Director: ' + d.director : '', d.cast ? 'Cast: ' + d.cast : ''].filter(Boolean).join('  ·  ') : '';
    $('d-btns').innerHTML = D.btns.map(function (b, i) {
      return '<div class="dbtn' + (D.zone === 'btns' && i === D.btn ? ' focus' : '') + '">' + esc(b.label) + '</div>';
    }).join('') + (d && t.kind === 'series' && d.seasons && !d.seasons.length ? '<div class="muted">No episodes from the provider yet.</div>' : '');
    var ss = d && d.seasons || [];
    $('d-seasons').innerHTML = ss.length > 1 ? ss.map(function (s, i) {
      return '<div class="season' + (i === D.si ? ' active' : '') + (D.zone === 'seasons' && i === D.si ? ' focus' : '') + '">Season ' + s.n + '</div>';
    }).join('') : '';
    $('d-seasons').classList.toggle('hidden', ss.length < 2);
    var eps = ss[D.si] ? ss[D.si].eps : [];
    $('d-eps').innerHTML = eps.map(function (e, i) {
      var p = S.epos[e[0]], w = p && p[1] ? Math.min(100, p[0] / p[1] * 100) : 0;
      return '<div class="ep' + (D.zone === 'eps' && i === D.ei ? ' focus' : '') + '"><span class="epn">' + e[1] + '</span><div class="ept">' +
        '<div class="epname">' + esc(e[2]) + (e[3] ? '<span class="muted">' + runtime(e[3]) + '</span>' : '') + '</div>' +
        (D.zone === 'eps' && i === D.ei && e[4] ? '<div class="epplot">' + esc(e[4]) + '</div>' : '') +
        (w ? '<div class="bar"><i style="width:' + w + '%"></i></div>' : '') + '</div></div>';
    }).join('');
    $('d-eps').classList.toggle('hidden', !eps.length);
    keepVisible($('d-eps'), $('d-eps').children[D.zone === 'eps' ? D.ei : 0]);
  }
  function detailsKey(k) {
    var D = S.det, d = D.info, ss = d && d.seasons || [], eps = ss[D.si] ? ss[D.si].eps : [];
    if (isKey(k, KEY.BACK)) { closeDetails(); return true; }
    if (D.zone === 'btns') {
      if (k === KEY.L) D.btn = Math.max(0, D.btn - 1);
      else if (k === KEY.R) D.btn = Math.min(D.btns.length - 1, D.btn + 1);
      else if (k === KEY.D && ss.length) D.zone = ss.length > 1 ? 'seasons' : 'eps';
      else if (k === KEY.OK) { if (D.btns.length) detAct(D.btns[D.btn]); return true; }
      else return k === KEY.U;
    } else if (D.zone === 'seasons') {
      if (k === KEY.L && D.si > 0) { D.si--; D.ei = 0; } else if (k === KEY.R && D.si < ss.length - 1) { D.si++; D.ei = 0; }
      else if (k === KEY.U) D.zone = 'btns';
      else if ((k === KEY.D || k === KEY.OK) && eps.length) D.zone = 'eps';
      else return true;
    } else {
      if (k === KEY.U) { if (D.ei > 0) D.ei--; else D.zone = ss.length > 1 ? 'seasons' : 'btns'; }
      else if (k === KEY.D) D.ei = Math.min(eps.length - 1, D.ei + 1);
      else if (k === KEY.OK) {
        var ep = epAt(d, D.si, D.ei), p = S.epos[ep.uuid];
        playVod(D.item, d, ep, p && p[1] && p[0] < p[1] * 0.95 ? p[0] : 0);
        return true;
      } else return true;
    }
    drawDetails();
    return true;
  }
  function detAct(b) {
    var D = S.det, c = cwOf(D.item);
    if (D.item.kind === 'movie') playVod(D.item, D.info, null, b.act === 'resume' && c ? c.pos : 0);
    else if (b.ep) playVod(D.item, D.info, b.ep, b.pos || 0);
  }

  // ---------- movie / episode player: the MP4 plays in the <video> element itself ----------
  function vodDur() { var el = $('video'); return el.duration && isFinite(el.duration) ? el.duration : (S.vod && S.vod.dur) || 0; }
  function vodTitle() { var v = S.vod; return v.info.name + (v.ep ? ' · ' + epLabel(v.ep) : ''); }
  function nextEp(v) { var d = v.info; return epAt(d, v.ep.si, v.ep.ei + 1) || epAt(d, v.ep.si + 1, 0); }
  function playVod(t, info, ep, at) {
    clearTimeout(S.loadTimer); stopVideo(); closePicker(); showOsd(false);
    var v = S.vod = { item: t, info: info, ep: ep, dur: ep ? ep.dur : info.dur, seekTo: -1, seekTimer: null, savedAt: 0, started: false };
    var el = $('video'), url = DISPATCHARR + '/proxy/vod/' + (ep ? 'episode/' + ep.uuid : 'movie/' + info.uuid);
    $('player').classList.remove('hidden');
    status('Loading…');
    el.onloadedmetadata = function () { if (at > 0 && (!el.duration || at < el.duration - 15)) el.currentTime = at; };
    el.onplaying = function () { if (S.vod !== v) return; v.started = true; status(''); };
    el.onwaiting = function () { if (S.vod === v && v.started) status('Buffering…'); };
    el.ontimeupdate = function () {
      if (S.vod !== v) return;
      if (Date.now() - v.savedAt > 5000) { v.savedAt = Date.now(); cwSave(false); }
      if (!$('vosd').classList.contains('hidden')) drawVosd();
    };
    el.onerror = function () {
      if (S.vod !== v) return;
      var code = el.error ? el.error.code : '?';
      window.tvlog('play', vodTitle() + ': video error ' + code, { url: url });
      status('This title cannot be played here (error ' + code + '). Back to return.');
    };
    el.onended = function () { if (S.vod === v) vodEnded(); };
    el.src = url;
    var pr = el.play(); if (pr && pr.catch) pr.catch(function () { /* autoplay may wait for a key press */ });
    clearTimeout(S.vodTimer);
    S.vodTimer = setTimeout(function () {
      if (S.vod === v && !v.started) { window.tvlog('play', vodTitle() + ': not started after 40 s', { url: url }); status('This title does not start. Back to return.'); }
    }, 40000);
    showVosd();
  }
  function vodEnded() {
    var v = S.vod;
    cwSave(true);
    var nx = v.ep ? nextEp(v) : null;
    if (nx) { playVod(v.item, v.info, nx, 0); status('Next: ' + epLabel(nx) + '…'); }
    else closeVod(true);
  }
  function closeVod(ended) {
    var v = S.vod;
    if (!ended) cwSave(false);
    clearTimeout(S.vodTimer); clearTimeout(S.vosdTimer); if (v) clearTimeout(v.seekTimer);
    stopVideo();
    S.vod = null;
    $('player').classList.add('hidden'); $('vosd').classList.add('hidden'); status('');
    if (S.det) {   // back on the movie / series page, with the new resume point
      var c = cwOf(S.det.item), at = c && c.ep && S.det.info ? findEp(S.det.info, c.ep.uuid) : null;
      if (at && S.det.zone !== 'eps') { S.det.si = at[0]; S.det.ei = at[1]; }
      drawDetails();
    }
  }
  function seek(d) {
    var v = S.vod, el = $('video'), dur = vodDur(), base = v.seekTo >= 0 ? v.seekTo : el.currentTime || 0;
    v.seekTo = Math.max(0, dur ? Math.min(dur - 3, base + d) : base + d);
    clearTimeout(v.seekTimer);   // a burst of presses makes one jump (one new range request to Dispatcharr)
    v.seekTimer = setTimeout(function () { if (S.vod !== v) return; el.currentTime = v.seekTo; v.seekTo = -1; drawVosd(); }, 700);
    showVosd();
  }
  function showVosd() {
    clearTimeout(S.vosdTimer);
    $('vosd').classList.remove('hidden');
    drawVosd();
    S.vosdTimer = setTimeout(function hide() {
      if (S.vod && ($('video').paused || S.vod.seekTo >= 0)) { S.vosdTimer = setTimeout(hide, 2000); return; }
      $('vosd').classList.add('hidden');
    }, 4000);
  }
  function drawVosd() {
    var v = S.vod, el = $('video');
    if (!v) return;
    var dur = vodDur(), pos = v.seekTo >= 0 ? v.seekTo : el.currentTime || 0;
    $('v-title').textContent = v.info.name;
    $('v-sub').textContent = v.ep ? epLabel(v.ep) + '  ' + v.ep.title : (v.info.year || '');
    $('v-bar').style.width = (dur ? Math.min(100, pos / dur * 100) : 0) + '%';
    $('v-pos').textContent = clockTime(pos);
    $('v-dur').textContent = dur ? '-' + clockTime(dur - pos) : '';
    $('v-state').textContent = v.seekTo >= 0 ? '→ ' + clockTime(v.seekTo) : el.paused && v.started ? '❚❚  Paused' : '';
  }
  function vodKey(k) {
    var el = $('video');
    if (isKey(k, KEY.BACK) || isKey(k, KEY.STOP)) { closeVod(); return true; }
    if (k === KEY.OK || isKey(k, KEY.PLAYPAUSE)) {
      if (k === 415) el.play(); else if (k === 19) el.pause(); else if (el.paused) el.play(); else el.pause();
      showVosd(); return true;
    }
    if (k === KEY.L) { seek(-10); return true; }
    if (k === KEY.R) { seek(10); return true; }
    if (k === KEY.D || isKey(k, KEY.RW)) { seek(-60); return true; }
    if (k === KEY.U || isKey(k, KEY.FF)) { seek(60); return true; }
    if (isKey(k, KEY.INFO)) { showVosd(); return true; }
    return false;
  }

  // ---------- keys ----------
  function onKey(e) {
    var k = e.keyCode, inInput = document.activeElement === $('q');
    if (inInput && k === 8) return;                        // Backspace edits the search text
    if (inInput && k !== KEY.U && k !== KEY.D && k !== KEY.OK && !isKey(k, [10009, 461, 27])) return;
    var handled = !$('player').classList.contains('hidden') ? playerKey(k) : S.det ? detailsKey(k) : browseKey(k);
    if (handled) e.preventDefault();
  }

  function playerKey(k) {
    if (S.vod) return vodKey(k);
    if (S.picker) {
      var n = S.playing.v.length;
      if (k === KEY.U) { S.pickIdx = (S.pickIdx - 1 + n) % n; renderPicker(); return true; }
      if (k === KEY.D) { S.pickIdx = (S.pickIdx + 1) % n; renderPicker(); return true; }
      if (k === KEY.OK) {
        var t = S.playing, v = t.v[S.pickIdx];
        delete S.bad[v.id];
        S.pref[t.key] = v.id; store.set('ver', S.pref);
        tune(0, S.pickIdx); return true;
      }
      if (isKey(k, KEY.BACK) || k === KEY.L || k === KEY.R) { closePicker(); showOsd(true); return true; }
      return true;
    }
    var osdOpen = !$('osd').classList.contains('hidden');
    if (isKey(k, KEY.PLAYPAUSE)) { var vid = $('video'); if (vid.paused) vid.play(); else vid.pause(); return true; }
    if (isKey(k, KEY.STOP)) { closePlayer(); return true; }
    if (k === KEY.U || isKey(k, KEY.CHUP)) { S.playIdx = (S.playIdx - 1 + S.playList.length) % S.playList.length; tune(350); return true; }
    if (k === KEY.D || isKey(k, KEY.CHDN)) { S.playIdx = (S.playIdx + 1) % S.playList.length; tune(350); return true; }
    if (isKey(k, KEY.FAV)) { toggleFav(S.playing); showOsd(true); return true; }
    if (k === KEY.L || k === KEY.R) {
      if (!osdOpen) showOsd(true);
      S.osdBtn = k === KEY.R ? Math.min(2, S.osdBtn + 1) : Math.max(0, S.osdBtn < 0 ? 0 : S.osdBtn - 1);
      focusBtn(); return true;
    }
    if (k === KEY.OK || isKey(k, KEY.INFO)) {
      if (osdOpen && S.osdBtn === 0) { toggleFav(S.playing); showOsd(true); return true; }
      if (osdOpen && S.osdBtn === 1) { openPicker(); return true; }
      if (osdOpen && S.osdBtn === 2) { closePlayer(); return true; }
      showOsd(!osdOpen); return true;
    }
    if (isKey(k, KEY.BACK)) { if (osdOpen) showOsd(false); else closePlayer(); return true; }
    return false;
  }

  function toSearchBox() { S.zone = 'search'; focusRow(); $('q').classList.add('focus'); $('q').focus(); }
  function leaveSearchBox() { $('q').blur(); $('q').classList.remove('focus'); }
  function toTabs() { S.zone = 'tabs'; S.tabIdx = TABS.indexOf(S.tab); renderTabs(); focusSide(); focusRow(); focusTile(); }

  function browseKey(k) {
    var n, c, i;
    if (S.zone === 'tabs') {
      if (k === KEY.L) { S.tabIdx = Math.max(0, S.tabIdx - 1); renderTabs(); return true; }
      if (k === KEY.R) { S.tabIdx = Math.min(TABS.length - 1, S.tabIdx + 1); renderTabs(); return true; }
      if (k === KEY.OK || k === KEY.D) {
        setTab(TABS[S.tabIdx]);
        if (S.tab === 'search') toSearchBox();
        else { S.zone = S.side[S.sideIdx] && S.side[S.sideIdx].kind !== 'home' ? 'side' : 'rows'; focusSide(); focusRow(); }
        renderTabs(); return true;
      }
      return isKey(k, KEY.BACK);
    }
    if (S.zone === 'search') {
      if (k === KEY.U || isKey(k, KEY.BACK)) { leaveSearchBox(); toTabs(); return true; }
      if ((k === KEY.D || k === KEY.OK) && S.rows.length) { leaveSearchBox(); S.zone = 'rows'; S.rowIdx = 0; focusRow(); return true; }
      return false;
    }
    if (S.zone === 'side') {
      if (!S.side.length) { if (k === KEY.U || isKey(k, KEY.BACK)) { toTabs(); return true; } return false; }
      if (k === KEY.U) { if (S.sideIdx === 0) toTabs(); else stepSide(-1); return true; }
      if (k === KEY.D) { stepSide(1); return true; }
      if (k === KEY.R || k === KEY.OK) {
        if (S.side[S.sideIdx].kind === 'home') { S.zone = 'rows'; focusSide(); focusRow(); }
        else if (S.list.length) { S.zone = 'grid'; S.tileIdx = 0; focusSide(); focusTile(); }
        return true;
      }
      if (isKey(k, KEY.BACK)) { if (S.sideIdx) showSide(0); else toTabs(); return true; }
      return false;
    }
    if (S.zone === 'rows') {
      var row = S.rows[S.rowIdx], search = S.tab === 'search';
      if (!row) {
        if (k === KEY.U || isKey(k, KEY.BACK)) { if (search) toSearchBox(); else toTabs(); return true; }
        return false;
      }
      n = row.t.length; c = S.rowCol[S.rowIdx];
      if (k === KEY.R) { if (c + 1 < n) { if (c + 1 >= ROW_FIRST) fillRow(S.rowIdx); S.rowCol[S.rowIdx] = c + 1; } focusRow(); return true; }
      if (k === KEY.L) {
        if (c > 0) { S.rowCol[S.rowIdx] = c - 1; focusRow(); } else if (!search) { S.zone = 'side'; focusRow(); focusSide(); }
        return true;
      }
      if (k === KEY.D) { if (S.rowIdx < S.rows.length - 1) S.rowIdx++; focusRow(); return true; }
      if (k === KEY.U) { if (S.rowIdx > 0) { S.rowIdx--; focusRow(); } else if (search) toSearchBox(); else toTabs(); return true; }
      if (k === KEY.OK && n) { activate(row.t, c); return true; }
      if (isKey(k, KEY.FAV) && n && row.t[c].kind === 'ch') { toggleFav(row.t[c]); if (S.tab === 'live') redrawBrowse(); else renderRows(); return true; }
      if (isKey(k, KEY.BACK)) {
        if (search) toSearchBox();
        else if (S.rowIdx || c) { S.rowIdx = 0; S.rowCol[0] = 0; focusRow(); }
        else { S.zone = 'side'; focusRow(); focusSide(); }
        return true;
      }
      return false;
    }
    if (S.zone === 'grid') {
      n = S.list.length; c = cols(); i = S.tileIdx;
      if (k === KEY.R) { if (i + 1 < n && (i + 1) % c) S.tileIdx = i + 1; focusTile(); return true; }
      if (k === KEY.L) { if (i % c) S.tileIdx = i - 1; else { S.zone = 'side'; focusSide(); } focusTile(); return true; }
      if (k === KEY.D) { if (i + c < n) S.tileIdx = i + c; else if (Math.floor(i / c) < Math.floor((n - 1) / c)) S.tileIdx = n - 1; focusTile(); return true; }
      if (k === KEY.U) { if (i - c >= 0) S.tileIdx = i - c; else toTabs(); focusTile(); return true; }
      if (k === KEY.OK && n) { activate(S.list, i); return true; }
      if (isKey(k, KEY.FAV) && n && S.list[i].kind === 'ch') { toggleFav(S.list[i]); redrawBrowse(); S.zone = 'grid'; focusTile(); return true; }
      if (isKey(k, KEY.BACK)) { S.zone = 'side'; focusSide(); focusTile(); return true; }
    }
    return false;
  }

  // Mouse / touch for the phone.
  function indexIn(parent, el) { return Array.prototype.indexOf.call(parent.children, el); }
  document.addEventListener('click', function (e) {
    var t = e.target;
    if (!t.closest) return;
    var tab = t.closest('.tab'), cat = t.closest('.cat'), tile = t.closest('.tile'), btn = t.closest('.btn'), pv = t.closest('.pv');
    if (!$('player').classList.contains('hidden')) {
      if (S.vod) { vodKey(KEY.OK); return; }
      if (pv) { S.pickIdx = indexIn($('picker-list'), pv); playerKey(KEY.OK); }
      else if (btn) { S.osdBtn = ['fav', 'ver', 'list'].indexOf(btn.getAttribute('data-act')); playerKey(KEY.OK); }
      else showOsd($('osd').classList.contains('hidden'));
      return;
    }
    if (S.det) {
      var D = S.det, db = t.closest('.dbtn'), se = t.closest('.season'), ep = t.closest('.ep');
      if (t.closest('.dclose')) closeDetails();
      else if (db) { D.zone = 'btns'; D.btn = indexIn($('d-btns'), db); detailsKey(KEY.OK); }
      else if (se) { D.si = indexIn($('d-seasons'), se); D.ei = 0; D.zone = 'seasons'; drawDetails(); }
      else if (ep) { D.zone = 'eps'; D.ei = indexIn($('d-eps'), ep); detailsKey(KEY.OK); }
      return;
    }
    if (tab) { S.tabIdx = TABS.indexOf(tab.getAttribute('data-tab')); S.zone = 'tabs'; browseKey(KEY.OK); }
    else if (cat) { var ci = indexIn($('cats'), cat); if (S.side[ci] && S.side[ci].kind !== 'hdr') { S.zone = 'side'; showSide(ci); } }
    else if (tile) {
      var it = itemOf(tile), rowEl = tile.closest('.row');
      if (rowEl) { var r = S.rows[indexIn(rowsBox(), rowEl)]; activate(r.t, r.t.indexOf(it)); }
      else activate(S.list, S.list.indexOf(it));
    }
  });

  function clock() { var d = new Date(); $('clock').textContent = two(d.getHours()) + ':' + two(d.getMinutes()); }

  document.addEventListener('keydown', onKey);
  $('q').addEventListener('input', function () { clearTimeout(qTimer); qTimer = setTimeout(runSearch, 300); });
  clock(); setInterval(clock, 10000);
  setInterval(function () {                               // keep "now playing" lines fresh
    if (!$('player').classList.contains('hidden') || S.tab !== 'live' && S.tab !== 'search') return;
    S.epg = {};
    var box = S.tab === 'search' ? $('srows') : (S.side[S.sideIdx] && S.side[S.sideIdx].kind === 'home' ? $('rows') : $('grid'));
    var tiles = Array.prototype.map.call(box.querySelectorAll('.tile[data-k^="c:"]'), itemOf);
    fetchEpg(tiles).then(function () { refreshNow(box); });
  }, 300000);

  setTab('live');
  var slow = setTimeout(function () {
    window.tvshow('Still loading... (the server answers slowly or a script failed; see /api/log)');
    window.tvlog('warn', 'boot screen still up after 20 s');
  }, 20000);
  load().then(function () {
    renderSide();
    showSide(0);
    S.zone = 'rows'; focusSide(); focusRow();             // start on Home, first row (favorites or last watched)
    clearTimeout(slow);
    $('boot').style.display = 'none';
    window.tvlog('info', 'ready', { tiles: S.T.length, mse: !!(window.mpegts && mpegts.getFeatureList().mseLivePlayback) });
  }).catch(function (e) {
    clearTimeout(slow);
    window.tvlog('error', 'channel list failed: ' + (e && e.message || e));
    window.tvshow('Cannot load the channel list from ' + (API || location.host) + ' (' + (e && e.message || e) + '). Retrying in 10 s.');
    setTimeout(function () { location.reload(); }, 10000);
  });
})();
