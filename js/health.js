// ============================================================================
// CWA health — data from the Android companion (CWA Health)
// ============================================================================
// The companion app (android/) uploads to users/<id>/health/<YYYY-MM-DD>:
//   hc:       one daily summary read from Health Connect (whatever writes there: a ring,
//             a watch, Samsung Health, Zepp…): { steps, distM, activeKcal, totalKcal, floors,
//             hr: {avg,min,max}, rhr, rhrEst, hrv, spo2, sleep: {min,start,end,deep,light,rem,awake},
//             weight, fat, ex: [...], sources: [package], updated }
//             rhr is a resting heart rate the wearable reported; rhrEst the app's estimate from
//             the day's heart-rate readings (lowest 30-min average) for wearables that report
//             none. ex (other apps' activities) is synced but not shown: too unreliable.
//   weighins: { <ms>: { t, kg, imp?, src } } — from a Xiaomi scale, heard over Bluetooth.
//
// This file: the daily summary maths, scale weigh-ins → Daily Log entries (with a body-
// composition estimate from the impedance), the Health screen and the companion link.
// Loaded before the main script; uses its globals (MIcon, dayKey) only at render time.
(function () {
    'use strict';
    const e = React.createElement;
    const DAY = 86400000;
    const APK_URL = 'https://github.com/alterrion-git/alterrion-git.github.io/releases/download/android-latest/cwa-health.apk';
    const PACKAGE = 'com.alt.work.health';

    const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
    const r0 = (x) => Math.round(x || 0);
    const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
    const hm = (min) => { const m = r0(min); return m >= 60 ? `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}` : `${m} min`; };

    // Package names → app names, for "data from …".
    const SOURCES = {
        'com.noisefit': 'NoiseFit (Luna)', 'com.noisefit.android': 'NoiseFit (Luna)', 'com.sec.android.app.shealth': 'Samsung Health',
        'com.garmin.android.apps.connectmobile': 'Garmin Connect', 'com.xiaomi.hm.health': 'Zepp Life', 'com.huami.watch.hmwatchmanager': 'Zepp',
        'com.google.android.apps.fitness': 'Google Fit', 'com.huawei.health': 'Huawei Health', 'com.mi.health': 'Mi Fitness',
        'com.fitbit.FitbitMobile': 'Fitbit', 'com.ouraring.oura': 'Oura', 'com.withings.wiscale2': 'Withings', 'com.polar.beat': 'Polar',
        'com.google.android.apps.healthdata': 'Health Connect', [PACKAGE]: 'CWA Health',
    };
    const sourceName = (pkg) => SOURCES[pkg] || String(pkg || '').split('.').slice(-2).join('.');

    const hcOf = (log, key) => (log && log[key] && log[key].hc) || null;
    // Resting heart rate: the wearable's own, else the estimate from its readings.
    const restingOf = (h) => (h && (h.rhr || h.rhrEst)) || null;
    const restingIsEst = (h) => !!(h && !h.rhr && h.rhrEst);
    const hrAvgOf = (h) => (h && h.hr && h.hr.avg) || null;

    // ---------- summaries ----------
    // Today, last night and 7/28-day averages (days before today), for the screen and the coach.
    function summary(log, now) {
        now = now || Date.now();
        const keys = [...Array(29)].map((_, i) => dayKey(now - i * DAY)); // [0] = today
        const today = hcOf(log, keys[0]);
        const prev = (n) => keys.slice(1, n + 1).map(k => hcOf(log, k)).filter(Boolean);
        const pick = (list, f) => list.map(f).filter(v => v != null && v > 0);
        const p7 = prev(7), p28 = prev(28);
        const sleepOf = (h) => (h && h.sleep ? h.sleep.min : null);
        const sources = new Set();
        let lastSync = 0, days = 0;
        Object.keys(log || {}).forEach(k => {
            const h = log[k] && log[k].hc;
            if (!h) return;
            days++;
            (h.sources || []).forEach(s => sources.add(s));
            if (h.updated > lastSync) lastSync = h.updated;
        });
        return {
            today, lastNight: today && today.sleep ? today.sleep : null,
            steps7: avg(pick(p7, h => h.steps)), steps28: avg(pick(p28, h => h.steps)),
            activeKcal7: avg(pick(p7, h => h.activeKcal)), totalKcal7: avg(pick(p7, h => h.totalKcal)),
            sleep7: avg(pick(p7, sleepOf)), sleep28: avg(pick(p28, sleepOf)),
            rhr7: avg(pick(p7, restingOf)), rhr28: avg(pick(p28, restingOf)), rhrEst: restingIsEst(today) || (!restingOf(today) && p7.some(restingIsEst)),
            hrAvg7: avg(pick(p7, hrAvgOf)),
            hrv7: avg(pick(p7, h => h.hrv)), spo27: avg(pick(p7, h => h.spo2)),
            sources: [...sources], lastSync, days,
        };
    }

    // ---------- body composition (Xiaomi's published-in-the-wild formulas, from impedance) ----------
    // Estimates only: needs sex, age and height from Goals.
    function bodyComposition({ kg, imp, heightCm, age, sex }) {
        if (!(kg > 0 && imp > 0 && heightCm > 0 && age > 0) || (sex !== 'male' && sex !== 'female')) return null;
        const h = heightCm, w = kg, female = sex === 'female';
        const lbm = (h * 9.058 / 100) * (h / 100) + w * 0.32 + 12.226 - imp * 0.0068 - age * 0.0542;
        const cst = female ? (age <= 49 ? 9.25 : 7.25) : 0.8;
        let coef = 1;
        if (!female && w < 61) coef = 0.98;
        else if (female && w > 60) coef = 0.96 * (h > 160 ? 1.03 : 1);
        else if (female && w < 50) coef = 1.02 * (h > 160 ? 1.03 : 1);
        let fat = (1 - ((lbm - cst) * coef) / w) * 100;
        if (fat > 63) fat = 75;
        fat = clamp(fat, 5, 75);
        let water = (100 - fat) * 0.7;
        const wc = water <= 50 ? 1.02 : 0.98;
        if (water * wc >= 65) water = 75;
        water = clamp(water * wc, 35, 75);
        let bone = -((female ? 0.245691014 : 0.18016894) - lbm * 0.05158);
        bone = bone > 2.2 ? bone + 0.1 : bone - 0.1;
        if ((female && bone > 5.1) || (!female && bone > 5.2)) bone = 8;
        bone = clamp(bone, 0.5, 8);
        let muscle = w - (fat / 100) * w - bone;
        if ((female && muscle >= 84) || (!female && muscle >= 93.5)) muscle = 120;
        muscle = clamp(muscle, 10, 120);
        const r1 = (x) => Math.round(x * 10) / 10;
        return { fat: r1(fat), water: r1(water), bone: r1(bone), muscle: r1(muscle) };
    }

    // The day's last weigh-in from the scale; Health Connect's weight when there was none.
    // With skips, weigh-ins at or before a day's skip time are left out.
    function weighInsByDay(log, skips) {
        const out = {};
        Object.keys(log || {}).forEach(k => {
            const d = log[k] || {};
            const skip = (skips && skips[k]) || 0;
            const list = Object.values(d.weighins || {}).filter(w => w && w.kg > 0 && w.t);
            let w = null;
            if (list.length) w = list.sort((a, b) => b.t - a.t)[0];
            else if (d.hc && d.hc.weight > 0) {
                const [y, m, dd] = k.split('-').map(Number);
                w = { t: new Date(y, m - 1, dd, 8, 0, 0).getTime(), kg: d.hc.weight, src: 'hc', fat: d.hc.fat };
            }
            if (w && w.t > skip) out[k] = w;
        });
        return out;
    }

    // Weigh-ins deleted from the Daily Log: { day: time of the latest deleted weigh-in }. Days
    // older than a year are dropped (their weigh-ins are out of the health read range anyway).
    function addSkip(skips, day, t, now) {
        const out = {};
        const cutoff = dayKey((now || Date.now()) - 366 * DAY);
        Object.keys(skips || {}).forEach(k => { if (k >= cutoff) out[k] = skips[k]; });
        out[day] = Math.max(out[day] || 0, t);
        return out;
    }

    // Weigh-ins → Daily Log (metrics, one entry per day). A weight typed in by hand wins; a day's
    // later weigh-in replaces an earlier one; a weigh-in deleted from the log (skips) stays out.
    // Returns the new list, or null when nothing changed.
    function mergeWeighIns(metrics, log, profile, skips) {
        const ins = weighInsByDay(log, skips);
        const days = Object.keys(ins);
        if (!days.length) return null;
        const p = profile || {};
        const age = p.birthYear ? new Date().getFullYear() - Number(p.birthYear) : null;
        const byDay = {};
        (metrics || []).forEach(m => { byDay[dayKey(m.date)] = m; });
        let changed = false;
        days.forEach(k => {
            const w = ins[k], cur = byDay[k];
            if (cur && cur.weight != null && !cur.scaleT) return; // typed in by hand
            if (cur && cur.scaleT > w.t) return;
            const bc = w.imp ? bodyComposition({ kg: w.kg, imp: w.imp, heightCm: Number(p.heightCm), age, sex: p.sex }) : null;
            const next = { ...(cur || { date: w.t }), weight: Math.round(w.kg * 10) / 10, scaleT: w.t, src: w.src || 'scale' };
            if (w.imp) next.imp = w.imp;
            if (bc) Object.assign(next, { bodyFat: bc.fat, muscleKg: bc.muscle, waterPct: bc.water, boneKg: bc.bone });
            else if (w.fat > 0) next.bodyFat = Math.round(w.fat * 10) / 10;
            if (JSON.stringify(next) === JSON.stringify(cur)) return;
            byDay[k] = next;
            changed = true;
        });
        return changed ? Object.values(byDay).sort((a, b) => a.date - b.date) : null;
    }

    // ---------- the companion link ----------
    const isAndroid = () => /Android/i.test(navigator.userAgent || '');
    // An intent:// URL that opens only our package (so the sign-in can't go to another app), or
    // the APK download when it isn't installed.
    function linkUrl({ dbUrl, uid, apiKey, refreshToken, email, weight }) {
        const q = new URLSearchParams({ db: dbUrl, u: uid, k: apiKey || '', rt: refreshToken || '', e: email || '', w: weight ? String(weight) : '' });
        return `intent://link?${q.toString()}#Intent;scheme=cwahealth;package=${PACKAGE};S.browser_fallback_url=${encodeURIComponent(APK_URL)};end`;
    }
    const actionUrl = (what) => `intent://${what}#Intent;scheme=cwahealth;package=${PACKAGE};S.browser_fallback_url=${encodeURIComponent(APK_URL)};end`;

    // ---------- the Health screen (content; the caller wraps it in its page shell) ----------
    const card = { background: 'var(--surface-container-high)' };
    const label = (t) => e('div', { className: 'text-xs uppercase tracking-widest mb-2', style: { color: 'var(--on-surface-variant)' } }, t);
    const btn = (primary) => ({ background: primary ? 'var(--primary-container)' : 'var(--surface-container-highest)', color: primary ? 'var(--on-primary-container)' : 'var(--on-surface)' });

    function Tile({ icon, title, value, unit, sub, onClick }) {
        return e(onClick ? 'button' : 'div', { onClick, className: 'rounded-2xl p-3 min-w-0 text-left' + (onClick ? ' active:scale-95 transition-transform' : ''), style: card },
            e('div', { className: 'flex items-center gap-1.5 text-[11px] uppercase tracking-widest', style: { color: 'var(--on-surface-variant)' } },
                e(MIcon, { icon, style: { fontSize: '16px', color: 'var(--primary-fixed-dim)' } }), title),
            e('div', { className: 'mt-1 flex items-baseline gap-1' },
                e('span', { className: 'text-2xl font-black', style: { fontVariantNumeric: 'tabular-nums' } }, value),
                unit ? e('span', { className: 'text-xs', style: { color: 'var(--on-surface-variant)' } }, unit) : null),
            sub ? e('div', { className: 'text-[11px] mt-0.5 truncate', style: { color: 'var(--outline)' } }, sub) : null);
    }

    // Resting heart rate when the wearable reports it (or we could estimate it), else the day's
    // average; the day's range and the 4-week resting average underneath.
    function heartTile(t, s) {
        const rest = restingOf(t), hr = t.hr || null;
        const range = hr && hr.min && hr.max ? `${r0(hr.min)}–${r0(hr.max)} bpm today` : '';
        if (rest) {
            const sub = [hr && hr.avg ? `avg ${r0(hr.avg)}` : '', range && !hr.avg ? range : '', s.rhr28 ? `4-wk ${r0(s.rhr28)}` : ''].filter(Boolean).join(' · ');
            return e(Tile, { icon: 'favorite', title: restingIsEst(t) ? 'Resting HR (est.)' : 'Resting HR', value: r0(rest), unit: 'bpm', sub });
        }
        if (hr && hr.avg) return e(Tile, { icon: 'favorite', title: 'Heart rate', value: r0(hr.avg), unit: 'bpm avg', sub: range });
        return e(Tile, { icon: 'favorite', title: 'Heart rate', value: '—', sub: s.rhr7 ? `resting 7-day ${r0(s.rhr7)}` : s.hrAvg7 ? `7-day avg ${r0(s.hrAvg7)}` : '' });
    }

    function HealthPanel({ log, metrics, profile, onLink, onRefresh, refreshing, onGoals, onWeight, now }) {
        now = now || Date.now();
        const s = summary(log, now);
        const android = isAndroid();
        const t = s.today || {};
        const latest = (metrics || []).filter(m => m.weight != null).sort((a, b) => b.date - a.date)[0];
        const needsProfile = latest && latest.imp && !(profile && profile.sex && profile.birthYear && profile.heightCm);
        const fmtN = (x) => r0(x).toLocaleString('en-US');
        const vsAvg = (v, a, unit) => (a ? `7-day avg ${fmtN(a)}${unit || ''}` : '');

        const connect = e('div', { className: 'rounded-2xl p-4 mt-3', style: card },
            label('Android app · CWA Health'),
            e('div', { className: 'text-sm', style: { color: 'var(--on-surface-variant)' } },
                s.days ? `Last sync ${s.lastSync ? new Date(s.lastSync).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—'}. Data from ${s.sources.map(sourceName).join(', ') || 'Health Connect'}.`
                    : 'Brings steps, sleep, heart rate and your Xiaomi scale\'s weigh-ins from your phone into CWA. 1) Install the app, 2) link it to this account, 3) allow Health Connect access in the app.'),
            e('div', { className: 'grid grid-cols-2 gap-2 mt-3' },
                e('a', { href: APK_URL, className: 'py-2.5 rounded-xl text-sm font-bold text-center flex items-center justify-center gap-1.5 active:scale-95', style: btn(false) },
                    e(MIcon, { icon: 'download', style: { fontSize: '18px' } }), 'Get the app'),
                e('button', { onClick: onLink, className: 'py-2.5 rounded-xl text-sm font-bold flex items-center justify-center gap-1.5 active:scale-95', style: btn(true) },
                    e(MIcon, { icon: 'link', style: { fontSize: '18px' } }), s.days ? 'Re-link app' : 'Link app')),
            android && s.days ? e('div', { className: 'grid grid-cols-2 gap-2 mt-2' },
                e('a', { href: actionUrl('weigh'), className: 'py-2.5 rounded-xl text-sm font-bold text-center active:scale-95', style: btn(false) }, 'Weigh in'),
                e('a', { href: actionUrl('sync'), className: 'py-2.5 rounded-xl text-sm font-bold text-center active:scale-95', style: btn(false) }, 'Sync phone now')) : null,
            android ? null : e('div', { className: 'text-xs mt-2', style: { color: 'var(--outline)' } }, 'Linking works on your Android phone (in Chrome or the installed CWA app).'));

        if (!s.days && !(latest && latest.scaleT)) {
            return e('div', null,
                e('div', { className: 'text-center py-6' },
                    e(MIcon, { icon: 'favorite', style: { fontSize: '44px', color: 'var(--surface-container-highest)' } }),
                    e('div', { className: 'text-base font-bold mt-2' }, 'No health data yet'),
                    e('div', { className: 'text-sm mt-1 px-6', style: { color: 'var(--on-surface-variant)' } }, 'Connect the Android app to see steps, sleep, heart rate and weigh-ins here, next to your training and food.')),
                connect);
        }

        const ln = s.lastNight;
        const rows = [...Array(14)].map((_, i) => dayKey(now - i * DAY)).map(k => {
            const h = hcOf(log, k) || {};
            const m = (metrics || []).find(x => dayKey(x.date) === k);
            return { k, h, m };
        }).filter(r => r.h.steps || (r.h.sleep && r.h.sleep.min) || restingOf(r.h) || hrAvgOf(r.h) || (r.m && r.m.weight != null));
        // Heart column: resting (the wearable's, or estimated), else the day's average (ø).
        const hrCell = (h) => (restingOf(h) ? String(r0(restingOf(h))) : hrAvgOf(h) ? `ø ${r0(hrAvgOf(h))}` : '—');

        return e('div', null,
            e('div', { className: 'flex items-center justify-between mb-2' },
                label('Today'),
                e('button', { onClick: onRefresh, disabled: refreshing, className: 'text-xs font-bold active:opacity-60 flex items-center gap-1', style: { color: 'var(--primary-fixed-dim)' } },
                    e(MIcon, { icon: 'refresh', style: { fontSize: '16px' } }), refreshing ? 'Loading…' : 'Refresh')),
            e('div', { className: 'grid grid-cols-2 gap-2' },
                e(Tile, { icon: 'directions_walk', title: 'Steps', value: t.steps ? fmtN(t.steps) : '—', sub: vsAvg(t.steps, s.steps7) }),
                e(Tile, { icon: 'bedtime', title: 'Sleep', value: ln ? hm(ln.min) : '—', sub: ln && (ln.deep || ln.rem) ? `deep ${hm(ln.deep)} · REM ${hm(ln.rem)}` : (s.sleep7 ? `7-day avg ${hm(s.sleep7)}` : '') }),
                heartTile(t, s),
                e(Tile, { icon: 'monitor_weight', title: 'Weight', onClick: onWeight, value: latest ? String(latest.weight) : '—', unit: latest ? 'kg' : '', sub: latest && latest.bodyFat != null ? `body fat ${latest.bodyFat} % · muscle ${latest.muscleKg != null ? latest.muscleKg + ' kg' : '—'}` : latest ? new Date(latest.date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : '' })),
            t.activeKcal || t.totalKcal ? e('div', { className: 'text-xs mt-2 px-1', style: { color: 'var(--on-surface-variant)' } },
                `Burned today: ${t.activeKcal ? fmtN(t.activeKcal) + ' kcal active' : ''}${t.activeKcal && t.totalKcal ? ' · ' : ''}${t.totalKcal ? fmtN(t.totalKcal) + ' kcal total' : ''}`) : null,
            needsProfile ? e('button', { onClick: onGoals, className: 'w-full mt-3 rounded-xl px-3 py-2 text-xs text-left', style: { background: 'rgba(209,252,0,0.08)', color: 'var(--on-surface)' } },
                'Your scale measures body composition. Add sex and birth year in Goals to see body fat and muscle →') : null,
            rows.length ? e('div', { className: 'mt-4' }, label('Last 14 days'),
                e('div', { className: 'rounded-2xl px-3 overflow-x-auto', style: card },
                    e('table', { className: 'w-full text-sm', style: { fontVariantNumeric: 'tabular-nums' } },
                        e('thead', null, e('tr', { style: { color: 'var(--on-surface-variant)' } }, ['', 'Steps', 'Sleep', 'Rest HR', 'kg'].map((hd, i) => e('th', { key: i, className: 'text-xs font-normal py-2 ' + (i ? 'text-right' : 'text-left') }, hd)))),
                        e('tbody', null, rows.map(({ k, h, m }) => e('tr', { key: k, style: { borderTop: '1px solid var(--surface-container-highest)' } },
                            e('td', { className: 'py-2 text-xs', style: { color: 'var(--on-surface-variant)' } }, new Date(k + 'T12:00:00').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric' })),
                            e('td', { className: 'text-right' }, h.steps ? fmtN(h.steps) : '—'),
                            e('td', { className: 'text-right' }, h.sleep && h.sleep.min ? hm(h.sleep.min) : '—'),
                            e('td', { className: 'text-right' }, hrCell(h)),
                            e('td', { className: 'text-right' }, m && m.weight != null ? m.weight : '—')))))),
                e('div', { className: 'text-[11px] mt-1.5 px-1 leading-snug', style: { color: 'var(--outline)' } },
                    'Rest HR: from your wearable, or estimated from its readings (lowest 30-minute average) when it reports none; ø = the day\u2019s average heart rate.')) : null,
            connect);
    }

    window.CWAHealth = { summary, bodyComposition, weighInsByDay, mergeWeighIns, addSkip, linkUrl, actionUrl, isAndroid, sourceName, hm, HealthPanel, APK_URL };
})();
