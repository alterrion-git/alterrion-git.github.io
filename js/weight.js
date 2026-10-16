// ============================================================================
// CWA weight — the weight chart (Profile › tap your weight)
// ============================================================================
// One series (the Daily Log's weights, typed or from the scale) over 1, 3, 6 or 12 months:
// a line with a crosshair readout, the latest value at the line's end, the range's change
// and low/high above it, and the same numbers as a list below (the chart's table twin).
// Loaded before the main script; uses its globals (MIcon) only at render time.
(function () {
    'use strict';
    const { useState, useRef, useLayoutEffect, useEffect } = React;
    const e = React.createElement;
    const DAY = 86400000;
    const RANGES = [
        { id: '1M', days: 30, name: 'month' },
        { id: '3M', days: 91, name: '3 months' },
        { id: '6M', days: 182, name: '6 months' },
        { id: '1Y', days: 365, name: 'year' },
    ];
    const RANGE_KEY = 'cwa-weight-range';
    const ACCENT = 'var(--primary-container)';
    const SURFACE = 'var(--surface-container-high)'; // the chart card
    const GRID = 'var(--surface-container-highest)';
    const MUTED = 'var(--outline)';

    const fmtKg = (x) => (Math.round(x * 10) / 10).toFixed(1);
    const signed = (x) => (x > 0.04 ? '+' : x < -0.04 ? '−' : '±') + fmtKg(Math.abs(x));
    // Weekly rates are small: two decimals under 1 kg.
    const signedRate = (x) => (Math.abs(x) >= 1 ? signed(x) : (x > 0.004 ? '+' : x < -0.004 ? '−' : '±') + Math.abs(x).toFixed(2));
    const fmtDay = (t, opts) => new Date(t).toLocaleDateString('en-GB', opts || { day: 'numeric', month: 'short' });

    // ---------- data ----------
    // The Daily Log's weights, oldest first.
    function weightSeries(metrics) {
        return (metrics || [])
            .filter(m => m && m.weight != null && Number(m.weight) > 0 && Number.isFinite(Number(m.date)))
            .map(m => ({ t: Number(m.date), kg: Number(m.weight), scale: !!m.scaleT, fat: m.bodyFat != null ? Number(m.bodyFat) : null }))
            .sort((a, b) => a.t - b.t);
    }

    // The points in a range, and the x domain: the range, or from the first weight when the log
    // starts later (so a new log isn't a dot at the right edge of an empty year).
    function rangeView(series, rangeId, now) {
        const r = RANGES.find(x => x.id === rangeId) || RANGES[1];
        const from = now - r.days * DAY;
        const pts = series.filter(p => p.t >= from && p.t <= now + DAY);
        const start = pts.length ? Math.min(Math.max(from, pts[0].t - 2 * DAY), now - 7 * DAY) : from;
        const first = pts[0], last = pts[pts.length - 1];
        let low = null, high = null;
        pts.forEach(p => { if (!low || p.kg < low.kg) low = p; if (!high || p.kg > high.kg) high = p; });
        const weeks = first && last ? (last.t - first.t) / (7 * DAY) : 0;
        return {
            range: r, from: start, to: now, pts, low, high,
            change: pts.length >= 2 ? last.kg - first.kg : null,
            perWeek: pts.length >= 2 && weeks >= 2 ? (last.kg - first.kg) / weeks : null,
            older: series.length > pts.length && series[0].t < from,
        };
    }

    // Clean y ticks (0.1 / 0.2 / 0.5 / 1 / 2 / 5 / 10 kg apart) covering min..max with some air.
    function niceScale(min, max, maxTicks) {
        maxTicks = maxTicks || 5;
        if (!(max > min)) { min -= 1; max += 1; }
        const pad = Math.max((max - min) * 0.12, 0.3);
        const lo = min - pad, hi = max + pad;
        const steps = [0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50];
        const step = steps.find(s => Math.floor(hi / s) - Math.ceil(lo / s) + 1 <= maxTicks) || 100;
        const a = Math.floor(lo / step) * step, b = Math.ceil(hi / step) * step;
        const ticks = [];
        for (let v = a; v <= b + step / 2; v += step) ticks.push(Math.round(v * 10) / 10);
        return { min: a, max: b, ticks, step };
    }

    // Date labels that fit: month starts for 3+ months, otherwise every few days.
    function xTicks(from, to, width) {
        const most = Math.max(2, Math.floor(width / 52));
        const out = [];
        if (to - from > 45 * DAY) {
            const d = new Date(from); d.setDate(1); d.setHours(0, 0, 0, 0); d.setMonth(d.getMonth() + 1);
            for (; d.getTime() <= to; d.setMonth(d.getMonth() + 1)) out.push({ t: d.getTime(), label: d.toLocaleDateString('en-GB', { month: 'short' }) });
        } else {
            const end = new Date(to); end.setHours(0, 0, 0, 0);
            for (let t = end.getTime(); t >= from; t -= 7 * DAY) out.unshift({ t, label: fmtDay(t) });
        }
        const every = Math.ceil(out.length / most);
        return every > 1 ? out.filter((_, i) => (out.length - 1 - i) % every === 0) : out;
    }

    // ---------- the chart ----------
    const M = { top: 14, right: 46, bottom: 26, left: 38 };
    const PLOT_H = 190;

    function WeightChart({ view }) {
        const wrap = useRef(null);
        const [w, setW] = useState(0);
        const [active, setActive] = useState(null); // index into view.pts
        useLayoutEffect(() => {
            const el = wrap.current;
            if (!el) return undefined;
            const measure = () => setW(Math.round(el.getBoundingClientRect().width));
            measure();
            if (typeof ResizeObserver === 'undefined') { window.addEventListener('resize', measure); return () => window.removeEventListener('resize', measure); }
            const ro = new ResizeObserver(measure); ro.observe(el);
            return () => ro.disconnect();
        }, []);
        useEffect(() => { setActive(null); }, [view.range.id, view.pts.length]);

        const pts = view.pts;
        const H = M.top + PLOT_H + M.bottom;
        const plotW = Math.max(10, w - M.left - M.right);
        const ys = niceScale(Math.min(...pts.map(p => p.kg)), Math.max(...pts.map(p => p.kg)), 5);
        const x = (t) => M.left + ((t - view.from) / Math.max(1, view.to - view.from)) * plotW;
        const y = (kg) => M.top + (1 - (kg - ys.min) / (ys.max - ys.min)) * PLOT_H;
        const xy = pts.map(p => [x(p.t), y(p.kg)]);
        const line = xy.map(([a, b], i) => (i ? 'L' : 'M') + a.toFixed(1) + ' ' + b.toFixed(1)).join(' ');
        const area = xy.length > 1 ? `${line} L${xy[xy.length - 1][0].toFixed(1)} ${M.top + PLOT_H} L${xy[0][0].toFixed(1)} ${M.top + PLOT_H} Z` : '';
        const showDots = pts.length <= 45;
        const last = pts.length - 1;

        const nearest = (clientX) => {
            const el = wrap.current;
            if (!el || !pts.length) return null;
            const px = clientX - el.getBoundingClientRect().left;
            let best = 0;
            xy.forEach(([a], i) => { if (Math.abs(a - px) < Math.abs(xy[best][0] - px)) best = i; });
            return best;
        };
        const onMove = (ev) => { const i = nearest(ev.clientX); if (i != null) setActive(i); };
        const onKey = (ev) => {
            const cur = active == null ? last : active;
            const next = ev.key === 'ArrowLeft' ? cur - 1 : ev.key === 'ArrowRight' ? cur + 1 : ev.key === 'Home' ? 0 : ev.key === 'End' ? last : null;
            if (next == null) { if (ev.key === 'Escape') setActive(null); return; }
            ev.preventDefault();
            setActive(Math.max(0, Math.min(last, next)));
        };

        const a = active != null ? pts[active] : null;
        const tipW = 132;
        const tipLeft = a ? Math.max(0, Math.min(w - tipW, xy[active][0] - tipW / 2)) : 0;
        const desc = `Weight over the last ${view.range.name}: ${pts.length} entries` + (view.change != null ? `, ${signed(view.change)} kg` : '') + `. Latest ${fmtKg(pts[last].kg)} kg.`;

        return e('div', { ref: wrap, className: 'relative select-none', style: { height: H } },
            w > 0 ? e('svg', {
                width: w, height: H, viewBox: `0 0 ${w} ${H}`, role: 'img', 'aria-label': desc, tabIndex: 0, onKeyDown: onKey,
                onPointerMove: onMove, onPointerDown: onMove,
                onPointerLeave: (ev) => { if (ev.pointerType === 'mouse') setActive(null); },
                style: { display: 'block', touchAction: 'pan-y', outline: 'none', fontVariantNumeric: 'tabular-nums' },
            },
                // y grid + labels
                ys.ticks.map(v => e('g', { key: 'y' + v },
                    e('line', { x1: M.left, x2: M.left + plotW, y1: y(v), y2: y(v), stroke: GRID, strokeWidth: 1, shapeRendering: 'crispEdges' }),
                    e('text', { x: M.left - 8, y: y(v), dy: '0.32em', textAnchor: 'end', fontSize: 11, fill: MUTED }, ys.step < 1 ? v.toFixed(1) : String(v)))),
                // x labels
                xTicks(view.from, view.to, plotW).map(tk => e('text', { key: 'x' + tk.t, x: x(tk.t), y: M.top + PLOT_H + 18, textAnchor: 'middle', fontSize: 11, fill: MUTED }, tk.label)),
                // the series
                area ? e('path', { d: area, fill: ACCENT, fillOpacity: 0.08, stroke: 'none' }) : null,
                xy.length > 1 ? e('path', { d: line, fill: 'none', stroke: ACCENT, strokeWidth: 2, strokeLinejoin: 'round', strokeLinecap: 'round' }) : null,
                showDots ? xy.map(([cx, cy], i) => i === last ? null : e('circle', { key: 'd' + i, cx, cy, r: 4, fill: ACCENT, stroke: SURFACE, strokeWidth: 2 })) : null,
                // the end: dot + value
                e('circle', { cx: xy[last][0], cy: xy[last][1], r: 5, fill: ACCENT, stroke: SURFACE, strokeWidth: 2 }),
                e('text', { x: xy[last][0] + 9, y: xy[last][1], dy: '0.32em', fontSize: 12, fontWeight: 700, fill: 'var(--on-surface)' }, fmtKg(pts[last].kg)),
                // crosshair
                a ? e('g', null,
                    e('line', { x1: xy[active][0], x2: xy[active][0], y1: M.top, y2: M.top + PLOT_H, stroke: 'var(--on-surface-variant)', strokeWidth: 1, shapeRendering: 'crispEdges' }),
                    e('circle', { cx: xy[active][0], cy: xy[active][1], r: 6, fill: ACCENT, stroke: SURFACE, strokeWidth: 2 })) : null
            ) : null,
            a ? e('div', {
                className: 'absolute rounded-xl px-2.5 py-1.5 pointer-events-none', role: 'status',
                style: { top: 0, left: tipLeft, width: tipW, background: 'var(--surface-container-highest)', boxShadow: '0 4px 16px rgba(0,0,0,0.45)' },
            },
                e('div', { className: 'flex items-baseline gap-1' },
                    e('span', { className: 'text-base font-black', style: { color: 'var(--on-surface)' } }, fmtKg(a.kg)),
                    e('span', { className: 'text-xs', style: { color: 'var(--on-surface-variant)' } }, 'kg' + (a.fat != null ? ` · ${a.fat} % fat` : ''))),
                e('div', { className: 'text-[11px]', style: { color: 'var(--on-surface-variant)' } }, fmtDay(a.t, { weekday: 'short', day: 'numeric', month: 'short' }) + (a.scale ? ' · scale' : ''))
            ) : null
        );
    }

    // ---------- the screen (content; the caller wraps it in its page shell) ----------
    const card = { background: SURFACE };
    const label = (t) => e('div', { className: 'text-xs uppercase tracking-widest mb-2', style: { color: 'var(--on-surface-variant)' } }, t);

    function Stat({ title, value, unit, sub }) {
        return e('div', { className: 'rounded-2xl p-3 min-w-0', style: card },
            e('div', { className: 'text-[11px] uppercase tracking-widest truncate', style: { color: 'var(--on-surface-variant)' } }, title),
            e('div', { className: 'mt-0.5 flex items-baseline gap-1 whitespace-nowrap' },
                e('span', { className: 'text-xl font-black' }, value),
                unit ? e('span', { className: 'text-xs', style: { color: 'var(--on-surface-variant)' } }, unit) : null),
            sub ? e('div', { className: 'text-[11px] truncate', style: { color: MUTED } }, sub) : null);
    }

    function WeightPanel({ metrics, onLog, now }) {
        now = now || Date.now();
        const [rangeId, setRangeId] = useState(() => { try { return localStorage.getItem(RANGE_KEY) || '3M'; } catch (err) { return '3M'; } });
        const [showAll, setShowAll] = useState(false);
        const pick = (id) => { setRangeId(id); setShowAll(false); try { localStorage.setItem(RANGE_KEY, id); } catch (err) {} };
        const series = weightSeries(metrics);
        const view = rangeView(series, rangeId, now);
        const pts = view.pts;

        const logBtn = e('button', { onClick: onLog, className: 'w-full mt-3 py-3 rounded-xl text-sm font-bold active:scale-95', style: { background: 'var(--surface-container-highest)', color: 'var(--on-surface)' } }, 'Log a weight');
        if (!series.length) {
            return e('div', { className: 'text-center py-10' },
                e(MIcon, { icon: 'monitor_weight', style: { fontSize: '44px', color: 'var(--surface-container-highest)' } }),
                e('div', { className: 'text-base font-bold mt-2' }, 'No weights yet'),
                e('div', { className: 'text-sm mt-1 px-6', style: { color: 'var(--on-surface-variant)' } }, 'Log your weight in the Daily Log, or step on your scale with the CWA Health app.'),
                e('div', { className: 'max-w-xs mx-auto' }, logBtn));
        }

        const segBtn = (r) => e('button', {
            key: r.id, onClick: () => pick(r.id), 'aria-pressed': r.id === view.range.id, 'aria-label': 'Last ' + r.name,
            className: 'flex-1 py-2 rounded-lg text-sm font-black active:scale-95',
            style: r.id === view.range.id ? { background: 'var(--primary-container)', color: 'var(--on-primary-container)' } : { color: 'var(--on-surface-variant)' },
        }, r.id);
        const latest = series[series.length - 1];
        const rows = pts.slice().reverse();
        const shown = showAll ? rows : rows.slice(0, 12);

        return e('div', null,
            e('div', { className: 'flex gap-1 p-1 rounded-xl mb-3', style: card, role: 'group', 'aria-label': 'Time range' }, RANGES.map(segBtn)),
            e('div', { className: 'grid grid-cols-3 gap-2 mb-3' },
                e(Stat, { title: 'Latest', value: fmtKg(latest.kg), unit: 'kg', sub: fmtDay(latest.t) }),
                e(Stat, { title: 'Change', value: view.change != null ? signed(view.change) : '—', unit: view.change != null ? 'kg' : '', sub: view.perWeek != null ? `${signedRate(view.perWeek)} kg/wk` : `this ${view.range.name}` }),
                e(Stat, { title: 'Range', value: view.low ? `${fmtKg(view.low.kg)}–${fmtKg(view.high.kg)}` : '—', sub: view.low ? `this ${view.range.name}` : '' })),
            e('div', { className: 'rounded-2xl p-3', style: card },
                e('div', { className: 'flex items-baseline justify-between mb-1' },
                    e('div', { className: 'text-sm font-bold' }, 'Weight (kg)'),
                    e('div', { className: 'text-[11px]', style: { color: MUTED } }, pts.length ? `${pts.length} ${pts.length === 1 ? 'entry' : 'entries'}` : '')),
                pts.length
                    ? e(WeightChart, { view })
                    : e('div', { className: 'py-12 text-center text-sm', style: { color: 'var(--on-surface-variant)' } }, `No weights in the last ${view.range.name}.`, view.older ? ' Try a longer range.' : ''),
                pts.length ? e('div', { className: 'text-[11px] mt-1', style: { color: MUTED } }, 'Drag across the chart (or use ← →) to read any day.') : null),
            pts.length ? e('div', { className: 'mt-4' },
                label(`Entries · last ${view.range.name}`),
                e('div', { className: 'rounded-2xl px-3', style: card },
                    e('table', { className: 'w-full text-sm', style: { fontVariantNumeric: 'tabular-nums' } },
                        e('thead', null, e('tr', { style: { color: 'var(--on-surface-variant)' } },
                            e('th', { className: 'text-xs font-normal py-2 text-left' }, 'Day'),
                            e('th', { className: 'text-xs font-normal py-2 text-right' }, 'kg'),
                            e('th', { className: 'text-xs font-normal py-2 text-right' }, 'vs previous'))),
                        e('tbody', null, shown.map((p, i) => {
                            const prev = rows[i + 1] || series[series.indexOf(p) - 1];
                            return e('tr', { key: p.t, style: { borderTop: '1px solid var(--surface-container-highest)' } },
                                e('td', { className: 'py-2 text-xs', style: { color: 'var(--on-surface-variant)' } }, fmtDay(p.t, { weekday: 'short', day: 'numeric', month: 'short' }) + (p.scale ? ' · scale' : '')),
                                e('td', { className: 'text-right font-bold' }, fmtKg(p.kg)),
                                e('td', { className: 'text-right', style: { color: 'var(--on-surface-variant)' } }, prev ? signed(p.kg - prev.kg) : '—'));
                        }))),
                    rows.length > shown.length ? e('button', { onClick: () => setShowAll(true), className: 'w-full py-2.5 text-sm font-bold active:opacity-60', style: { color: 'var(--primary-fixed-dim)', borderTop: '1px solid var(--surface-container-highest)' } }, `Show all ${rows.length}`) : null)) : null,
            logBtn);
    }

    window.CWAWeight = { WeightPanel, WeightChart, weightSeries, rangeView, niceScale, xTicks, RANGES };
})();
