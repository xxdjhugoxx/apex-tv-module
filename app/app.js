/* APEX TV front end. Plain ES2017 without ?. or ?? so Tizen 4+ (Chromium 56) and webOS run it.
   Remote: arrows, OK (Enter), Back (Tizen 10009, webOS 461, Esc, Backspace outside the search box).
   One tile per channel; its versions (4K/FHD/HD/SD/H265) come best first from the server. OK plays the best
   version and falls back to the next one if it fails. Live video comes straight from Dispatcharr's MPEG-TS
   proxy and plays through mpegts.js (MSE). */
(function () {
  'use strict';
  var KEY = { L: 37, U: 38, R: 39, D: 40, OK: 13, CHUP: [427, 33], CHDN: [428, 34], BACK: [10009, 461, 27, 8], FAV: [405, 70], INFO: [457, 73],
    PLAYPAUSE: [10252, 415, 19], STOP: [413] };
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

  var S = {
    T: [], byKey: {}, side: [], rows: [], cats: [], nets: [],
    favs: store.get('favs2', []), recent: store.get('recent2', []), pref: store.get('ver', {}),
    tab: 'live', zone: 'side', tabIdx: 0, sideIdx: 0, rowIdx: 0, rowCol: [], tileIdx: 0, sTileIdx: 0,
    list: [], slist: [], epg: {},
    playing: null, playList: [], playIdx: 0, vIdx: 0, bad: {}, player: null, loadTimer: null, osdTimer: null,
    osdBtn: -1, picker: false, pickIdx: 0, watch: null
  };

  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function norm(s) { return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, ''); }
  function two(n) { return (n < 10 ? '0' : '') + n; }
  function hm(ts) { var d = new Date(ts * 1000); return two(d.getHours()) + ':' + two(d.getMinutes()); }
  function isKey(code, list) { return list.indexOf(code) >= 0; }
  function tilesOf(keys) { return keys.map(function (k) { return S.byKey[k]; }).filter(Boolean); }

  // ---------- data ----------
  function load() {
    return fetch(API + 'api/live').then(function (r) { return r.json(); }).then(function (d) {
      S.T = d.tiles.map(function (t, i) {
        return { i: i, key: t[0], name: t[1], logo: t[2], tvg: t[3], brand: t[4], nkey: norm(t[1]),
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

  function build() {
    var favs = tilesOf(S.favs), rec = tilesOf(S.recent);
    S.side = [{ kind: 'home', name: 'Home', t: [] }, { kind: 'list', name: '★ Favorites', t: favs }]
      .concat(rec.length ? [{ kind: 'list', name: 'Recently watched', t: rec }] : [])
      .concat([{ kind: 'hdr', name: 'Networks' }], S.nets, [{ kind: 'hdr', name: 'Provider categories' }], S.cats);
    S.rows = [{ name: '★ Favorites', t: favs, empty: 'Press ★ (yellow) or F on a channel, or ★ Favorite in the player.' }]
      .concat(rec.length ? [{ name: 'Recently watched', t: rec }] : [], S.serverRows);
    if (!favs.length && rec.length) S.rows.push(S.rows.shift());   // an empty favorites row goes last, not first
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

  // ---------- tiles ----------
  function tileHtml(t) {
    var p = nowProg(t), fav = S.favs.indexOf(t.key) >= 0, best = t.v[0];
    var vers = (best.label !== 'Standard' ? best.label.split(' ')[0] : '') + (t.v.length > 1 ? ' +' + (t.v.length - 1) : '');
    return '<div class="tile" data-i="' + t.i + '"><div class="art">' +
      (best.num ? '<span class="num">' + esc(best.num) + '</span>' : '') + (fav ? '<span class="fav">★</span>' : '') +
      (t.logo ? '<img data-src="' + esc(t.logo) + '" alt="">' : '') + (vers ? '<span class="vers">' + esc(vers) + '</span>' : '') +
      '</div><div class="meta"><div class="name">' + esc(t.name) + '</div><div class="now">' + (p && p.now ? esc(p.now[2]) : '') + '</div>' +
      '<div class="bar"><i style="width:' + (p && p.now ? pct(p.now) : 0) + '%"></i></div></div></div>';
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
    var els = root.querySelectorAll('.tile');
    for (var i = 0; i < els.length; i++) {
      var p = nowProg(S.T[+els[i].getAttribute('data-i')]);
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

  // ---------- sidebar ----------
  function renderSide() {
    $('cats').innerHTML = S.side.map(function (c) {
      return c.kind === 'hdr' ? '<div class="cat hdr">' + esc(c.name) + '</div>'
        : '<div class="cat">' + esc(c.name) + (c.kind === 'home' ? '' : '<span class="n">' + c.t.length + '</span>') + '</div>';
    }).join('');
    focusSide();
  }
  function focusSide() {
    var els = $('cats').children;
    for (var i = 0; i < els.length; i++) {
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
    else { S.list = item.t; S.tileIdx = 0; renderGrid('grid', S.list, item.name === '★ Favorites' ? 'No favorites yet.' : 'No channels.'); }
    focusSide();
  }

  // ---------- home rows ----------
  function renderRows() {
    var box = $('rows');
    box.innerHTML = S.rows.map(function (r, ri) {
      return '<div class="row"><h3>' + esc(r.name) + '</h3><div class="track"><div class="strip">' +
        (r.t.length ? r.t.slice(0, ROW_FIRST).map(tileHtml).join('') : '<div class="msg">' + esc(r.empty || '') + '</div>') + '</div></div></div>';
    }).join('');
    S.rowCol = S.rows.map(function () { return 0; });
    S.rowFull = {};
    lazyImgs(box);
    var vis = []; S.rows.forEach(function (r) { vis = vis.concat(r.t.slice(0, ROW_FIRST)); });
    fetchEpg(vis).then(function () { refreshNow(box); });
    focusRow();
  }
  function fillRow(ri) {
    if (S.rowFull[ri] || S.rows[ri].t.length <= ROW_FIRST) return;
    S.rowFull[ri] = 1;
    var strip = $('rows').children[ri].querySelector('.strip');
    strip.insertAdjacentHTML('beforeend', S.rows[ri].t.slice(ROW_FIRST).map(tileHtml).join(''));
    lazyImgs(strip);
    fetchEpg(S.rows[ri].t).then(function () { refreshNow(strip); });
  }
  function focusRow() {
    var rows = $('rows').children;
    var old = $('rows').querySelector('.tile.focus'); if (old) old.className = 'tile';
    for (var r = 0; r < rows.length; r++) rows[r].className = 'row' + (S.zone === 'rows' && r === S.rowIdx ? ' focus' : '');
    var row = rows[S.rowIdx]; if (!row) return;
    var tiles = row.querySelectorAll('.tile'), c = S.rowCol[S.rowIdx], el = tiles[c];
    if (el && S.zone === 'rows') el.className = 'tile focus';
    if (el) {
      var w = el.offsetWidth + parseFloat(getComputedStyle(el).marginRight);
      row.querySelector('.strip').style.transform = 'translateX(' + (-Math.max(0, c - 1) * w) + 'px)';
    }
    keepVisible($('rows'), row);
  }

  // ---------- grids (network, category, search) ----------
  function renderGrid(gridId, list, emptyMsg) {
    var g = $(gridId);
    g.innerHTML = list.length ? list.map(tileHtml).join('') : '<div class="msg">' + emptyMsg + '</div>';
    g.scrollTop = 0;
    lazyImgs(g);
    focusTile();
    fetchEpg(list).then(function () { refreshNow(g); });
  }
  function curGrid() { return S.tab === 'search' ? { id: 'sgrid', list: S.slist, idx: 'sTileIdx' } : { id: 'grid', list: S.list, idx: 'tileIdx' }; }
  function focusTile() {
    var g = curGrid(), els = $(g.id).querySelectorAll('.tile');
    for (var i = 0; i < els.length; i++) els[i].className = 'tile' + (S.zone === 'grid' && i === S[g.idx] ? ' focus' : '');
    if (els[S[g.idx]]) keepVisible($(g.id), els[S[g.idx]]);
  }
  function cols(gridId) {
    var g = $(gridId), t = g.querySelector('.tile');
    if (!t) return 1;
    var w = t.offsetWidth + parseFloat(getComputedStyle(t).marginRight);
    return Math.max(1, Math.floor((g.clientWidth - 20) / w));
  }

  function setTab(t) {
    S.tab = t;
    $('view-live').classList.toggle('hidden', t !== 'live');
    $('view-search').classList.toggle('hidden', t !== 'search');
    $('view-vod').classList.toggle('hidden', t !== 'movies' && t !== 'series');
    $('vod-title').textContent = t === 'series' ? 'Series' : 'Movies';
    renderTabs();
  }
  function renderTabs() {
    var els = document.querySelectorAll('.tab');
    for (var i = 0; i < els.length; i++) els[i].className = 'tab' + (TABS[i] === S.tab ? ' active' : '') + (S.zone === 'tabs' && S.tabIdx === i ? ' focus' : '');
  }

  // ---------- search ----------
  var qTimer = null;
  function runSearch() {
    var q = norm($('q').value.trim());
    S.slist = q.length < 2 ? [] : S.T.filter(function (t) { return t.nkey.indexOf(q) >= 0; }).slice(0, 200);
    S.sTileIdx = 0;
    renderGrid('sgrid', S.slist, q.length < 2 ? 'Type at least 2 letters.' : 'No channel matches.');
  }

  // ---------- favorites / recent ----------
  function toggleFav(t) {
    var i = S.favs.indexOf(t.key);
    if (i >= 0) S.favs.splice(i, 1); else S.favs.unshift(t.key);
    store.set('favs2', S.favs);
    build();
  }
  function addRecent(t) {
    S.recent = [t.key].concat(S.recent.filter(function (x) { return x !== t.key; })).slice(0, 24);
    store.set('recent2', S.recent);
  }
  function redrawBrowse() {   // after favorites/recent change: rebuild what is on screen, keep the focus
    var side = S.side[S.sideIdx], name = side && side.name, cols = {}, rowName = S.rows[S.rowIdx] && S.rows[S.rowIdx].name, tile = S.tileIdx;
    S.rows.forEach(function (r, ri) { cols[r.name] = S.rowCol[ri] || 0; });   // rows move when Recently watched appears
    build();
    var i = 0; while (i < S.side.length && S.side[i].name !== name) i++;
    S.sideIdx = i < S.side.length ? i : 0;
    renderSide();
    if (S.side[S.sideIdx].kind === 'home') {
      renderRows();
      S.rowIdx = Math.max(0, S.rows.map(function (r) { return r.name; }).indexOf(rowName));
      S.rowCol = S.rows.map(function (r) { return Math.min(cols[r.name] || 0, Math.max(0, r.t.length - 1)); });
      S.rows.forEach(function (r, ri) { if (S.rowCol[ri] >= ROW_FIRST) fillRow(ri); });
      focusRow();
    } else { S.list = S.side[S.sideIdx].t; renderGrid('grid', S.list, 'No channels.'); S.tileIdx = Math.min(tile, Math.max(0, S.list.length - 1)); focusTile(); }
  }

  // ---------- player ----------
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
    // Progress means new decoded video frames, not a moving clock: audio alone (or latency chasing) moves
    // currentTime while the picture stays frozen. No new frame for 10 s, at start or mid-play, is a failure.
    var since = Date.now(), last = -1, mine = S.player;
    clearInterval(S.watch);
    S.watch = setInterval(function () {
      if (S.player !== mine) { clearInterval(S.watch); return; }
      var f = frames(el);
      if (f > last && el.videoWidth > 0) { last = f; since = Date.now(); if ($('status').textContent) status(''); }
      else if (Date.now() - since > 10000) { clearInterval(S.watch); failed(last < 0 ? 'no video' : 'stalled'); }
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
    var v = $('video'); v.removeAttribute('src'); try { v.load(); } catch (e) { /* ignore */ }
  }
  function closePlayer() {
    clearTimeout(S.loadTimer); stopVideo(); closePicker();
    $('player').classList.add('hidden');
    showOsd(false); status('');
    if (S.tab === 'live') {
      var cur = S.playing;
      redrawBrowse();
      if (S.zone === 'rows') {
        var c = S.rows[S.rowIdx].t.indexOf(cur);
        if (c >= 0) { if (c >= ROW_FIRST) fillRow(S.rowIdx); S.rowCol[S.rowIdx] = c; }
        focusRow();
      } else { var i = S.list.indexOf(cur); if (i >= 0) S.tileIdx = i; S.zone = 'grid'; focusTile(); }
    } else { S.zone = 'grid'; focusTile(); }
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

  // ---------- keys ----------
  function onKey(e) {
    var k = e.keyCode, inInput = document.activeElement === $('q');
    if (inInput && k === 8) return;                        // Backspace edits the search text
    if (inInput && k !== KEY.U && k !== KEY.D && k !== KEY.OK && !isKey(k, [10009, 461, 27])) return;
    var handled = !$('player').classList.contains('hidden') ? playerKey(k) : browseKey(k);
    if (handled) e.preventDefault();
  }

  function playerKey(k) {
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

  function toSearchBox() { S.zone = 'search'; $('q').classList.add('focus'); $('q').focus(); }
  function leaveSearchBox() { $('q').blur(); $('q').classList.remove('focus'); }
  function toTabs() { S.zone = 'tabs'; S.tabIdx = TABS.indexOf(S.tab); renderTabs(); focusSide(); focusRow(); focusTile(); }

  function browseKey(k) {
    var g, n, c, i;
    if (S.zone === 'tabs') {
      if (k === KEY.L) { S.tabIdx = Math.max(0, S.tabIdx - 1); renderTabs(); return true; }
      if (k === KEY.R) { S.tabIdx = Math.min(TABS.length - 1, S.tabIdx + 1); renderTabs(); return true; }
      if (k === KEY.OK || k === KEY.D) {
        setTab(TABS[S.tabIdx]);
        if (S.tab === 'live') { S.zone = S.side[S.sideIdx].kind === 'home' ? 'rows' : 'side'; focusSide(); focusRow(); }
        else if (S.tab === 'search') toSearchBox();
        renderTabs(); return true;
      }
      return isKey(k, KEY.BACK);
    }
    if (S.zone === 'search') {
      if (k === KEY.U || isKey(k, KEY.BACK)) { leaveSearchBox(); toTabs(); return true; }
      if ((k === KEY.D || k === KEY.OK) && S.slist.length) { leaveSearchBox(); S.zone = 'grid'; S.sTileIdx = 0; focusTile(); return true; }
      return false;
    }
    if (S.zone === 'side') {
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
      var row = S.rows[S.rowIdx]; n = row.t.length; c = S.rowCol[S.rowIdx];
      if (k === KEY.R) { if (c + 1 < n) { if (c + 1 >= ROW_FIRST) fillRow(S.rowIdx); S.rowCol[S.rowIdx] = c + 1; } focusRow(); return true; }
      if (k === KEY.L) { if (c > 0) { S.rowCol[S.rowIdx] = c - 1; focusRow(); } else { S.zone = 'side'; focusRow(); focusSide(); } return true; }
      if (k === KEY.D) { if (S.rowIdx < S.rows.length - 1) S.rowIdx++; focusRow(); return true; }
      if (k === KEY.U) { if (S.rowIdx > 0) { S.rowIdx--; focusRow(); } else toTabs(); return true; }
      if (k === KEY.OK && n) { play(row.t, c); return true; }
      if (isKey(k, KEY.FAV) && n) { toggleFav(row.t[c]); redrawBrowse(); return true; }
      if (isKey(k, KEY.BACK)) { if (S.rowIdx || c) { S.rowIdx = 0; S.rowCol[0] = 0; focusRow(); } else { S.zone = 'side'; focusRow(); focusSide(); } return true; }
      return false;
    }
    if (S.zone === 'grid') {
      g = curGrid(); n = g.list.length; c = cols(g.id); i = S[g.idx];
      if (k === KEY.R) { if (i + 1 < n && (i + 1) % c) S[g.idx] = i + 1; focusTile(); return true; }
      if (k === KEY.L) { if (i % c) S[g.idx] = i - 1; else if (S.tab === 'live') { S.zone = 'side'; focusSide(); } focusTile(); return true; }
      if (k === KEY.D) { if (i + c < n) S[g.idx] = i + c; else if (Math.floor(i / c) < Math.floor((n - 1) / c)) S[g.idx] = n - 1; focusTile(); return true; }
      if (k === KEY.U) {
        if (i - c >= 0) S[g.idx] = i - c; else if (S.tab === 'search') toSearchBox(); else toTabs();
        focusTile(); return true;
      }
      if (k === KEY.OK && n) { play(g.list, i); return true; }
      if (isKey(k, KEY.FAV) && n) { toggleFav(g.list[i]); if (S.tab === 'live') redrawBrowse(); else renderGrid(g.id, g.list, ''); S.zone = 'grid'; S[g.idx] = Math.min(i, curGrid().list.length - 1); focusTile(); return true; }
      if (isKey(k, KEY.BACK)) { if (S.tab === 'live') { S.zone = 'side'; focusSide(); } else toSearchBox(); focusTile(); return true; }
    }
    return false;
  }

  // Mouse / touch for the phone.
  document.addEventListener('click', function (e) {
    var t = e.target;
    if (!t.closest) return;
    var tab = t.closest('.tab'), cat = t.closest('.cat'), tile = t.closest('.tile'), btn = t.closest('.btn'), pv = t.closest('.pv');
    if (!$('player').classList.contains('hidden')) {
      if (pv) { S.pickIdx = Array.prototype.indexOf.call($('picker-list').children, pv); playerKey(KEY.OK); }
      else if (btn) { S.osdBtn = ['fav', 'ver', 'list'].indexOf(btn.getAttribute('data-act')); playerKey(KEY.OK); }
      else showOsd($('osd').classList.contains('hidden'));
      return;
    }
    if (tab) { S.tabIdx = TABS.indexOf(tab.getAttribute('data-tab')); S.zone = 'tabs'; browseKey(KEY.OK); }
    else if (cat) { var ci = Array.prototype.indexOf.call($('cats').children, cat); if (S.side[ci].kind !== 'hdr') { S.zone = 'side'; showSide(ci); } }
    else if (tile) {
      var ti = S.T[+tile.getAttribute('data-i')], rowEl = tile.closest('.row');
      if (rowEl) { var ri = Array.prototype.indexOf.call($('rows').children, rowEl); play(S.rows[ri].t, S.rows[ri].t.indexOf(ti)); }
      else { var gl = curGrid().list; play(gl, gl.indexOf(ti)); }
    }
  });

  function clock() { var d = new Date(); $('clock').textContent = two(d.getHours()) + ':' + two(d.getMinutes()); }

  document.addEventListener('keydown', onKey);
  $('q').addEventListener('input', function () { clearTimeout(qTimer); qTimer = setTimeout(runSearch, 250); });
  clock(); setInterval(clock, 10000);
  setInterval(function () {                               // keep "now playing" lines fresh
    if (!$('player').classList.contains('hidden')) return;
    S.epg = {};
    var box = S.tab === 'search' ? $('sgrid') : (S.side[S.sideIdx] && S.side[S.sideIdx].kind === 'home' ? $('rows') : $('grid'));
    var tiles = Array.prototype.map.call(box.querySelectorAll('.tile'), function (el) { return S.T[+el.getAttribute('data-i')]; });
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
