// ============================================================================
// CWA watch controls (experiment) — drive a workout from the watch's music controls
// ============================================================================
// Watches that control the phone's music (Huawei, Galaxy, Garmin, Amazfit…) send their
// buttons to whatever is "playing" on the phone. During a workout this plays a near-silent
// loop, so CWA is what's playing (Media Session API), and the watch's music screen shows the
// current exercise:
//   ⏭ next      → set done (and the rest timer starts)
//   ⏯ play/pause → start / stop the rest timer
//   ⏮ previous  → back one set
// The rest end beeps (scheduled on the audio clock, so it's on time even with the screen
// off). Catch: while it's on, CWA holds the phone's audio focus, so Spotify and other music
// pause. Off by default; Settings › Watch controls. Settings are per device (localStorage).
// Loaded before the main script.
(function () {
    'use strict';
    const KEY = 'cwa-watch-controls', REST_KEY = 'cwa-watch-rest';
    const REST_OPTIONS = [60, 90, 120, 180];
    const ls = (k, v) => { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch (e) { return null; } return null; };

    const supported = () => typeof navigator !== 'undefined' && 'mediaSession' in navigator && typeof MediaMetadata !== 'undefined' && typeof Audio !== 'undefined';
    const enabled = () => ls(KEY) === '1';
    const restSeconds = () => { const v = parseInt(ls(REST_KEY) || '90', 10); return v >= 15 && v <= 600 ? v : 90; };
    function setEnabled(on) { ls(KEY, on ? '1' : '0'); if (!on) stop(); }
    function setRestSeconds(s) { ls(REST_KEY, String(s)); }

    // ---------- the near-silent loop ----------
    // 10 s of a 50 Hz tone at -60 dBFS (8 kHz, 16-bit mono WAV): inaudible, but not digital
    // silence, which some phones treat as "nothing playing". 500 whole cycles, so it loops
    // without a click. Media notifications need at least ~5 s of media.
    function quietLoopUrl() {
        const rate = 8000, secs = 10, n = rate * secs;
        const buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
        const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
        str(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); str(8, 'WAVE');
        str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
        v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
        str(36, 'data'); v.setUint32(40, n * 2, true);
        for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.round(33 * Math.sin(2 * Math.PI * 50 * i / rate)), true);
        return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
    }

    let audio = null, ctx = null, beeps = [], endTimer = null;
    let handlers = {};
    let info = null; // what the watch shows: { exercise, set, load, workout }
    const rest = { on: false, end: 0, total: 0, done: false };
    const ms = () => navigator.mediaSession;
    const notify = () => { try { handlers.change && handlers.change(); } catch (e) {} };

    const hms = (t) => new Date(t).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    function render() {
        if (!supported() || !audio) return;
        const i = info || {};
        const now = `${i.exercise || 'Workout'}${i.set ? ' · ' + i.set : ''}`;
        let title = now, artist = i.load || '';
        if (rest.on) { title = `Rest · until ${hms(rest.end)}`; artist = `Next: ${now}${i.load ? ' · ' + i.load : ''}`; }
        else if (rest.done) { title = `Go! ${now}`; }
        try {
            ms().metadata = new MediaMetadata({
                title, artist, album: i.workout || 'CWA workout',
                artwork: [{ src: new URL('icon-512.png', location.href).href, sizes: '512x512', type: 'image/png' }],
            });
        } catch (e) {}
        // The rest as the "track" progress (it advances on the watch by itself); a live stream
        // otherwise, so the 10 s loop doesn't show as a progress bar.
        try {
            if (rest.on) ms().setPositionState({ duration: rest.total, playbackRate: 1, position: Math.min(rest.total, Math.max(0, rest.total - (rest.end - Date.now()) / 1000)) });
            else ms().setPositionState({ duration: Infinity, playbackRate: 1, position: 0 });
        } catch (e) {}
    }

    // ---------- rest timer ----------
    function cancelBeeps() { beeps.forEach(o => { try { o.stop(0); o.disconnect(); } catch (e) {} }); beeps = []; }
    function scheduleBeeps(inSec) {
        cancelBeeps();
        if (!ctx) return;
        try {
            const t0 = ctx.currentTime + inSec;
            [0, 0.3, 0.6].forEach((dt, k) => {
                const osc = ctx.createOscillator(), gain = ctx.createGain();
                osc.frequency.value = k === 2 ? 1320 : 880;
                gain.gain.setValueAtTime(0, t0 + dt);
                gain.gain.linearRampToValueAtTime(0.5, t0 + dt + 0.02);
                gain.gain.linearRampToValueAtTime(0, t0 + dt + 0.18);
                osc.connect(gain).connect(ctx.destination);
                osc.start(t0 + dt); osc.stop(t0 + dt + 0.2);
                beeps.push(osc);
            });
        } catch (e) {}
    }
    function endRest() {
        clearTimeout(endTimer);
        if (!rest.on) return;
        rest.on = false; rest.done = true;
        try { navigator.vibrate && navigator.vibrate([250, 120, 250]); } catch (e) {}
        render(); notify();
    }
    function startRest(sec) {
        if (!audio) return;
        const s = sec || restSeconds();
        rest.on = true; rest.done = false; rest.total = s; rest.end = Date.now() + s * 1000;
        scheduleBeeps(s);
        clearTimeout(endTimer);
        endTimer = setTimeout(endRest, s * 1000 + 50);
        render(); notify();
    }
    function stopRest() {
        clearTimeout(endTimer); cancelBeeps();
        if (!rest.on && !rest.done) return;
        rest.on = false; rest.done = false;
        render(); notify();
    }
    const toggleRest = () => (rest.on ? stopRest() : startRest());
    // Seconds left (0 when not resting); also ends a rest whose timer ran late.
    function restLeft() {
        if (!rest.on) return 0;
        const left = Math.ceil((rest.end - Date.now()) / 1000);
        if (left <= 0) { endRest(); return 0; }
        return left;
    }

    // ---------- session ----------
    // Must be called from a tap (browsers only start audio after one). → 'on' | 'blocked' | 'unsupported'
    async function start(actions) {
        if (!supported()) return 'unsupported';
        handlers = actions || {};
        if (!audio) {
            audio = new Audio(quietLoopUrl());
            audio.loop = true;
            audio.setAttribute('playsinline', '');
        }
        try { await audio.play(); }
        catch (e) { return 'blocked'; }
        try {
            const AC = window.AudioContext || window.webkitAudioContext;
            if (!ctx && AC) ctx = new AC();
            if (ctx && ctx.state !== 'running') await ctx.resume();
        } catch (e) {}
        const set = (action, fn) => { try { ms().setActionHandler(action, fn); } catch (e) {} };
        set('nexttrack', () => { handlers.next && handlers.next(); });
        set('previoustrack', () => { handlers.prev && handlers.prev(); });
        // The watch shows play or pause depending on the state; both mean "rest on/off". The
        // loop keeps playing either way, so the watch keeps talking to CWA.
        set('play', () => { if (audio && audio.paused) audio.play().catch(() => {}); toggleRest(); });
        set('pause', toggleRest);
        set('stop', () => stop());
        try { ms().playbackState = 'playing'; } catch (e) {}
        render(); notify();
        return 'on';
    }
    function stop() {
        clearTimeout(endTimer); cancelBeeps();
        rest.on = false; rest.done = false;
        if (audio) { try { audio.pause(); } catch (e) {} }
        if (supported()) {
            ['nexttrack', 'previoustrack', 'play', 'pause', 'stop'].forEach(a => { try { ms().setActionHandler(a, null); } catch (e) {} });
            try { ms().metadata = null; ms().playbackState = 'none'; } catch (e) {}
        }
        const h = handlers; handlers = {};
        try { h.change && h.change(); } catch (e) {}
    }
    const active = () => !!audio && !audio.paused;
    function update(next) { info = next; render(); }

    window.CWAWatch = {
        supported, enabled, setEnabled, restSeconds, setRestSeconds, REST_OPTIONS,
        start, stop, active, update, startRest, stopRest, toggleRest, restLeft,
        resting: () => rest.on, restDone: () => rest.done,
    };
})();
