// ============================================================================
// CWA nutrition — the Food tab
// ============================================================================
// Diary of what you eat (per day), calorie + macro targets, Open Food Facts
// barcode lookup and search, barcode scanning, food photos read by the AI
// worker, and your own custom foods.
//
// Loaded before the main script in index.html. It only touches the main
// script's globals (MIcon, TopAppBar, BottomNavBar, ConfirmDialog, dayKey,
// fetchWithTimeout, compressImage, callFoodVision) inside functions, i.e. at
// render time, and exposes window.CWANutrition.
//
// Data shapes (stored in Firebase under users/<id>/foodLog/<YYYY-MM-DD> and users/<id>/foods):
//   nutrients n = { kcal, p, c, f, fib, sug, salt }  — per 100 g (or 100 ml)
//   food  = { id?, name, brand, code, src: 'off'|'custom'|'basic'|'ai', unit: 'g'|'ml', n, serving: { g, label } | null }
//           a recipe is a custom food with recipe: true and its ingredients (see RecipeEditor)
//   entry = { id, t (ms), meal, name, brand, code, src, foodId, g (amount), unit, n, serving? }
//           totals = n * g / 100. A quick add stores its absolute values in n with g = 100.
//           serving (the food's piece size) lets the diary show and edit counts ("3× vejce").
(function () {
    'use strict';
    const { useState, useEffect, useRef } = React;
    const e = React.createElement;

    const KEYS = ['kcal', 'p', 'c', 'f', 'fib', 'sug', 'salt'];
    const LABEL = { kcal: 'Calories', p: 'Protein', c: 'Carbs', f: 'Fat', fib: 'Fibre', sug: 'Sugar', salt: 'Salt' };
    const COLOR = { kcal: 'var(--primary-container)', p: 'var(--macro-p)', c: 'var(--macro-c)', f: 'var(--macro-f)', fib: 'var(--macro-fib)', sug: 'var(--macro-sug)', salt: 'var(--macro-salt)' };
    const MEALS = [
        { id: 'breakfast', label: 'Breakfast' },
        { id: 'lunch', label: 'Lunch' },
        { id: 'snack', label: 'Snack' },
        { id: 'dinner', label: 'Dinner' },
    ];
    const MEAL_LABEL = Object.fromEntries(MEALS.map(m => [m.id, m.label]));
    // Diary order: by meal (breakfast first, even if logged after lunch), then by time.
    const MEAL_RANK = Object.fromEntries(MEALS.map((m, i) => [m.id, i]));
    const byMeal = (a, b) => ((MEAL_RANK[a.meal] ?? MEALS.length) - (MEAL_RANK[b.meal] ?? MEALS.length)) || (a.t - b.t);
    const PHOTO_DAILY_LIMIT = 30;
    const BARCODE_POLYFILL = 'https://cdn.jsdelivr.net/npm/barcode-detector@3.2.2/dist/iife/ponyfill.js';

    // ---------- small helpers ----------
    const num = (v) => {
        if (v == null || v === '') return null;
        const x = typeof v === 'string' ? parseFloat(v.replace(',', '.')) : Number(v);
        return Number.isFinite(x) ? x : null;
    };
    const r1 = (x) => Math.round(x * 10) / 10;
    // Display: kcal whole; grams 1 decimal under 10, whole above; salt 1–2 decimals.
    const fmtK = (x) => Math.round(x || 0).toLocaleString('en-US');
    const fmtG = (x) => { const v = x || 0; return v < 10 ? String(r1(v)) : String(Math.round(v)); };
    const fmtSalt = (x) => { const v = x || 0; return v < 1 ? String(Math.round(v * 100) / 100) : String(r1(v)); };
    const fmtVal = (k, x) => (k === 'kcal' ? fmtK(x) : k === 'salt' ? fmtSalt(x) : fmtG(x));
    const newId = (p) => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const fold = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
    const roundN = (n) => { const o = {}; KEYS.forEach(k => { const v = num(n && n[k]); if (v != null) o[k] = k === 'kcal' ? Math.round(v) : Math.round(v * 100) / 100; }); return o; };

    function entryTotals(en) {
        const f = (num(en.g) || 0) / 100, out = {};
        KEYS.forEach(k => { out[k] = (num(en.n && en.n[k]) || 0) * f; });
        return out;
    }
    function dayTotals(entries) {
        const out = {}; KEYS.forEach(k => { out[k] = 0; });
        (entries || []).forEach(en => { const t = entryTotals(en); KEYS.forEach(k => { out[k] += t[k]; }); });
        return out;
    }
    // Missing protein/carbs/fat → kcal from the Atwater factors (fibre 2 kcal/g).
    const kcalFrom = (n) => Math.round(4 * (num(n.p) || 0) + 4 * (num(n.c) || 0) + 9 * (num(n.f) || 0) + 2 * (num(n.fib) || 0));
    function mealForTime(ts) {
        const d = new Date(ts), h = d.getHours() + d.getMinutes() / 60;
        if (h >= 4 && h < 10.5) return 'breakfast';
        if (h >= 10.5 && h < 15) return 'lunch';
        if (h >= 17.5 && h < 22) return 'dinner';
        return 'snack';
    }
    const keyToDate = (k) => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d, 12, 0, 0, 0); };
    const hhmm = (ts) => { const d = new Date(ts); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); };
    // A timestamp on day `key` at the given 'HH:MM' (default: the current time of day).
    function timeOnDay(key, time) {
        const d = keyToDate(key), now = new Date();
        const [h, m] = (time || hhmm(now)).split(':').map(Number);
        d.setHours(h || 0, m || 0, 0, 0);
        return d.getTime();
    }

    // Daily targets: what you set in Goals (or Food › targets). Anything left empty is derived:
    // kcal ~ maintenance from body weight, protein 1.8 g/kg, fat ~27 % of kcal, carbs the rest;
    // fibre 30 g, sugar ≤ 50 g, salt ≤ 5 g.
    function targetsFor(profile, metrics) {
        const p = profile || {};
        const latestW = (metrics || []).filter(m => m.weight != null).sort((a, b) => b.date - a.date)[0];
        const weight = (latestW && latestW.weight) || p.targetWeight || 75;
        const auto = {};
        const kcal = num(p.dailyKcal) || (auto.kcal = true, Math.round(weight * 31 / 50) * 50);
        const prot = num(p.proteinG) || (auto.p = true, Math.round(weight * 1.8));
        const fat = num(p.fatG) || (auto.f = true, Math.round(kcal * 0.27 / 9));
        const carbs = num(p.carbsG) || (auto.c = true, Math.max(0, Math.round((kcal - prot * 4 - fat * 9) / 4)));
        return {
            kcal, p: prot, c: carbs, f: fat,
            fib: num(p.fibreG) || (auto.fib = true, 30),
            sug: num(p.sugarMaxG) || (auto.sug = true, 50),
            salt: num(p.saltMaxG) || (auto.salt = true, 5),
            auto,
        };
    }

    // ---------- week rating ----------
    // A deterministic 0–10 score for a Monday–Sunday week, from two parts (each 0–1):
    //  Training  = workouts done ÷ workouts planned per week (current plan), capped at 1.
    //  Nutrition = average day score over the week; a day with nothing logged scores 0.
    //    Day score = 50 % calories (within ±10 % of target = full, ±35 % or more = 0)
    //              + 30 % protein (≥ 90 % of target = full, ≤ 50 % = 0)
    //              + 20 % carbs & fat (each within ±20 % = full, ±50 % or more = 0).
    // Score = 10 × the average of the parts that have data: no plan → nutrition only; no food
    // logged that week → training only; neither → no rating. Past weeks use today's targets.
    // A week that isn't over yet ("so far") only counts the days and planned workouts before today.
    // Weeks that ended before your first logged workout or food day aren't rated (the plan
    // didn't exist yet, so "0 of 3 workouts" would be meaningless).
    const lin = (x, full, zero) => (x <= full ? 1 : x >= zero ? 0 : 1 - (x - full) / (zero - full));
    function dayScore(t, tg) {
        const dev = (v, target) => (target > 0 ? Math.abs(v - target) / target : 0);
        const kcal = lin(dev(t.kcal, tg.kcal), 0.10, 0.35);
        const ratioP = tg.p > 0 ? t.p / tg.p : 1;
        const prot = ratioP >= 0.9 ? 1 : ratioP <= 0.5 ? 0 : (ratioP - 0.5) / 0.4;
        const cf = (lin(dev(t.c, tg.c), 0.2, 0.5) + lin(dev(t.f, tg.f), 0.2, 0.5)) / 2;
        return 0.5 * kcal + 0.3 * prot + 0.2 * cf;
    }
    // mondayMs: local midnight of the week's Monday. history: workout history entries
    // ({ date, day }). planDays: names of planned days ('Monday', ...). log: food diary.
    function weekRating({ mondayMs, history, planDays, log, targets, now }) {
        const t0 = new Date(weekStartOf(mondayMs)); // any time in the week → its Monday 00:00
        const days = [...Array(7)].map((_, i) => { const d = new Date(t0); d.setDate(d.getDate() + i); return d; });
        const end = new Date(t0); end.setDate(end.getDate() + 7);
        const nowMs = now || Date.now();
        const complete = nowMs >= end.getTime();
        const firstLog = Object.keys(log || {}).filter(k => (log[k] || []).length).sort()[0];
        const firstHist = (history || []).reduce((m, h) => Math.min(m, h.date || Infinity), Infinity);
        const since = Math.min(firstHist, firstLog ? new Date(firstLog + 'T00:00:00').getTime() : Infinity);
        if (end.getTime() <= since) return { score: null, training: null, nutrition: null, complete, mondayMs: t0.getTime() };
        const todayKey = dayKey(nowMs);
        // Days that count: the whole week once it's over, otherwise the days before today.
        const counted = complete ? days : days.filter(d => dayKey(d.getTime()) < todayKey);
        const ORDER = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
        const planned = complete ? planDays.length : planDays.filter(d => ORDER.indexOf(d) < counted.length).length;
        const sessions = (history || []).filter(h => h.date >= t0.getTime() && h.date < Math.min(end.getTime(), complete ? Infinity : new Date(nowMs).setHours(0, 0, 0, 0))).length;
        const training = planned > 0 ? { done: Math.min(sessions, planned), planned, sessions, score: Math.min(sessions, planned) / planned } : null;
        let nutrition = null;
        if (counted.length) {
            const keys = counted.map(d => dayKey(d.getTime()));
            const logged = keys.filter(k => (log[k] || []).length);
            if (logged.length) {
                const scores = keys.map(k => ((log[k] || []).length ? dayScore(dayTotals(log[k]), targets) : 0));
                const avgKcal = logged.reduce((sum, k) => sum + dayTotals(log[k]).kcal, 0) / logged.length;
                nutrition = { score: scores.reduce((a, b) => a + b, 0) / keys.length, logged: logged.length, days: keys.length, avgKcal };
            }
        }
        const parts = [training, nutrition].filter(Boolean);
        const score = parts.length ? Math.round(parts.reduce((a, p) => a + p.score, 0) / parts.length * 100) / 10 : null;
        return { score, training, nutrition, complete, mondayMs: t0.getTime() };
    }
    // Monday 00:00 (local) of the week containing ts.
    function weekStartOf(ts) { const d = new Date(ts); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return d.getTime(); }
    const ratingColor = (score) => (score == null ? 'var(--outline)' : score >= 8 ? 'var(--primary-container)' : score >= 5 ? 'var(--warn)' : 'var(--error)');

    // ---------- basic foods (typical values per 100 g / 100 ml, EU-label style: carbs exclude fibre) ----------
    // [Czech name, English name, kcal, protein, carbs, fat, fibre, sugar, salt, unit, serving g, serving label]
    const BASIC = [
        ['Kuřecí prsa (syrová)', 'Chicken breast, raw', 120, 22.5, 0, 2.6, 0, 0, 0.15],
        ['Kuřecí prsa (pečená)', 'Chicken breast, cooked', 165, 31, 0, 3.6, 0, 0, 0.18],
        ['Kuřecí stehno bez kůže (syrové)', 'Chicken thigh, skinless, raw', 121, 19.7, 0, 4.1, 0, 0, 0.2],
        ['Krůtí prsa (syrová)', 'Turkey breast, raw', 114, 23.7, 0, 1.5, 0, 0, 0.15],
        ['Hovězí mleté 10 % tuku (syrové)', 'Ground beef 10% fat, raw', 176, 20, 0, 10, 0, 0, 0.17],
        ['Hovězí mleté 20 % tuku (syrové)', 'Ground beef 20% fat, raw', 254, 17.2, 0, 20, 0, 0, 0.17],
        ['Vepřová panenka (syrová)', 'Pork tenderloin, raw', 120, 21, 0, 3.5, 0, 0, 0.13],
        ['Losos (syrový)', 'Salmon, raw', 208, 20.4, 0, 13.4, 0, 0, 0.15],
        ['Tuňák ve vlastní šťávě (scezený)', 'Tuna in water, drained', 116, 25.5, 0, 0.8, 0, 0, 0.85],
        ['Treska (syrová)', 'Cod, raw', 82, 17.8, 0, 0.7, 0, 0, 0.15],
        ['Šunka nejvyšší jakosti', 'Ham, premium', 110, 19, 1, 3.5, 0, 1, 2.2],
        ['Párky', 'Frankfurters', 280, 12, 2, 25, 0, 1, 2.0, 'g', 50, '1 párek'],
        ['Slanina (syrová)', 'Bacon, raw', 417, 13, 1.4, 42, 0, 0, 1.7],
        ['Vejce', 'Egg, whole', 143, 12.6, 0.7, 9.5, 0, 0.4, 0.36, 'g', 55, '1 vejce'],
        ['Vaječný bílek', 'Egg white', 52, 10.9, 0.7, 0.2, 0, 0.7, 0.42, 'g', 33, '1 bílek'],
        ['Tvaroh polotučný', 'Quark, half-fat', 118, 15.5, 3.6, 4.5, 0, 3.6, 0.1],
        ['Tvaroh odtučněný', 'Quark, low-fat', 70, 12.5, 4, 0.5, 0, 4, 0.1],
        ['Skyr bílý', 'Skyr, plain', 63, 11, 4, 0.2, 0, 4, 0.1],
        ['Řecký jogurt 0 %', 'Greek yogurt 0%', 59, 10.2, 3.6, 0.4, 0, 3.2, 0.09],
        ['Bílý jogurt 3 %', 'Plain yogurt 3%', 61, 3.5, 4.7, 3.3, 0, 4.7, 0.11],
        ['Cottage', 'Cottage cheese', 98, 11.1, 3.4, 4.3, 0, 2.7, 0.9],
        ['Mléko polotučné 1,5 %', 'Milk 1.5%', 47, 3.4, 4.8, 1.5, 0, 4.8, 0.1, 'ml', 250, '1 sklenice'],
        ['Mléko plnotučné 3,5 %', 'Milk 3.5%', 64, 3.3, 4.7, 3.5, 0, 4.7, 0.1, 'ml', 250, '1 sklenice'],
        ['Kefír 1,5 %', 'Kefir 1.5%', 48, 3.4, 4.5, 1.5, 0, 4.5, 0.1, 'ml'],
        ['Eidam 30 %', 'Edam 30%', 260, 29, 0.1, 16, 0, 0.1, 1.8, 'g', 20, '1 plátek'],
        ['Eidam 45 %', 'Edam 45%', 340, 25.5, 0.1, 26.5, 0, 0.1, 1.7, 'g', 20, '1 plátek'],
        ['Mozzarella', 'Mozzarella, fresh', 250, 18, 1, 19, 0, 1, 0.6, 'g', 125, '1 kulička'],
        ['Parmazán', 'Parmesan', 390, 33, 0, 28, 0, 0, 1.6],
        ['Syrovátkový protein', 'Whey protein powder', 390, 78, 7, 6, 0, 5, 0.5, 'g', 30, '1 odměrka'],
        ['Máslo', 'Butter', 717, 0.9, 0.1, 81, 0, 0.1, 0.02, 'g', 10, '1 lžička'],
        ['Olivový olej', 'Olive oil', 884, 0, 0, 100, 0, 0, 0, 'g', 10, '1 lžíce'],
        ['Řepkový olej', 'Rapeseed oil', 884, 0, 0, 100, 0, 0, 0, 'g', 10, '1 lžíce'],
        ['Ovesné vločky', 'Rolled oats', 370, 13, 59, 7, 10, 1, 0.01, 'g', 50, '1 porce'],
        ['Rýže bílá (suchá)', 'White rice, dry', 350, 7, 78, 0.6, 1.3, 0.1, 0.01],
        ['Rýže bílá (vařená)', 'White rice, cooked', 130, 2.7, 28, 0.3, 0.4, 0, 0],
        ['Těstoviny (suché)', 'Pasta, dry', 359, 12.5, 71, 2, 3, 3.5, 0.01],
        ['Těstoviny (vařené)', 'Pasta, cooked', 150, 5.5, 29.5, 0.9, 1.8, 0.6, 0],
        ['Kuskus (suchý)', 'Couscous, dry', 376, 12.8, 72, 0.6, 5, 0.5, 0.02],
        ['Quinoa (suchá)', 'Quinoa, dry', 368, 14.1, 57.2, 6.1, 7, 0, 0.01],
        ['Pohanka (suchá)', 'Buckwheat, dry', 343, 13.3, 61.5, 3.4, 10, 0, 0],
        ['Brambory (syrové)', 'Potatoes, raw', 75, 2, 15.5, 0.1, 2.1, 0.8, 0.01],
        ['Brambory vařené', 'Potatoes, boiled', 85, 1.7, 18, 0.1, 1.8, 0.9, 0.01],
        ['Batáty (syrové)', 'Sweet potato, raw', 86, 1.6, 17, 0.1, 3, 4.2, 0.14],
        ['Chléb konzumní', 'Rye-wheat bread', 240, 8, 47, 1.5, 5, 1.5, 1.4, 'g', 50, '1 krajíc'],
        ['Chléb celozrnný', 'Wholegrain bread', 240, 11, 39, 3.5, 7, 4, 1.1, 'g', 40, '1 krajíc'],
        ['Rohlík', 'Bread roll (rohlík)', 285, 9.5, 55, 3, 2.5, 2, 1.4, 'g', 43, '1 rohlík'],
        ['Knedlík houskový', 'Bread dumpling', 235, 7, 47, 2, 2, 2, 1.0, 'g', 40, '1 plátek'],
        ['Tortilla pšeničná', 'Wheat tortilla', 310, 8.5, 50, 7.5, 3, 2.5, 1.3, 'g', 60, '1 tortilla'],
        ['Rýžové chlebíčky', 'Rice cakes', 380, 8, 78, 3, 4, 0.4, 0.02, 'g', 8, '1 chlebíček'],
        ['Kukuřičné lupínky', 'Corn flakes', 378, 7, 84, 0.9, 3, 8, 1.1],
        ['Čočka (suchá)', 'Lentils, dry', 340, 25, 52, 1.1, 11, 2, 0.01],
        ['Čočka (vařená)', 'Lentils, cooked', 110, 9, 13, 0.4, 7.9, 1.8, 0],
        ['Cizrna (konzerva, scezená)', 'Chickpeas, canned, drained', 125, 7, 15, 2.6, 7.6, 0.3, 0.5],
        ['Fazole červené (konzerva)', 'Red kidney beans, canned', 100, 7.5, 12.5, 0.5, 6.5, 1, 0.5],
        ['Brokolice', 'Broccoli', 34, 2.8, 4, 0.4, 2.6, 1.7, 0.08],
        ['Rajče', 'Tomato', 18, 0.9, 2.7, 0.2, 1.2, 2.6, 0.01],
        ['Okurka', 'Cucumber', 15, 0.7, 2.9, 0.1, 0.5, 1.7, 0.01],
        ['Paprika červená', 'Red bell pepper', 27, 1, 3.9, 0.3, 2.1, 4.2, 0.01],
        ['Mrkev', 'Carrot', 38, 0.9, 6.8, 0.2, 2.8, 4.7, 0.17],
        ['Špenát', 'Spinach', 23, 2.9, 1.4, 0.4, 2.2, 0.4, 0.2],
        ['Ledový salát', 'Iceberg lettuce', 14, 0.9, 1.8, 0.1, 1.2, 2, 0.02],
        ['Cibule', 'Onion', 39, 1.1, 7.6, 0.1, 1.7, 4.2, 0.01],
        ['Žampiony', 'Mushrooms', 22, 3.1, 2.3, 0.3, 1, 2, 0.01],
        ['Cuketa', 'Zucchini', 17, 1.2, 2.1, 0.3, 1, 2.5, 0.02],
        ['Zelené fazolky', 'Green beans', 31, 1.8, 4.3, 0.2, 2.7, 3.3, 0.01],
        ['Avokádo', 'Avocado', 160, 2, 1.9, 14.7, 6.7, 0.7, 0.02],
        ['Banán', 'Banana', 89, 1.1, 20.2, 0.3, 2.6, 12.2, 0, 'g', 120, '1 banán'],
        ['Jablko', 'Apple', 52, 0.3, 11.4, 0.2, 2.4, 10.4, 0, 'g', 180, '1 jablko'],
        ['Pomeranč', 'Orange', 47, 0.9, 9.4, 0.1, 2.4, 9.4, 0, 'g', 150, '1 pomeranč'],
        ['Hruška', 'Pear', 57, 0.4, 12.1, 0.1, 3.1, 9.8, 0, 'g', 170, '1 hruška'],
        ['Jahody', 'Strawberries', 32, 0.7, 5.7, 0.3, 2, 4.9, 0],
        ['Borůvky', 'Blueberries', 57, 0.7, 12.1, 0.3, 2.4, 10, 0],
        ['Hroznové víno', 'Grapes', 70, 0.7, 17.2, 0.2, 0.9, 15.5, 0],
        ['Kiwi', 'Kiwi', 61, 1.1, 11.7, 0.5, 3, 9, 0, 'g', 75, '1 kiwi'],
        ['Rozinky', 'Raisins', 310, 3.1, 75.5, 0.5, 3.7, 59, 0.03],
        ['Mandle', 'Almonds', 600, 21, 9, 50, 12.5, 4.4, 0],
        ['Vlašské ořechy', 'Walnuts', 680, 15.2, 7, 65.2, 6.7, 2.6, 0],
        ['Kešu', 'Cashews', 580, 18.2, 26.9, 43.9, 3.3, 5.9, 0.03],
        ['Arašídy', 'Peanuts', 590, 25.8, 7.6, 49.2, 8.5, 4, 0.05],
        ['Arašídové máslo', 'Peanut butter', 610, 26, 12, 50, 6, 4, 0, 'g', 15, '1 lžíce'],
        ['Chia semínka', 'Chia seeds', 450, 17, 8, 31, 34, 0, 0],
        ['Slunečnicová semínka', 'Sunflower seeds', 600, 20.8, 11.4, 51.5, 8.6, 2.6, 0],
        ['Hořká čokoláda 70 %', 'Dark chocolate 70%', 570, 8, 33, 42, 11, 28, 0.02],
        ['Mléčná čokoláda', 'Milk chocolate', 535, 7.6, 57, 30, 2.4, 52, 0.25],
        ['Med', 'Honey', 304, 0.3, 82, 0, 0.2, 82, 0.01, 'g', 20, '1 lžíce'],
        ['Cukr', 'Sugar', 400, 0, 100, 0, 0, 100, 0, 'g', 5, '1 lžička'],
        ['Kečup', 'Ketchup', 102, 1.2, 23.2, 0.1, 0.5, 22.8, 1.8],
        ['Bramborové lupínky', 'Potato chips', 536, 7, 50, 34, 4.5, 0.5, 1.4],
        ['Coca-Cola', 'Coca-Cola', 42, 0, 10.6, 0, 0, 10.6, 0, 'ml', 330, '1 plechovka'],
        ['Pomerančový džus', 'Orange juice', 45, 0.7, 10.4, 0.2, 0.2, 8.4, 0, 'ml', 250, '1 sklenice'],
        ['Pivo 12°', 'Lager 12°', 43, 0.5, 3.6, 0, 0, 0, 0.01, 'ml', 500, '1 velké'],
        ['Pivo 10°', 'Lager 10°', 35, 0.4, 3, 0, 0, 0, 0.01, 'ml', 500, '1 velké'],
        ['Víno červené', 'Red wine', 85, 0.1, 2.6, 0, 0, 0.6, 0.01, 'ml', 200, '1 sklenka'],
        ['Káva černá', 'Black coffee', 2, 0.1, 0, 0, 0, 0, 0, 'ml', 200, '1 šálek'],
    ];
    const BASIC_FOODS = BASIC.map((r, i) => ({
        id: 'b' + i, name: r[0], alt: r[1], brand: '', code: '', src: 'basic', unit: r[9] || 'g',
        n: { kcal: r[2], p: r[3], c: r[4], f: r[5], fib: r[6], sug: r[7], salt: r[8] },
        serving: r[10] ? { g: r[10], label: r[11] } : null,
    }));

    // ---------- Open Food Facts ----------
    const OFF_FIELDS = 'code,product_name,product_name_cs,product_name_en,generic_name,brands,quantity,serving_size,serving_quantity,nutriments';
    // Text that may come as a string, a list, or per language ({ cs, en, main… }).
    const textOf = (v) => (typeof v === 'string' ? v : Array.isArray(v) ? v.filter(x => typeof x === 'string').join(', ')
        : v && typeof v === 'object' ? (v.cs || v.main || v.en || Object.values(v).find(x => typeof x === 'string') || '') : '');
    function offToFood(p) {
        if (!p) return null;
        const nm = p.nutriments || {};
        const g = (k) => num(nm[k + '_100g']);
        let kcal = g('energy-kcal');
        if (kcal == null) { const kj = g('energy-kj') != null ? g('energy-kj') : g('energy'); if (kj != null) kcal = kj / 4.184; }
        let salt = g('salt');
        if (salt == null && g('sodium') != null) salt = g('sodium') * 2.5;
        const n = roundN({ kcal, p: g('proteins'), c: g('carbohydrates'), f: g('fat'), fib: g('fiber'), sug: g('sugars'), salt });
        const name = String(textOf(p.product_name_cs) || textOf(p.product_name) || textOf(p.product_name_en) || textOf(p.generic_name) || '').trim();
        const unit = /\d\s*(ml|cl|l)\b/i.test(String(p.quantity || '')) ? 'ml' : 'g';
        const sq = num(p.serving_quantity);
        return {
            name: name || 'Unnamed product', brand: String(textOf(p.brands) || '').split(',')[0].trim(), code: String(p.code || ''),
            src: 'off', unit, n, serving: sq > 0 ? { g: sq, label: String(p.serving_size || `${sq} ${unit}`) } : null,
            hasNutrition: n.kcal != null,
        };
    }
    // Products looked up before stay on the phone (scanning the same yogurt again is instant/offline).
    const OFF_CACHE = 'cwa-offcache';
    const cacheGet = (code) => { try { return (JSON.parse(localStorage.getItem(OFF_CACHE) || '{}')[code] || {}).food || null; } catch (e) { return null; } };
    function cachePut(food) {
        try {
            const c = JSON.parse(localStorage.getItem(OFF_CACHE) || '{}');
            c[food.code] = { food, t: Date.now() };
            const keys = Object.keys(c);
            if (keys.length > 300) keys.sort((a, b) => c[a].t - c[b].t).slice(0, keys.length - 300).forEach(k => delete c[k]);
            localStorage.setItem(OFF_CACHE, JSON.stringify(c));
        } catch (e) {}
    }
    // Products from earlier lookups, for the Add sheet's local search (no network needed).
    const cachedProducts = () => { try { return Object.values(JSON.parse(localStorage.getItem(OFF_CACHE) || '{}')).map(c => c.food).filter(Boolean); } catch (e) { return []; } };

    // Open Food Facts is often slow or failing (its legacy search answers 503 a lot), so every
    // call has fallbacks: the browser asks OFF directly, then the CWA worker asks for it (server
    // side, cached a day; see proxy/worker.js), then the browser tries again.
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    async function viaWorker(body, ms) {
        const url = typeof LLM_PROXY_URL !== 'undefined' ? LLM_PROXY_URL : '';
        if (!url) throw new Error('no worker');
        const res = await fetchWithTimeout(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, ms || 15000);
        if (!res.ok) throw new Error('worker ' + res.status);
        return res.json();
    }

    // → { found: true, food } | { found: false } ; throws when OFF can't be reached.
    async function offLookup(code) {
        const cached = cacheGet(code);
        if (cached) return { found: true, food: cached };
        const fromData = (data) => {
            if (!data || !data.product || (data.status !== 1 && data.status !== 'success')) return { found: false };
            const food = offToFood({ code, ...data.product });
            if (food.hasNutrition) cachePut(food);
            return { found: true, food };
        };
        const direct = async (host) => {
            const res = await fetchWithTimeout(`https://${host}.openfoodfacts.org/api/v2/product/${encodeURIComponent(code)}.json?fields=${OFF_FIELDS}`, {}, 8000);
            if (res.status === 404) return { found: false };
            if (!res.ok) throw new Error(`Open Food Facts error (${res.status})`);
            return fromData(await res.json());
        };
        let lastErr = null;
        const attempts = [
            () => direct('world'),
            () => viaWorker({ task: 'off-product', code }, 12000).then(fromData),
            () => sleep(800).then(() => direct('cz')),
        ];
        for (const attempt of attempts) {
            try { return await attempt(); }
            catch (err) { lastErr = err; if (navigator.onLine === false) break; }
        }
        throw lastErr;
    }

    // Search: Open Food Facts' newer search service (Search-a-licious: fast, every country; we
    // list products sold in Czechia first), else the worker, else the legacy search (one
    // request for Czechia, or worldwide when asked). OFF allows ~10 searches/min per IP and asks
    // apps not to search as you type, so this runs only on an explicit search. Answers are
    // remembered on the phone for two weeks. A returned list has .global = true when it
    // already covers every country (no "search worldwide" step needed).
    const SEARCH_STORE = 'cwa-offsearch', SEARCH_TTL = 14 * 86400000;
    const searchCache = {};
    const storeGet = (key) => { try { const c = JSON.parse(localStorage.getItem(SEARCH_STORE) || '{}')[key]; return c && Date.now() - c.t < SEARCH_TTL ? c : null; } catch (e) { return null; } };
    function storePut(key, items, global) {
        try {
            const c = JSON.parse(localStorage.getItem(SEARCH_STORE) || '{}');
            c[key] = { items, global, t: Date.now() };
            const keys = Object.keys(c);
            if (keys.length > 40) keys.sort((a, b) => c[a].t - c[b].t).slice(0, keys.length - 40).forEach(k => delete c[k]);
            localStorage.setItem(SEARCH_STORE, JSON.stringify(c));
        } catch (e) {}
    }
    const soldInCz = (p) => Array.isArray(p.countries_tags) && p.countries_tags.includes('en:czech-republic');
    async function salSearch(q) {
        const res = await fetchWithTimeout(`https://search.openfoodfacts.org/search?q=${encodeURIComponent(q)}&langs=cs,en&page_size=30&fields=${OFF_FIELDS},countries_tags`, {}, 9000);
        if (!res.ok) throw new Error('Open Food Facts search error (' + res.status + ')');
        const data = await res.json();
        if (!data || !Array.isArray(data.hits)) throw new Error('Open Food Facts search: unexpected answer');
        return data.hits;
    }
    async function legacySearch(q, worldwide, tries, ms) {
        const host = worldwide ? 'world.openfoodfacts.org' : 'cz.openfoodfacts.org';
        const url = `https://${host}/cgi/search.pl?search_terms=${encodeURIComponent(q)}&search_simple=1&action=process&json=1&page_size=30&fields=${OFF_FIELDS}`;
        let lastErr = null;
        for (let attempt = 0; attempt < tries; attempt++) {
            if (attempt) await sleep(1500);
            try {
                const res = await fetchWithTimeout(url, {}, ms);
                if (res.status === 429) { const err = new Error('rate'); err.rate = true; throw err; }
                if (!res.ok) throw new Error(`Open Food Facts search error (${res.status})`);
                return (await res.json()).products || [];
            } catch (err) {
                lastErr = err;
                if (err.rate || navigator.onLine === false) break; // retrying won't help
            }
        }
        throw lastErr;
    }
    async function offSearch(query, worldwide) {
        const q = query.trim(), lq = q.toLowerCase();
        const key = (worldwide ? 'w:' : 'cz:') + lq;
        const known = searchCache[key] || searchCache['all:' + lq];
        if (known) return known;
        const stored = storeGet('all:' + lq) || storeGet(key);
        const finish = (items, global, save) => {
            const out = items.slice();
            out.global = global;
            searchCache[global ? 'all:' + lq : key] = out;
            if (save) storePut(global ? 'all:' + lq : key, items, global);
            return out;
        };
        if (stored) return finish(stored.items, stored.global, false);
        const toFoods = (products, global) => (global ? products.filter(soldInCz).concat(products.filter(p => !soldInCz(p))) : products)
            .map(offToFood).filter(f => f && f.hasNutrition);

        let answered = false; // the newer search answered (maybe with nothing)
        try {
            const hits = await salSearch(q);
            answered = true;
            const foods = toFoods(hits, true);
            if (foods.length) return finish(foods, true, true);
        } catch (err) {}
        if (!answered) {
            try {
                const r = await viaWorker({ task: 'off-search', q });
                if (r && Array.isArray(r.products)) {
                    const foods = toFoods(r.products, true);
                    if (foods.length || r.source === 'search-a-licious') return finish(foods, true, foods.length > 0);
                }
            } catch (err) {}
        }
        try {
            const foods = toFoods(await legacySearch(q, worldwide, answered ? 1 : 2, answered ? 12000 : 20000), false);
            return finish(foods, false, foods.length > 0);
        } catch (err) {
            if (answered) return finish([], true, false); // the newer search found nothing; trust it
            throw err;
        }
    }
    const searchErrorText = (err) => navigator.onLine === false ? 'You are offline.'
        : err && err.rate ? 'Open Food Facts allows about 10 searches a minute. Wait a moment and search again.'
            : 'Open Food Facts did not answer (it is sometimes slow). Try again in a moment.';

    // ---------- barcode detection (native on Android Chrome, ZXing polyfill elsewhere) ----------
    let detectorPromise = null;
    function loadScript(src) {
        return new Promise((resolve, reject) => {
            const s = document.createElement('script');
            s.src = src; s.async = true; s.onload = resolve; s.onerror = () => reject(new Error('Scanner failed to load (offline?)'));
            document.head.appendChild(s);
        });
    }
    function getBarcodeDetector() {
        if (!detectorPromise) {
            detectorPromise = (async () => {
                const formats = ['ean_13', 'ean_8', 'upc_a', 'upc_e'];
                if ('BarcodeDetector' in window) {
                    try {
                        const sup = await window.BarcodeDetector.getSupportedFormats();
                        const f = formats.filter(x => sup.includes(x));
                        if (f.length) return new window.BarcodeDetector({ formats: f });
                    } catch (err) {}
                }
                if (!window.BarcodeDetectionAPI) await loadScript(BARCODE_POLYFILL);
                const api = window.BarcodeDetectionAPI;
                if (!api || !api.BarcodeDetector) throw new Error('Scanner failed to load');
                return new api.BarcodeDetector({ formats });
            })().catch(err => { detectorPromise = null; throw err; });
        }
        return detectorPromise;
    }

    // ---------- shared UI bits ----------
    const card = { background: 'var(--surface-container-high)' };
    const label = (t) => e('div', { className: 'text-xs uppercase tracking-widest mb-2', style: { color: 'var(--on-surface-variant)' } }, t);
    const inputStyle = { background: 'var(--surface-container-low)', color: 'var(--on-surface)', border: 'none', caretColor: 'var(--primary-container)' };
    const primaryBtn = { background: 'var(--primary-container)', color: 'var(--on-primary-container)' };
    const ghostBtn = { background: 'var(--surface-container-highest)', color: 'var(--on-surface)' };
    const iconBtn = (icon, onClick, aria, extra) => e('button', {
        onClick, 'aria-label': aria,
        className: 'w-10 h-10 rounded-full flex items-center justify-center active:scale-90 flex-shrink-0',
        style: Object.assign({}, ghostBtn, extra || {})
    }, e(MIcon, { icon, style: { fontSize: '20px' } }));

    function Sheet({ title, onClose, right, children, footer }) {
        return e('div', { className: 'fixed inset-0 z-[160] flex flex-col', style: { background: 'var(--void)', color: 'var(--on-surface)' } },
            e(TopAppBar, {
                title,
                leftAction: e('button', { onClick: onClose, 'aria-label': 'Close', className: 'flex items-center active:opacity-60', style: { color: 'var(--on-surface-variant)' } }, e(MIcon, { icon: 'close', style: { fontSize: '24px' } })),
                rightAction: right || null
            }),
            e('div', { className: 'flex-1 overflow-y-auto pt-20 px-4 pb-6' }, e('div', { className: 'max-w-lg mx-auto' }, children)),
            footer ? e('div', { className: 'px-4 pt-2', style: { paddingBottom: 'max(env(safe-area-inset-bottom), 14px)', background: 'var(--void)' } }, e('div', { className: 'max-w-lg mx-auto' }, footer)) : null
        );
    }

    function Ring({ size, stroke, value, max, children }) {
        const r = (size - stroke) / 2, c = 2 * Math.PI * r;
        const frac = max > 0 ? Math.min(value / max, 1) : 0;
        const over = max > 0 ? Math.min(Math.max(value - max, 0) / max, 1) : 0;
        const circle = (color, f) => e('circle', {
            cx: size / 2, cy: size / 2, r, fill: 'none', stroke: color, strokeWidth: stroke, strokeLinecap: 'round',
            strokeDasharray: c, strokeDashoffset: c * (1 - f), style: { transition: 'stroke-dashoffset .5s ease' }
        });
        return e('div', { style: { position: 'relative', width: size, height: size, flexShrink: 0 } },
            e('svg', { width: size, height: size, viewBox: `0 0 ${size} ${size}`, style: { transform: 'rotate(-90deg)', display: 'block' } },
                e('circle', { cx: size / 2, cy: size / 2, r, fill: 'none', stroke: 'var(--surface-container-highest)', strokeWidth: stroke }),
                frac > 0 ? circle('var(--primary-container)', frac) : null,
                over > 0 ? circle('var(--error)', over) : null
            ),
            e('div', { style: { position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' } }, children)
        );
    }

    // small: fibre / sugar / salt — label on its own line so three fit side by side at 320 px.
    function Bar({ k, value, max, limit, small }) {
        const frac = max > 0 ? Math.min(value / max, 1) : 0;
        const bad = limit && value > max;
        const val = e('span', { className: (small ? 'text-[11px]' : 'text-xs') + ' whitespace-nowrap', style: { color: bad ? 'var(--error)' : 'var(--on-surface-variant)', fontVariantNumeric: 'tabular-nums' } },
            e('b', { style: { color: bad ? 'var(--error)' : 'var(--on-surface)' } }, fmtVal(k, value)), ` / ${fmtVal(k, max)} g`);
        return e('div', { className: small ? 'min-w-0' : 'mb-2.5' },
            small
                ? e('div', { className: 'mb-1 leading-tight' },
                    e('div', { className: 'text-[10px] uppercase tracking-widest', style: { color: 'var(--on-surface-variant)' } }, LABEL[k]), val)
                : e('div', { className: 'flex items-baseline justify-between gap-2 mb-1' },
                    e('span', { className: 'text-sm font-bold whitespace-nowrap', style: { color: 'var(--on-surface)' } }, LABEL[k]), val),
            e('div', { className: 'rounded-full overflow-hidden', style: { height: small ? 4 : 7, background: 'var(--surface-container-highest)' } },
                e('div', { className: 'h-full rounded-full', style: { width: (frac * 100) + '%', background: bad ? 'var(--error)' : COLOR[k], transition: 'width .5s ease' } }))
        );
    }

    // compact: Flip cover screen — smaller ring, fibre/sugar/salt as one line, so the
    // whole card fits the short screen. Tap a nutrient for its split by food (onMacro);
    // the tune button edits the targets.
    function DaySummary({ totals, targets, onEditTargets, onMacro, compact }) {
        const left = targets.kcal - totals.kcal;
        const vpw = useViewport().w;
        const narrow = compact || vpw < 370;
        const tap = (k, child, extra) => e('button', { key: k, onClick: () => onMacro(k), 'aria-label': `${LABEL[k]} by food`, className: 'block text-left active:opacity-70 ' + (extra || '') }, child);
        return e('div', { className: 'w-full rounded-3xl ' + (compact ? 'p-3' : 'p-4'), style: card },
            e('div', { className: 'flex items-center ' + (narrow ? 'gap-3' : 'gap-4') },
                e('button', { onClick: () => onMacro('kcal'), 'aria-label': 'Calories by food', className: 'rounded-full flex-shrink-0 active:scale-95 transition-transform' },
                    e(Ring, { size: compact ? 92 : narrow ? 104 : 128, stroke: narrow ? 9 : 11, value: totals.kcal, max: targets.kcal },
                        e('div', { className: (narrow ? 'text-xl' : 'text-2xl') + ' font-black leading-none', style: { fontVariantNumeric: 'tabular-nums' } }, fmtK(totals.kcal)),
                        e('div', { className: 'text-[11px] mt-1', style: { color: 'var(--on-surface-variant)' } }, `of ${fmtK(targets.kcal)} kcal`)
                    )),
                e('div', { className: 'flex-1 min-w-0' },
                    e('div', { className: 'flex items-center gap-1.5 mb-2' },
                        e('span', { className: 'text-lg font-black leading-none', style: { color: left < 0 ? 'var(--error)' : 'var(--primary-container)', fontVariantNumeric: 'tabular-nums' } }, fmtK(Math.abs(left))),
                        e('span', { className: 'text-xs flex-1 min-w-0 truncate', style: { color: 'var(--on-surface-variant)' } }, left < 0 ? 'kcal over' : 'kcal left'),
                        e('button', { onClick: onEditTargets, 'aria-label': 'Edit daily targets', className: 'w-8 h-8 -my-1.5 -mr-1 rounded-full flex items-center justify-center flex-shrink-0 active:scale-90', style: { color: 'var(--on-surface-variant)' } },
                            e(MIcon, { icon: 'tune', style: { fontSize: '19px' } }))
                    ),
                    ['p', 'c', 'f'].map(k => tap(k, e(Bar, { k, value: totals[k], max: targets[k] }), 'w-full'))
                )
            ),
            compact
                ? e('div', { className: 'flex justify-between gap-2 mt-2 pt-2 text-[11px] whitespace-nowrap', style: { borderTop: '1px solid var(--surface-container-highest)', color: 'var(--on-surface-variant)', fontVariantNumeric: 'tabular-nums' } },
                    ['fib', 'sug', 'salt'].map(k => tap(k, e('span', { style: { color: k !== 'fib' && totals[k] > targets[k] ? 'var(--error)' : undefined } },
                        `${LABEL[k]} `, e('b', { style: { color: k !== 'fib' && totals[k] > targets[k] ? 'var(--error)' : 'var(--on-surface)' } }, fmtVal(k, totals[k])), `/${fmtVal(k, targets[k])}`))))
                : e('div', { className: 'grid grid-cols-3 gap-3 mt-3 pt-3', style: { borderTop: '1px solid var(--surface-container-highest)' } },
                    tap('fib', e(Bar, { k: 'fib', value: totals.fib, max: targets.fib, small: true }), 'min-w-0'),
                    tap('sug', e(Bar, { k: 'sug', value: totals.sug, max: targets.sug, small: true, limit: true }), 'min-w-0'),
                    tap('salt', e(Bar, { k: 'salt', value: totals.salt, max: targets.salt, small: true, limit: true }), 'min-w-0')
                )
        );
    }

    // ---------- pieces ----------
    // A food's serving ({ g, label }) doubles as its "piece": log 3 eggs instead of 165 g.
    // The piece's name is the label without a leading "1 " ("1 vejce" → "vejce"); a label that
    // is just a weight ("30 g") becomes "serving".
    function pieceName(sv) {
        const l = String((sv && sv.label) || '').trim().replace(/^1\s*[×x]?\s+/i, '');
        return !l || /^[\d.,]+\s*(g|ml|l|kg)\b/i.test(l) ? 'serving' : l;
    }
    const fmtCount = (c) => String(Math.round(c * 100) / 100);
    // Whole or half pieces in `g` (e.g. 2.5), else null.
    function piecesOf(g, sv) {
        if (!sv || !(sv.g > 0) || !(g > 0)) return null;
        const c = g / sv.g;
        return Math.abs(c * 2 - Math.round(c * 2)) < 0.02 ? Math.round(c * 2) / 2 : null;
    }
    const servingOf = (food) => (food && food.serving && food.serving.g > 0 ? { g: food.serving.g, label: food.serving.label || '' } : null);
    // Entries and recipe ingredients: "3× vejce · 165 g", or just "120 g".
    const amountText = (en) => {
        if (en.src === 'quick') return 'Quick add';
        const grams = `${fmtG(en.g)} ${en.unit || 'g'}`;
        const c = piecesOf(en.g, en.serving);
        return c ? `${fmtCount(c)}× ${pieceName(en.serving)} · ${grams}` : grams;
    };
    // ---------- usual foods (today's suggestions) ----------
    // A food logged in a meal on more than half of the logged days of the last USUAL_DAYS (with
    // at least USUAL_MIN_DAYS logged days) is suggested in that meal today, greyed out, in its
    // most common amount: the amount logged most often, or the median when every day differed.
    const USUAL_DAYS = 28, USUAL_MIN_DAYS = 4;
    const foodKey = (en) => (en.foodId ? 'f:' + en.foodId : en.code ? 'c:' + en.code : 'n:' + fold(en.name + '|' + (en.brand || '')));
    const minutesOf = (ts) => { const d = new Date(ts); return d.getHours() * 60 + d.getMinutes(); };
    const median = (arr) => { const a = arr.slice().sort((x, y) => x - y); const m = Math.floor(a.length / 2); return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; };
    // → { breakfast: [{ key, meal, food, g, time: 'HH:MM', days, of }], ... }
    function usualFoods(log, todayKey, customFoods) {
        const start = dayKey(keyToDate(todayKey).getTime() - USUAL_DAYS * 86400000);
        const days = Object.keys(log || {}).filter(d => d < todayKey && d >= start && (log[d] || []).length);
        const out = {};
        if (days.length < USUAL_MIN_DAYS) return out;
        MEALS.forEach(({ id }) => {
            const stats = {};
            days.forEach(d => {
                const perDay = {}; // the same food twice in one meal counts once, with both amounts added
                (log[d] || []).filter(en => en.meal === id && en.src !== 'quick' && en.n).forEach(en => {
                    const k = foodKey(en);
                    const p = perDay[k] || (perDay[k] = { g: 0, en, mins: [] });
                    p.g += num(en.g) || 0; p.mins.push(minutesOf(en.t));
                    if (en.t > p.en.t) p.en = en;
                });
                Object.keys(perDay).forEach(k => {
                    const p = perDay[k];
                    const st = stats[k] || (stats[k] = { days: 0, gs: [], mins: [], last: p.en });
                    st.days++; st.gs.push(Math.round(p.g * 10) / 10); st.mins.push(...p.mins);
                    if (p.en.t > st.last.t) st.last = p.en;
                });
            });
            const list = Object.keys(stats).filter(k => stats[k].days / days.length > 0.5).map(k => {
                const st = stats[k];
                const freq = {};
                st.gs.forEach(g => { freq[g] = (freq[g] || 0) + 1; });
                const top = Object.keys(freq).map(Number).sort((a, b) => freq[b] - freq[a] || b - a)[0];
                const g = freq[top] >= 2 ? top : Math.round(median(st.gs));
                const mins = Math.round(median(st.mins));
                const en = st.last, live = en.foodId && customFoods && customFoods[en.foodId];
                const food = live || { id: en.foodId || '', name: en.name, brand: en.brand || '', code: en.code || '', src: en.src || 'custom', unit: en.unit || 'g', n: en.n, serving: servingOf(en) };
                return { key: k, meal: id, food, g, time: `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`, mins, days: st.days, of: days.length };
            }).sort((a, b) => a.mins - b.mins).slice(0, 5);
            if (list.length) out[id] = list;
        });
        return out;
    }
    // Today's suggestions still to show: a meal's suggestions go once anything else is logged there.
    function pendingUsual(usual, entries) {
        const out = {};
        Object.keys(usual || {}).forEach(meal => {
            const inMeal = entries.filter(en => en.meal === meal);
            const keys = new Set(usual[meal].map(u => u.key));
            if (inMeal.some(en => !keys.has(foodKey(en)))) return;
            const have = new Set(inMeal.map(foodKey));
            const rest = usual[meal].filter(u => !have.has(u.key));
            if (rest.length) out[meal] = rest;
        });
        return out;
    }

    // Diary for one day, grouped by meal. suggest: today's usual foods not logged yet (greyed
    // out, ✓ logs one, tapping it opens the amount first).
    function Timeline({ entries, onOpen, suggest, onAccept, onOpenSuggestion }) {
        const sug = suggest || {};
        const hasSug = Object.keys(sug).length > 0;
        if (!entries.length && !hasSug) {
            return e('div', { className: 'text-center py-10' },
                e(MIcon, { icon: 'restaurant', style: { fontSize: '44px', color: 'var(--surface-container-highest)' } }),
                e('div', { className: 'text-base font-bold mt-3' }, 'Nothing logged yet'),
                e('div', { className: 'text-sm mt-1', style: { color: 'var(--on-surface-variant)' } }, 'Scan a barcode, snap a label, or search for a food.')
            );
        }
        const known = MEALS.map(m => m.id);
        const meals = known.concat([...new Set(entries.map(en => en.meal))].filter(m => !known.includes(m)));
        const flat = [];
        meals.forEach(m => {
            const items = entries.filter(en => en.meal === m);
            const sugs = sug[m] || [];
            if (!items.length && !sugs.length) return;
            flat.push({ type: 'head', meal: m, items });
            items.forEach(en => flat.push({ type: 'entry', en }));
            sugs.forEach(u => flat.push({ type: 'sug', u }));
        });
        const lastIdx = flat.length - 1;
        const dot = (style) => e('div', { style: Object.assign({ width: 9, height: 9, borderRadius: '50%', marginTop: 16, flexShrink: 0 }, style) });
        const line = (i) => (i === lastIdx ? null : e('div', { style: { width: 2, flex: 1, background: 'var(--surface-container-highest)', marginTop: 3 } }));
        const rowBorder = (i) => ({ borderBottom: i === lastIdx || (flat[i + 1] && flat[i + 1].type === 'head') ? 'none' : '1px solid var(--surface-container-high)' });
        const rows = flat.map((r, i) => {
            if (r.type === 'head') {
                const kcal = r.items.reduce((s, x) => s + entryTotals(x).kcal, 0);
                return e('div', { key: 'h' + r.meal, className: 'flex items-center gap-2 pl-[54px] pt-3 pb-1' },
                    e('span', { className: 'text-[11px] font-black uppercase tracking-widest', style: { color: 'var(--primary-fixed-dim)' } }, MEAL_LABEL[r.meal] || 'Meal'),
                    e('span', { className: 'text-[11px]', style: { color: 'var(--outline)' } }, r.items.length ? `${fmtK(kcal)} kcal` : 'usual foods'));
            }
            if (r.type === 'sug') {
                const u = r.u, t = entryTotals({ g: u.g, n: u.food.n });
                return e('div', { key: 's' + u.meal + u.key, className: 'w-full flex items-stretch' },
                    e('div', { className: 'w-[42px] pt-3 text-[11px] flex-shrink-0', style: { color: 'var(--outline)', opacity: 0.6, fontVariantNumeric: 'tabular-nums' } }, u.time),
                    e('div', { className: 'w-3 flex flex-col items-center flex-shrink-0 mr-2.5' }, dot({ border: '1.5px dashed var(--outline)' }), line(i)),
                    e('div', { className: 'flex-1 min-w-0 py-1.5 flex items-center gap-2', style: rowBorder(i) },
                        e('button', { onClick: () => onOpenSuggestion(u), 'aria-label': `Choose amount of ${u.food.name}`, className: 'flex-1 min-w-0 text-left active:opacity-70', style: { opacity: 0.5 } },
                            e('div', { className: 'text-sm font-bold truncate' }, u.food.name),
                            e('div', { className: 'text-xs truncate', style: { color: 'var(--on-surface-variant)', fontVariantNumeric: 'tabular-nums' } },
                                `Usual · ${amountText({ g: u.g, unit: u.food.unit, serving: servingOf(u.food) })} · ${fmtK(t.kcal)} kcal`)),
                        e('button', { onClick: () => onAccept(u), 'aria-label': 'Log ' + u.food.name, className: 'w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0 active:scale-90', style: { border: '1.5px solid var(--primary-container)', color: 'var(--primary-container)', opacity: 0.85 } },
                            e(MIcon, { icon: 'check', style: { fontSize: '20px' } }))
                    ));
            }
            const en = r.en, t = entryTotals(en);
            return e('button', { key: en.id, onClick: () => onOpen(en), className: 'w-full flex items-stretch text-left active:opacity-70' },
                e('div', { className: 'w-[42px] pt-3 text-[11px] flex-shrink-0', style: { color: 'var(--outline)', fontVariantNumeric: 'tabular-nums' } }, hhmm(en.t)),
                e('div', { className: 'w-3 flex flex-col items-center flex-shrink-0 mr-2.5' }, dot({ background: 'var(--primary-container)' }), line(i)),
                e('div', { className: 'flex-1 min-w-0 py-2.5', style: rowBorder(i) },
                    e('div', { className: 'flex items-start gap-2' },
                        e('div', { className: 'flex-1 min-w-0' },
                            e('div', { className: 'text-sm font-bold truncate' }, en.name),
                            e('div', { className: 'text-xs truncate', style: { color: 'var(--on-surface-variant)' } }, [amountText(en), en.brand].filter(Boolean).join(' · '))
                        ),
                        e('div', { className: 'text-sm font-black flex-shrink-0', style: { fontVariantNumeric: 'tabular-nums' } }, fmtK(t.kcal), e('span', { className: 'text-[10px] font-bold ml-0.5', style: { color: 'var(--on-surface-variant)' } }, 'kcal'))
                    ),
                    e('div', { className: 'flex gap-3 mt-1 text-[11px]', style: { fontVariantNumeric: 'tabular-nums' } },
                        ['p', 'c', 'f'].map(k => e('span', { key: k, className: 'flex items-center gap-1', style: { color: 'var(--on-surface-variant)' } },
                            e('span', { style: { width: 6, height: 6, borderRadius: '50%', background: COLOR[k], display: 'inline-block' } }),
                            `${k.toUpperCase()} ${fmtG(t[k])}`))
                    )
                )
            );
        });
        return e('div', null,
            hasSug && !entries.length ? e('div', { className: 'text-xs px-1 pt-1', style: { color: 'var(--outline)' } }, 'Your usual foods. Tap ✓ to log one, or tap it to change the amount first.') : null,
            rows);
    }

    // ---------- forms ----------
    function NumField({ label: lbl, value, onChange, unit, placeholder, big }) {
        return e('label', { className: 'block' },
            e('div', { className: 'text-[11px] uppercase tracking-widest mb-1', style: { color: 'var(--on-surface-variant)' } }, lbl),
            e('div', { className: 'flex items-center gap-2' },
                e('input', {
                    type: 'text', inputMode: 'decimal', value: value == null ? '' : String(value), placeholder: placeholder || '',
                    onChange: (ev) => onChange(ev.target.value.replace(/[^0-9.,]/g, '')),
                    className: (big ? 'text-2xl font-black p-3' : 'text-base p-2.5') + ' w-full min-w-0 rounded-xl outline-none cwa-input',
                    style: inputStyle
                }),
                unit ? e('span', { className: 'text-sm flex-shrink-0', style: { color: 'var(--on-surface-variant)' } }, unit) : null
            )
        );
    }
    function TextField({ label: lbl, value, onChange, placeholder, inputMode }) {
        return e('label', { className: 'block' },
            e('div', { className: 'text-[11px] uppercase tracking-widest mb-1', style: { color: 'var(--on-surface-variant)' } }, lbl),
            e('input', { type: 'text', value: value || '', placeholder: placeholder || '', inputMode, onChange: (ev) => onChange(ev.target.value), className: 'w-full min-w-0 p-2.5 rounded-xl outline-none text-base cwa-input', style: inputStyle })
        );
    }
    function Segmented({ options, value, onChange }) {
        return e('div', { className: 'grid gap-1.5', style: { gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` } },
            options.map(o => e('button', {
                key: o.id, onClick: () => onChange(o.id),
                className: 'py-2 rounded-xl text-xs font-bold active:scale-95 truncate px-1',
                style: value === o.id ? primaryBtn : { background: 'var(--surface-container-highest)', color: 'var(--on-surface-variant)' }
            }, o.label)));
    }
    // Per-100 g editor used by custom foods and quick add.
    function NutrientFields({ n, setN, unit, absolute }) {
        const set = (k) => (v) => setN({ ...n, [k]: v });
        const per = absolute ? '' : ` / 100 ${unit || 'g'}`;
        return e('div', { className: 'space-y-3' },
            e(NumField, { label: 'Calories' + per, value: n.kcal, onChange: set('kcal'), unit: 'kcal', placeholder: n.p || n.c || n.f ? String(kcalFrom({ p: num(n.p), c: num(n.c), f: num(n.f), fib: num(n.fib) })) : '' }),
            e('div', { className: 'grid grid-cols-3 gap-2' },
                e(NumField, { label: 'Protein', value: n.p, onChange: set('p'), unit: 'g' }),
                e(NumField, { label: 'Carbs', value: n.c, onChange: set('c'), unit: 'g' }),
                e(NumField, { label: 'Fat', value: n.f, onChange: set('f'), unit: 'g' })
            ),
            e('div', { className: 'grid grid-cols-3 gap-2' },
                e(NumField, { label: 'of it sugar', value: n.sug, onChange: set('sug'), unit: 'g' }),
                e(NumField, { label: 'Fibre', value: n.fib, onChange: set('fib'), unit: 'g' }),
                e(NumField, { label: 'Salt', value: n.salt, onChange: set('salt'), unit: 'g' })
            )
        );
    }
    const parseN = (n) => { const o = {}; KEYS.forEach(k => { const v = num(n[k]); if (v != null) o[k] = v; }); if (o.kcal == null && (o.p != null || o.c != null || o.f != null)) o.kcal = kcalFrom(o); return roundN(o); };
    const nToStrings = (n) => { const o = {}; KEYS.forEach(k => { if (n && n[k] != null) o[k] = String(n[k]); }); return o; };

    const stepBtn = (icon, onClick, aria) => e('button', {
        onClick, 'aria-label': aria, className: 'w-14 h-14 rounded-2xl flex items-center justify-center active:scale-90 flex-shrink-0', style: ghostBtn
    }, e(MIcon, { icon, style: { fontSize: '26px' } }));
    const recipeBadge = () => e('span', { className: 'flex items-center gap-0.5 text-[10px] font-black px-1.5 py-0.5 rounded flex-shrink-0', style: { background: 'rgba(209,252,0,0.14)', color: 'var(--primary-fixed-dim)' } },
        e(MIcon, { icon: 'menu_book', style: { fontSize: '12px' } }), 'RECIPE');

    // Amount + meal + time for a food (new entry), or edit an existing entry. A food with a
    // serving gets a piece counter on top (3 eggs); the amount below follows it, and typing a
    // weight updates the count. ingredient: amount only, for a recipe (no meal or time).
    function AmountSheet({ food, entry, date, onSave, onDelete, onClose, onEditFood, ingredient, defaultMeal, defaultTime }) {
        const sv = servingOf(food);
        const initialG = entry ? entry.g : (food.lastG || (sv && sv.g) || 100);
        const [g, setG] = useState(String(initialG));
        const [cnt, setCnt] = useState(sv ? fmtCount(initialG / sv.g) : '');
        const [time, setTime] = useState(entry && entry.t ? hhmm(entry.t) : (defaultTime || hhmm(Date.now())));
        const [meal, setMeal] = useState(entry && entry.meal ? entry.meal : (defaultMeal || mealForTime(timeOnDay(date))));
        const unit = (entry ? entry.unit : food.unit) || 'g';
        const n = (entry ? entry.n : food.n) || {};
        const grams = num(g) || 0;
        const t = entryTotals({ g: grams, n });
        const setGrams = (v) => { setG(v); if (sv) { const x = num(v); setCnt(x > 0 ? fmtCount(x / sv.g) : ''); } };
        const setCount = (v) => { setCnt(v); const c = num(v); setG(c > 0 ? String(Math.round(c * sv.g * 10) / 10) : ''); };
        // − / + go to whole pieces (1.5 → 1 or 2); below one piece, a half is the smallest step.
        const step = (dir) => {
            const c = num(cnt) || 0;
            setCount(fmtCount(dir > 0 ? (c <= 0 ? 1 : c < 0.5 ? 0.5 : c < 1 ? 1 : Math.floor(c) + 1) : (c > 1 ? Math.ceil(c) - 1 : 0.5)));
        };
        const chips = [];
        [50, 100, 150, 200, 250].forEach(v => chips.push({ g: v, label: `${v} ${unit}` }));
        const save = () => { if (grams > 0) onSave(ingredient ? { g: Math.round(grams * 10) / 10 } : { g: Math.round(grams * 10) / 10, meal, t: timeOnDay(date, time) }); };
        const src = (entry || food).src;
        const ings = food.recipe && Array.isArray(food.ingredients) ? food.ingredients : null;
        return e(Sheet, {
            title: ingredient ? 'INGREDIENT' : entry ? 'EDIT' : 'ADD', onClose,
            footer: e('div', { className: 'flex gap-2' },
                entry && onDelete ? e('button', { onClick: onDelete, 'aria-label': ingredient ? 'Remove ingredient' : 'Delete entry', className: 'w-14 rounded-2xl flex items-center justify-center active:scale-95', style: { background: 'var(--error-container)', color: 'var(--on-error-container)' } }, e(MIcon, { icon: 'delete', style: { fontSize: '22px' } })) : null,
                e('button', { onClick: save, disabled: !(grams > 0), className: 'flex-1 py-4 rounded-2xl text-base font-black active:scale-95', style: Object.assign({}, primaryBtn, { opacity: grams > 0 ? 1 : 0.5 }) },
                    entry ? 'Save' : ingredient ? `Add to recipe · ${fmtK(t.kcal)} kcal` : `Add ${fmtK(t.kcal)} kcal`)
            )
        },
            e('div', { className: 'mb-4' },
                e('div', { className: 'text-xl font-black leading-tight' }, (entry || food).name),
                e('div', { className: 'flex items-center gap-2 mt-0.5' },
                    ings ? recipeBadge() : null,
                    e('div', { className: 'text-sm min-w-0', style: { color: 'var(--on-surface-variant)' } },
                        ings ? `${ings.length} ingredient${ings.length === 1 ? '' : 's'}`
                            : [(entry || food).brand, food.alt].filter(Boolean).join(' · ') || ({ off: 'Open Food Facts', custom: 'My food', basic: 'Typical values', ai: 'AI estimate' }[src] || ''))
                ),
                ings ? e('div', { className: 'text-xs mt-1', style: { color: 'var(--on-surface-variant)', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' } }, ings.map(x => x.name).join(', ')) : null,
                e('div', { className: 'text-xs mt-2', style: { color: 'var(--outline)' } }, `Per 100 ${unit}: ${fmtK(n.kcal)} kcal · P ${fmtG(n.p)} · C ${fmtG(n.c)} · F ${fmtG(n.f)}`),
                onEditFood ? e('button', { onClick: onEditFood, className: 'text-xs font-bold mt-2 active:opacity-60', style: { color: 'var(--primary-fixed-dim)' } }, food.recipe ? 'Edit recipe' : 'Edit food values') : null
            ),
            sv ? e('div', { className: 'rounded-2xl p-3 mb-3', style: card },
                e('div', { className: 'text-[11px] uppercase tracking-widest mb-2 truncate', style: { color: 'var(--on-surface-variant)' } }, `How many · ${pieceName(sv)} = ${fmtG(sv.g)} ${unit}`),
                e('div', { className: 'flex items-center gap-2' },
                    stepBtn('remove', () => step(-1), 'One less'),
                    e('input', {
                        type: 'text', inputMode: 'decimal', value: cnt, 'aria-label': 'How many',
                        onChange: (ev) => setCount(ev.target.value.replace(/[^0-9.,]/g, '')),
                        className: 'flex-1 min-w-0 text-center text-3xl font-black p-2 rounded-xl outline-none cwa-input', style: inputStyle
                    }),
                    stepBtn('add', () => step(1), 'One more')
                )
            ) : null,
            e(NumField, { label: sv ? 'Total amount' : 'Amount', value: g, onChange: setGrams, unit, big: !sv }),
            e('div', { className: 'flex gap-1.5 flex-wrap mt-2 mb-5' }, chips.map(c => e('button', {
                key: c.label, onClick: () => setGrams(String(c.g)),
                className: 'px-3 py-1.5 rounded-full text-xs font-bold active:scale-95',
                style: Number(g) === c.g ? primaryBtn : ghostBtn
            }, c.label))),
            ingredient ? null : label('Meal'),
            ingredient ? null : e(Segmented, { options: MEALS, value: meal, onChange: setMeal }),
            ingredient ? null : e('div', { className: 'flex items-center gap-3 mt-4' },
                e('div', { className: 'text-[11px] uppercase tracking-widest', style: { color: 'var(--on-surface-variant)' } }, 'Time'),
                e('input', { type: 'time', value: time, onChange: (ev) => setTime(ev.target.value || time), className: 'p-2 rounded-xl outline-none text-base', style: Object.assign({ colorScheme: 'dark' }, inputStyle) })
            ),
            e('div', { className: 'rounded-2xl p-4 ' + (ingredient ? 'mt-1' : 'mt-5'), style: card },
                e('div', { className: 'flex items-baseline gap-1.5' },
                    e('span', { className: 'text-3xl font-black', style: { fontVariantNumeric: 'tabular-nums' } }, fmtK(t.kcal)),
                    e('span', { className: 'text-sm', style: { color: 'var(--on-surface-variant)' } }, 'kcal')
                ),
                e('div', { className: 'grid grid-cols-3 gap-2 mt-3' }, ['p', 'c', 'f'].map(k => e('div', { key: k },
                    e('div', { className: 'text-[11px] uppercase tracking-widest', style: { color: COLOR[k] } }, LABEL[k]),
                    e('div', { className: 'text-lg font-black', style: { fontVariantNumeric: 'tabular-nums' } }, fmtG(t[k]), e('span', { className: 'text-xs ml-0.5' }, 'g'))
                ))),
                e('div', { className: 'flex gap-4 mt-2 text-xs', style: { color: 'var(--on-surface-variant)', fontVariantNumeric: 'tabular-nums' } },
                    e('span', null, `Fibre ${fmtG(t.fib)} g`), e('span', null, `Sugar ${fmtG(t.sug)} g`), e('span', null, `Salt ${fmtSalt(t.salt)} g`))
            )
        );
    }

    // Create / edit a custom food (also used to check AI-read labels and unknown barcodes).
    function FoodEditor({ initial, note, onSave, onDelete, onClose }) {
        const init = initial || {};
        const [name, setName] = useState(init.name || '');
        const [brand, setBrand] = useState(init.brand || '');
        const [code, setCode] = useState(init.code || '');
        const [unit, setUnit] = useState(init.unit || 'g');
        const [n, setN] = useState(nToStrings(init.n));
        const [servingG, setServingG] = useState(init.serving && init.serving.g ? String(init.serving.g) : '');
        const [servingLabel, setServingLabel] = useState(init.serving && init.serving.label ? init.serving.label : '');
        const parsed = parseN(n);
        const ok = name.trim() && parsed.kcal != null;
        const save = () => {
            if (!ok) return;
            const sg = num(servingG);
            onSave({
                id: init.src === 'custom' && init.id ? init.id : newId('f'), name: name.trim(), brand: brand.trim(), code: code.replace(/\D/g, ''),
                src: 'custom', unit, n: parsed, serving: sg > 0 ? { g: sg, label: servingLabel.trim() || `${sg} ${unit}` } : null,
                updated: Date.now(),
            });
        };
        return e(Sheet, {
            title: init.src === 'custom' && init.id ? 'EDIT FOOD' : 'NEW FOOD', onClose,
            footer: e('div', { className: 'flex gap-2' },
                onDelete ? e('button', { onClick: onDelete, 'aria-label': 'Delete food', className: 'w-14 rounded-2xl flex items-center justify-center active:scale-95', style: { background: 'var(--error-container)', color: 'var(--on-error-container)' } }, e(MIcon, { icon: 'delete', style: { fontSize: '22px' } })) : null,
                e('button', { onClick: save, disabled: !ok, className: 'flex-1 py-4 rounded-2xl text-base font-black active:scale-95', style: Object.assign({}, primaryBtn, { opacity: ok ? 1 : 0.5 }) }, 'Save food')
            )
        },
            note ? e('div', { className: 'flex gap-2 items-start rounded-2xl p-3 mb-4 text-sm', style: { background: 'rgba(209,252,0,0.08)', color: 'var(--on-surface)' } },
                e(MIcon, { icon: 'auto_awesome', style: { fontSize: '18px', color: 'var(--primary-fixed-dim)', marginTop: 1 } }), e('span', null, note)) : null,
            e('div', { className: 'space-y-3' },
                e(TextField, { label: 'Name', value: name, onChange: setName, placeholder: 'e.g. Protein pudding' }),
                e('div', { className: 'grid grid-cols-2 gap-2' },
                    e(TextField, { label: 'Brand', value: brand, onChange: setBrand }),
                    e(TextField, { label: 'Barcode', value: code, onChange: setCode, inputMode: 'numeric' })
                ),
                e('div', null, label('Values per'), e(Segmented, { options: [{ id: 'g', label: '100 g' }, { id: 'ml', label: '100 ml' }], value: unit, onChange: setUnit })),
                e(NutrientFields, { n, setN, unit }),
                e('div', { className: 'grid grid-cols-2 gap-2' },
                    e(NumField, { label: 'Piece / serving', value: servingG, onChange: setServingG, unit }),
                    e(TextField, { label: 'Its name', value: servingLabel, onChange: setServingLabel, placeholder: 'e.g. 1 bar' })
                ),
                e('div', { className: 'text-xs', style: { color: 'var(--outline)' } }, 'With a piece size you can log by count (2 bars) instead of weighing.')
            )
        );
    }

    // ---------- recipes ----------
    // A recipe is one of your foods made of other foods (src 'custom', recipe: true). Its
    // values per 100 g are the ingredients' totals divided by the finished weight: the
    // ingredients' own weight, or what the cooked dish weighs if you enter it (pasta soaks up
    // water, stews lose it). Millilitres count as grams. Ingredient values are copied in, so
    // editing or deleting an ingredient food later doesn't change the recipe. Its serving is
    // one portion (finished weight ÷ portions), so the piece counter logs portions.
    //   recipe = { ...food, recipe: true, ingredients: [ingredient], portions, weight (cooked g) | absent }
    //   ingredient = { name, brand, src, foodId, code, g, unit, n, serving }
    const toIngredient = (food, g) => ({
        name: food.name, brand: food.brand || '', src: food.src || 'custom', foodId: food.src === 'custom' ? (food.id || '') : '',
        code: food.code || '', g, unit: food.unit || 'g', n: food.n || {}, serving: servingOf(food),
    });
    const busyOverlay = (text) => e('div', { className: 'fixed inset-0 z-[180] flex flex-col items-center justify-center gap-3', style: { background: 'rgba(0,0,0,0.75)', color: '#fff' } },
        e('div', { className: 'cwa-spin', style: { width: 36, height: 36, borderRadius: '50%', border: '3px solid rgba(255,255,255,0.2)', borderTopColor: 'var(--primary-container)' } }),
        e('div', { className: 'text-sm font-bold' }, text));

    function RecipeEditor({ initial, app, onSave, onDelete, onClose }) {
        const init = initial || {};
        const editing = !!(init.recipe && init.id);
        const [name, setName] = useState(init.name || '');
        const [ings, setIngs] = useState(() => (Array.isArray(init.ingredients) ? init.ingredients : []).map(x => ({ ...x, key: newId('i') })));
        const [portions, setPortions] = useState(init.portions ? String(init.portions) : '1');
        const [cooked, setCooked] = useState(init.weight ? String(init.weight) : '');
        const [sub, setSub] = useState(null); // { type: 'pick' | 'scan' | 'amount', food, index }
        const [busy, setBusy] = useState(false);
        const [notice, setNotice] = useState('');
        const tot = dayTotals(ings);
        const rawG = ings.reduce((s, x) => s + (num(x.g) || 0), 0);
        const weight = num(cooked) > 0 ? num(cooked) : rawG;
        const nPortions = num(portions) > 0 ? num(portions) : 1;
        const portionG = weight / nPortions;
        const per100 = {};
        KEYS.forEach(k => { per100[k] = weight > 0 ? tot[k] * 100 / weight : 0; });
        const ok = !!(name.trim() && ings.length && weight > 0);
        const save = () => {
            if (!ok) return;
            onSave({
                id: editing ? init.id : newId('f'), name: name.trim(), brand: '', code: '', src: 'custom', recipe: true, unit: 'g',
                n: roundN(per100), serving: { g: Math.round(portionG * 10) / 10, label: '1 portion' },
                ingredients: ings.map(({ key, ...x }) => x), portions: nPortions, weight: num(cooked) > 0 ? num(cooked) : null,
                updated: Date.now(),
            });
        };
        // Barcode → your foods, then Open Food Facts.
        const lookup = async (code) => {
            setNotice('');
            const mine = Object.values(app.foods || {}).find(f => f.code === code);
            if (mine) { setSub({ type: 'amount', food: mine }); return; }
            setBusy(true);
            try {
                const r = await offLookup(code);
                if (r.found && r.food.hasNutrition) setSub({ type: 'amount', food: r.food });
                else { setNotice(`${r.found && r.food.name ? r.food.name : 'Barcode ' + code}: no nutrition data in Open Food Facts. Search by name, or save it as a new food first.`); setSub({ type: 'pick' }); }
            } catch (err) {
                setNotice("Couldn't reach Open Food Facts. Try again, or search by name."); setSub({ type: 'pick' });
            } finally { setBusy(false); }
        };
        const pick = () => { setNotice(''); setSub({ type: 'pick' }); };

        let subEl = null;
        if (sub && sub.type === 'pick') {
            subEl = e(AddSheet, {
                app: { ...app, lookupCode: lookup }, mode: 'ingredient', exclude: init.id, notice, onClose: () => setSub(null),
                onPick: (food) => setSub({ type: 'amount', food }), onScan: () => setSub({ type: 'scan' }),
            });
        } else if (sub && sub.type === 'scan') {
            subEl = e(ScanSheet, { onCode: lookup, onClose: () => setSub({ type: 'pick' }) });
        } else if (sub && sub.type === 'amount') {
            const i = sub.index;
            subEl = e(AmountSheet, {
                key: i != null ? ings[i].key : 'new', food: sub.food, entry: i != null ? ings[i] : null, date: dayKey(Date.now()), ingredient: true,
                onClose: () => setSub(i != null ? null : { type: 'pick' }),
                onDelete: i != null ? () => { setIngs(ings.filter((_, j) => j !== i)); setSub(null); } : null,
                onSave: ({ g }) => {
                    setIngs(i != null ? ings.map((x, j) => (j === i ? { ...x, g } : x)) : ings.concat({ ...toIngredient(sub.food, g), key: newId('i') }));
                    setSub(null);
                },
            });
        }

        const macro = (k) => e('div', { key: k },
            e('div', { className: 'text-[11px] uppercase tracking-widest', style: { color: COLOR[k] } }, LABEL[k]),
            e('div', { className: 'text-lg font-black', style: { fontVariantNumeric: 'tabular-nums' } }, fmtG(tot[k] / nPortions), e('span', { className: 'text-xs ml-0.5' }, 'g')));
        return e(React.Fragment, null,
            e(Sheet, {
                title: editing ? 'EDIT RECIPE' : 'NEW RECIPE', onClose,
                footer: e('div', { className: 'flex gap-2' },
                    onDelete ? e('button', { onClick: onDelete, 'aria-label': 'Delete recipe', className: 'w-14 rounded-2xl flex items-center justify-center active:scale-95', style: { background: 'var(--error-container)', color: 'var(--on-error-container)' } }, e(MIcon, { icon: 'delete', style: { fontSize: '22px' } })) : null,
                    e('button', { onClick: save, disabled: !ok, className: 'flex-1 py-4 rounded-2xl text-base font-black active:scale-95', style: Object.assign({}, primaryBtn, { opacity: ok ? 1 : 0.5 }) }, 'Save recipe')
                )
            },
                e(TextField, { label: 'Name', value: name, onChange: setName, placeholder: 'e.g. Overnight oats' }),
                e('div', { className: 'mt-4' },
                    label(ings.length ? `Ingredients · ${ings.length}` : 'Ingredients'),
                    ings.length ? e('div', { className: 'rounded-2xl px-3 mb-2', style: card }, ings.map((x, i) => e('button', {
                        key: x.key, onClick: () => setSub({ type: 'amount', food: x, index: i }), 'aria-label': 'Change ' + x.name,
                        className: 'w-full flex items-center gap-3 py-2.5 text-left active:opacity-70',
                        style: { borderBottom: i < ings.length - 1 ? '1px solid var(--surface-container-highest)' : 'none' }
                    },
                        e('div', { className: 'flex-1 min-w-0' },
                            e('div', { className: 'text-sm font-bold truncate' }, x.name),
                            e('div', { className: 'text-xs truncate', style: { color: 'var(--on-surface-variant)' } }, [amountText(x), x.brand].filter(Boolean).join(' · '))
                        ),
                        e('div', { className: 'text-sm font-black flex-shrink-0', style: { fontVariantNumeric: 'tabular-nums' } }, fmtK(entryTotals(x).kcal), e('span', { className: 'text-[10px] font-bold ml-0.5', style: { color: 'var(--on-surface-variant)' } }, 'kcal'))
                    ))) : e('div', { className: 'text-sm mb-2', style: { color: 'var(--outline)' } }, 'Add the foods it is made of: your foods, basic foods, a barcode or a product search. Eggs and other pieces can be counted.'),
                    e('button', { onClick: pick, className: 'w-full py-3 rounded-2xl text-base font-bold flex items-center justify-center gap-2 active:scale-95', style: ghostBtn },
                        e(MIcon, { icon: 'add', style: { fontSize: '20px' } }), 'Add ingredient')
                ),
                e('div', { className: 'grid grid-cols-2 gap-2 mt-5' },
                    e(NumField, { label: 'Portions', value: portions, onChange: setPortions, placeholder: '1' }),
                    e(NumField, { label: 'Cooked weight', value: cooked, onChange: setCooked, unit: 'g', placeholder: rawG > 0 ? String(Math.round(rawG)) : '' })
                ),
                e('div', { className: 'text-xs mt-1.5', style: { color: 'var(--outline)' } }, 'Cooked weight is optional: weigh the finished dish if cooking changes it, so a weighed amount logs right. Otherwise the ingredients add up.'),
                ings.length ? e('div', { className: 'rounded-2xl p-4 mt-4', style: card },
                    e('div', { className: 'text-[11px] uppercase tracking-widest', style: { color: 'var(--on-surface-variant)' } }, nPortions === 1 ? `Whole recipe · ${fmtG(weight)} g` : `1 portion of ${fmtCount(nPortions)} · ${fmtG(portionG)} g`),
                    e('div', { className: 'flex items-baseline gap-1.5 mt-1' },
                        e('span', { className: 'text-3xl font-black', style: { fontVariantNumeric: 'tabular-nums' } }, fmtK(tot.kcal / nPortions)),
                        e('span', { className: 'text-sm', style: { color: 'var(--on-surface-variant)' } }, 'kcal')
                    ),
                    e('div', { className: 'grid grid-cols-3 gap-2 mt-3' }, ['p', 'c', 'f'].map(macro)),
                    e('div', { className: 'text-xs mt-3', style: { color: 'var(--outline)', fontVariantNumeric: 'tabular-nums' } },
                        `Per 100 g: ${fmtK(per100.kcal)} kcal · P ${fmtG(per100.p)} · C ${fmtG(per100.c)} · F ${fmtG(per100.f)} · fibre ${fmtG(per100.fib)} · sugar ${fmtG(per100.sug)} · salt ${fmtSalt(per100.salt)}`)
                ) : null
            ),
            subEl,
            busy ? busyOverlay('Looking up barcode…') : null
        );
    }

    function QuickAdd({ date, onSave, onClose }) {
        const [name, setName] = useState('');
        const [n, setN] = useState({});
        const [meal, setMeal] = useState(mealForTime(timeOnDay(date)));
        const [time, setTime] = useState(hhmm(Date.now()));
        const parsed = parseN(n);
        const ok = parsed.kcal != null && parsed.kcal > 0;
        return e(Sheet, {
            title: 'QUICK ADD', onClose,
            footer: e('button', { onClick: () => ok && onSave({ name: name.trim() || 'Quick add', n: parsed, meal, t: timeOnDay(date, time) }), disabled: !ok, className: 'w-full py-4 rounded-2xl text-base font-black active:scale-95', style: Object.assign({}, primaryBtn, { opacity: ok ? 1 : 0.5 }) }, ok ? `Add ${fmtK(parsed.kcal)} kcal` : 'Add')
        },
            e('div', { className: 'space-y-3' },
                e(TextField, { label: 'What was it (optional)', value: name, onChange: setName, placeholder: 'e.g. Lunch at work' }),
                e(NutrientFields, { n, setN, absolute: true }),
                label('Meal'),
                e(Segmented, { options: MEALS, value: meal, onChange: setMeal }),
                e('div', { className: 'flex items-center gap-3' },
                    e('div', { className: 'text-[11px] uppercase tracking-widest', style: { color: 'var(--on-surface-variant)' } }, 'Time'),
                    e('input', { type: 'time', value: time, onChange: (ev) => setTime(ev.target.value || time), className: 'p-2 rounded-xl outline-none text-base', style: Object.assign({ colorScheme: 'dark' }, inputStyle) })
                )
            )
        );
    }

    function TargetsSheet({ profile, metrics, onSave, onClose }) {
        const auto = targetsFor({ targetWeight: profile.targetWeight }, metrics);
        const fields = [['dailyKcal', 'kcal', 'Calories', 'kcal'], ['proteinG', 'p', 'Protein', 'g'], ['carbsG', 'c', 'Carbs', 'g'], ['fatG', 'f', 'Fat', 'g'], ['fibreG', 'fib', 'Fibre (at least)', 'g'], ['sugarMaxG', 'sug', 'Sugar (at most)', 'g'], ['saltMaxG', 'salt', 'Salt (at most)', 'g']];
        const [vals, setVals] = useState(() => Object.fromEntries(fields.map(([pk]) => [pk, profile[pk] != null ? String(profile[pk]) : ''])));
        const save = () => onSave(Object.fromEntries(fields.map(([pk]) => [pk, num(vals[pk])])));
        return e(Sheet, {
            title: 'DAILY TARGETS', onClose,
            footer: e('div', { className: 'flex gap-2' },
                e('button', { onClick: () => setVals(Object.fromEntries(fields.map(([pk]) => [pk, '']))), className: 'px-4 rounded-2xl text-sm font-bold active:scale-95', style: ghostBtn }, 'All automatic'),
                e('button', { onClick: save, className: 'flex-1 py-4 rounded-2xl text-base font-black active:scale-95', style: primaryBtn }, 'Save')
            )
        },
            e('div', { className: 'text-sm mb-4', style: { color: 'var(--on-surface-variant)' } }, 'Leave a field empty to use the automatic value (shown in grey), based on your latest weight. These are the same targets as in Profile › Goals.'),
            e('div', { className: 'grid grid-cols-2 gap-3' }, fields.map(([pk, k, lbl, unit]) => e(NumField, {
                key: pk, label: lbl, unit, value: vals[pk], placeholder: String(auto[k]),
                onChange: (v) => setVals(prev => ({ ...prev, [pk]: v }))
            })))
        );
    }

    // Camera barcode scanner with manual entry and a photo fallback.
    function ScanSheet({ onCode, onPhoto, onClose }) {
        const videoRef = useRef(null);
        const trackRef = useRef(null);
        const [status, setStatus] = useState('Starting camera…');
        const [torch, setTorch] = useState(null); // null = not supported
        const [manual, setManual] = useState('');
        useEffect(() => {
            let stream = null, stopped = false, timer = null;
            (async () => {
                try {
                    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error('No camera access in this browser — type the barcode below.');
                    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
                    if (stopped) { stream.getTracks().forEach(t => t.stop()); return; }
                    const v = videoRef.current;
                    v.srcObject = stream;
                    try { await v.play(); } catch (err) {}
                    const track = stream.getVideoTracks()[0];
                    trackRef.current = track;
                    try { if (track.getCapabilities && track.getCapabilities().torch) setTorch(false); } catch (err) {}
                    setStatus('Loading scanner…');
                    const detector = await getBarcodeDetector();
                    if (stopped) return;
                    setStatus('Point the camera at a barcode');
                    const tick = async () => {
                        if (stopped) return;
                        try {
                            if (v.readyState >= 2) {
                                const found = await detector.detect(v);
                                const hit = (found || []).find(c => /^\d{8,14}$/.test(c.rawValue || ''));
                                if (hit && !stopped) {
                                    stopped = true;
                                    try { navigator.vibrate && navigator.vibrate(50); } catch (err) {}
                                    onCode(hit.rawValue);
                                    return;
                                }
                            }
                        } catch (err) {}
                        timer = setTimeout(tick, 150);
                    };
                    tick();
                } catch (err) {
                    setStatus(err && err.name === 'NotAllowedError' ? 'Camera permission denied — type the barcode below or take a photo.' : ((err && err.message) || 'Camera unavailable'));
                }
            })();
            return () => { stopped = true; clearTimeout(timer); if (stream) stream.getTracks().forEach(t => t.stop()); };
        }, []);
        const toggleTorch = async () => {
            const tr = trackRef.current;
            if (!tr) return;
            try { await tr.applyConstraints({ advanced: [{ torch: !torch }] }); setTorch(!torch); } catch (err) {}
        };
        const submitManual = () => { const c = manual.replace(/\D/g, ''); if (c.length >= 8) onCode(c); };
        return e('div', { className: 'fixed inset-0 z-[170] flex flex-col', style: { background: '#000', color: '#fff' } },
            e('div', { className: 'relative flex-1 overflow-hidden' },
                e('video', { ref: videoRef, playsInline: true, muted: true, autoPlay: true, className: 'absolute inset-0 w-full h-full', style: { objectFit: 'cover' } }),
                e('div', { className: 'absolute inset-0 flex items-center justify-center pointer-events-none' },
                    e('div', { style: { width: '78%', maxWidth: 360, aspectRatio: '1.7', border: '3px solid var(--primary-container)', borderRadius: 18, boxShadow: '0 0 0 9999px rgba(0,0,0,0.45)' } })
                ),
                e('div', { className: 'absolute top-0 left-0 right-0 flex items-center justify-between px-4', style: { paddingTop: 'max(env(safe-area-inset-top), 14px)' } },
                    iconBtn('close', onClose, 'Close scanner', { background: 'rgba(0,0,0,0.55)', color: '#fff' }),
                    torch == null ? e('div') : iconBtn(torch ? 'flash_off' : 'flash_on', toggleTorch, 'Toggle flashlight', { background: 'rgba(0,0,0,0.55)', color: '#fff' })
                ),
                e('div', { className: 'absolute left-0 right-0 text-center text-sm font-bold px-6', style: { bottom: 18, textShadow: '0 1px 4px #000' } }, status)
            ),
            e('div', { className: 'px-4 pt-3', style: { background: 'var(--void)', paddingBottom: 'max(env(safe-area-inset-bottom), 14px)' } },
                e('div', { className: 'max-w-lg mx-auto flex gap-2' },
                    e('input', {
                        type: 'text', inputMode: 'numeric', value: manual, placeholder: 'Type barcode', 'aria-label': 'Barcode number',
                        onChange: (ev) => setManual(ev.target.value.replace(/\D/g, '')), onKeyDown: (ev) => { if (ev.key === 'Enter') submitManual(); },
                        className: 'flex-1 min-w-0 p-3 rounded-xl outline-none text-base cwa-input', style: inputStyle
                    }),
                    e('button', { onClick: submitManual, 'aria-label': 'Look up barcode', className: 'px-4 rounded-xl font-black active:scale-95', style: primaryBtn }, e(MIcon, { icon: 'search', style: { fontSize: '22px' } })),
                    onPhoto ? e('button', { onClick: onPhoto, 'aria-label': 'Take a photo instead', className: 'px-4 rounded-xl font-black active:scale-95', style: ghostBtn }, e(MIcon, { icon: 'photo_camera', style: { fontSize: '22px' } })) : null
                )
            )
        );
    }

    function FoodRow({ food, onClick, right }) {
        const n = food.n || {};
        const recipe = food.recipe && Array.isArray(food.ingredients);
        const sv = servingOf(food);
        const sub = recipe
            ? [`${food.ingredients.length} ingredient${food.ingredients.length === 1 ? '' : 's'}`, sv ? `${fmtK((n.kcal || 0) * sv.g / 100)} kcal / portion` : `${fmtK(n.kcal)} kcal / 100 g`].join(' · ')
            : [food.brand, food.alt, `${fmtK(n.kcal)} kcal / 100 ${food.unit || 'g'}`].filter(Boolean).join(' · ');
        const badge = { off: 'OFF', custom: 'MY', basic: '', ai: 'AI' }[food.src] || '';
        return e('div', { className: 'flex items-center gap-2' },
            e('button', { onClick, className: 'flex-1 min-w-0 flex items-center gap-3 py-2.5 text-left active:opacity-70' },
                e('div', { className: 'flex-1 min-w-0' },
                    e('div', { className: 'text-sm font-bold truncate' }, food.name),
                    e('div', { className: 'text-xs truncate', style: { color: 'var(--on-surface-variant)' } }, sub)
                ),
                recipe ? recipeBadge()
                    : badge ? e('span', { className: 'text-[10px] font-black px-1.5 py-0.5 rounded flex-shrink-0', style: { background: 'var(--surface-container-highest)', color: 'var(--on-surface-variant)' } }, badge) : null
            ),
            right || null
        );
    }

    // Unique foods from the diary, newest first (the "Recent" list).
    function recentFoods(log, customFoods) {
        const days = Object.keys(log || {}).sort().reverse().slice(0, 60);
        const seen = new Set(), out = [];
        for (const d of days) {
            const list = (log[d] || []).slice().sort((a, b) => b.t - a.t);
            for (const en of list) {
                if (en.src === 'quick') continue;
                const key = en.foodId || en.code || fold(en.name + '|' + en.brand);
                if (seen.has(key)) continue;
                seen.add(key);
                const live = en.foodId && customFoods[en.foodId];
                out.push(live ? { ...live, lastG: en.g } : { id: en.foodId || '', name: en.name, brand: en.brand, code: en.code, src: en.src, unit: en.unit, n: en.n, serving: servingOf(en), lastG: en.g });
                if (out.length >= 40) return out;
            }
        }
        return out;
    }

    // mode 'ingredient': picking a recipe ingredient (search, scan, your foods; no logging
    // actions), without the recipe being edited (exclude = its id).
    function AddSheet({ app, onPick, onScan, onPhoto, onQuick, onNewFood, onNewRecipe, onEditFood, onClose, mode, exclude, notice }) {
        const pickIng = mode === 'ingredient';
        const [q, setQ] = useState('');
        const [online, setOnline] = useState({ q: '', world: false, state: 'idle', items: [], error: '' });
        const custom = Object.values(app.foods || {}).filter(f => !exclude || f.id !== exclude);
        const recent = recentFoods(app.log, app.foods || {}).filter(f => !exclude || f.id !== exclude);
        const recipes = custom.filter(f => f.recipe).sort((a, b) => a.name.localeCompare(b.name));
        const plain = custom.filter(f => !f.recipe).sort((a, b) => a.name.localeCompare(b.name));
        const fq = fold(q.trim());
        const tokens = fq.split(/\s+/).filter(Boolean);
        const matches = (f) => { const h = fold([f.name, f.brand, f.alt, f.code].join(' ')); return tokens.every(t => h.includes(t)); };
        const local = fq ? [...custom, ...recent.filter(r => r.src !== 'custom'), ...cachedProducts(), ...BASIC_FOODS].filter(matches).filter((f, i, a) => a.findIndex(x => (x.code && x.code === f.code) || (x.name === f.name && x.brand === f.brand)) === i).slice(0, 25) : [];
        const runSearch = async (world) => {
            const query = q.trim();
            if (query.length < 2 || /^\d{8,14}$/.test(query)) return;
            setOnline({ q: query, world, state: 'loading', items: [], error: '' });
            try { const items = await offSearch(query, world); setOnline(o => o.q === query && o.world === world ? { ...o, state: 'done', items } : o); }
            catch (err) { setOnline(o => o.q === query && o.world === world ? { ...o, state: 'error', error: searchErrorText(err) } : o); }
        };
        const isCode = /^\d{8,14}$/.test(q.trim());
        const section = (title, items, opts) => items.length ? e('div', { className: 'mt-4' },
            label(title),
            e('div', { className: 'rounded-2xl px-3', style: card }, items.map((f, i) => e('div', { key: (f.id || f.code || f.name) + i, style: { borderBottom: i < items.length - 1 ? '1px solid var(--surface-container-highest)' : 'none' } },
                e(FoodRow, { food: f, onClick: () => onPick(f), right: !pickIng && opts && opts.editable && f.src === 'custom' ? iconBtn('edit', () => onEditFood(f), 'Edit ' + f.name, { width: 34, height: 34, background: 'transparent', color: 'var(--on-surface-variant)' }) : null })
            )))) : null;
        const action = (icon, text, onClick) => e('button', { onClick, className: 'flex flex-col items-center justify-center gap-1 py-3 px-0.5 rounded-2xl active:scale-95 min-w-0', style: card },
            e(MIcon, { icon, style: { fontSize: '22px', color: 'var(--primary-container)' } }), e('span', { className: 'text-[11px] font-bold leading-tight text-center' }, text));
        return e(Sheet, { title: pickIng ? 'ADD INGREDIENT' : 'ADD FOOD', onClose },
            notice ? e('div', { className: 'mb-3 rounded-xl px-3 py-2 text-sm', style: { background: 'rgba(255,115,81,0.12)', color: 'var(--error)' } }, notice) : null,
            e('div', { className: 'flex items-center gap-2 rounded-2xl px-3', style: inputStyle },
                e(MIcon, { icon: 'search', style: { fontSize: '20px', color: 'var(--on-surface-variant)' } }),
                e('input', { type: 'text', enterKeyHint: 'search', value: q, autoFocus: true, placeholder: 'Search foods or type a barcode', onChange: (ev) => setQ(ev.target.value),
                    onKeyDown: (ev) => { if (ev.key === 'Enter') { ev.target.blur(); if (/^\d{8,14}$/.test(q.trim())) app.lookupCode(q.trim()); else runSearch(false); } }, className: 'flex-1 min-w-0 py-3 bg-transparent outline-none text-base cwa-input', style: { color: 'var(--on-surface)' } }),
                q ? e('button', { onClick: () => setQ(''), 'aria-label': 'Clear search', className: 'active:opacity-60', style: { color: 'var(--on-surface-variant)' } }, e(MIcon, { icon: 'close', style: { fontSize: '20px' } })) : null
            ),
            pickIng
                ? e('button', { onClick: onScan, className: 'w-full mt-3 py-3 rounded-2xl text-base font-bold flex items-center justify-center gap-2 active:scale-95', style: card },
                    e(MIcon, { icon: 'barcode_scanner', style: { fontSize: '20px', color: 'var(--primary-container)' } }), 'Scan a barcode')
                : e('div', { className: 'grid grid-cols-5 gap-1.5 mt-3' },
                    action('barcode_scanner', 'Scan', onScan),
                    action('photo_camera', 'Photo', onPhoto),
                    action('bolt', 'Quick add', onQuick),
                    action('add', 'New food', () => onNewFood({})),
                    action('menu_book', 'Recipe', onNewRecipe)
                ),
            isCode ? e('button', { onClick: () => app.lookupCode(q.trim()), className: 'w-full mt-4 py-3 rounded-2xl text-base font-bold active:scale-95', style: primaryBtn }, `Look up barcode ${q.trim()}`) : null,
            fq ? null : section('Recent', recent.slice(0, 15)),
            fq ? null : section('My recipes', recipes, { editable: true }),
            fq ? null : section('My foods', plain, { editable: true }),
            fq ? section('Matches', local, { editable: true }) : null,
            fq && !isCode ? e('div', { className: 'mt-4' },
                label('Open Food Facts'),
                online.q !== q.trim() || online.state === 'idle'
                    ? e('button', { onClick: () => runSearch(false), disabled: q.trim().length < 2, className: 'w-full py-3 rounded-2xl text-base font-bold flex items-center justify-center gap-2 active:scale-95', style: Object.assign({}, ghostBtn, { opacity: q.trim().length < 2 ? 0.5 : 1 }) },
                        e(MIcon, { icon: 'search', style: { fontSize: '20px' } }), `Search products for “${q.trim()}”`)
                    : online.state === 'loading' ? e('div', { className: 'text-sm py-3 text-center', style: { color: 'var(--on-surface-variant)' } }, online.world ? 'Searching worldwide…' : 'Searching Open Food Facts…')
                        : online.state === 'error' ? e('div', null,
                            e('div', { className: 'text-sm', style: { color: 'var(--error)' } }, online.error),
                            e('button', { onClick: () => runSearch(online.world), className: 'mt-2 px-4 py-2 rounded-xl text-sm font-bold active:scale-95', style: ghostBtn }, 'Try again'))
                            : e('div', null,
                                online.items.length ? e('div', { className: 'rounded-2xl px-3', style: card }, online.items.map((f, i) => e('div', { key: f.code + i, style: { borderBottom: i < online.items.length - 1 ? '1px solid var(--surface-container-highest)' : 'none' } }, e(FoodRow, { food: f, onClick: () => onPick(f) }))))
                                    : e('div', { className: 'text-sm', style: { color: 'var(--outline)' } }, online.world || online.items.global ? 'No products found. Try fewer words, or add it as a new food.' : 'Nothing found among products sold in Czechia.'),
                                online.world || online.items.global ? null : e('button', { onClick: () => runSearch(true), className: 'mt-2 w-full py-2.5 rounded-xl text-sm font-bold active:scale-95', style: ghostBtn }, 'Search worldwide too')
                            )
            ) : null,
            !fq && !recent.length && !custom.length ? e('div', { className: 'text-sm mt-6 text-center', style: { color: 'var(--outline)' } }, pickIng ? 'Search above — basic foods like eggs, oats or rice are built in.' : 'Search above — your recent foods will show up here.') : null,
            e('div', { className: 'text-[10px] mt-6 text-center', style: { color: 'var(--outline)' } }, 'Product data: Open Food Facts (ODbL). Basic foods: typical values.')
        );
    }

    // After a photo without a readable nutrition table. Real data first: Open Food Facts
    // products (packages) or your/basic foods (unpackaged food), then the AI's own estimate as
    // a fallback — for packaged products that estimate is only a rough guess.
    function PhotoResultSheet({ result, kind, query, matches, searching, onPick, onUseEstimate, onLabelPhoto, onClose }) {
        const n = result.per100 || {};
        const model = String(result._model || '').split('/').pop();
        const isPkg = kind === 'package';
        const kindLabel = { package: 'Package', meal: 'Meal', food: 'Food', label: 'Label' }[kind] || 'Photo';
        const estimate = n.kcal != null ? e('div', { className: 'mt-4' },
            label(isPkg ? 'AI guess (no label visible)' : 'AI estimate'),
            e('div', { className: 'rounded-2xl p-4', style: card },
                e('div', { className: 'text-sm', style: { color: 'var(--on-surface-variant)' } }, `Per 100 ${result.unit === 'ml' ? 'ml' : 'g'}: ${fmtK(n.kcal)} kcal · P ${fmtG(n.protein)} · C ${fmtG(n.carbs)} · F ${fmtG(n.fat)}` + (result.servingGrams ? ` · portion ~${Math.round(result.servingGrams)} g` : '')),
                isPkg ? e('div', { className: 'text-xs mt-1', style: { color: 'var(--warn)' } }, 'Typical values for this kind of product, not read from the pack. Can be far off.') : null,
                e('button', { onClick: onUseEstimate, className: 'w-full mt-3 py-3 rounded-xl text-base font-black active:scale-95', style: isPkg ? ghostBtn : primaryBtn }, isPkg ? 'Use the guess anyway' : 'Use AI estimate')
            )) : null;
        return e(Sheet, { title: 'PHOTO', onClose },
            e('div', { className: 'rounded-2xl p-4', style: card },
                e('div', { className: 'flex items-center gap-2 text-xs font-bold uppercase tracking-widest', style: { color: 'var(--primary-fixed-dim)' } }, e(MIcon, { icon: 'auto_awesome', style: { fontSize: '16px' } }), `AI sees · ${kindLabel}`),
                e('div', { className: 'text-lg font-black mt-1' }, [result.brand, result.name].filter(Boolean).join(' ') || 'Unknown food'),
                model ? e('div', { className: 'text-[11px] mt-1', style: { color: 'var(--outline)' } }, `Read by ${model}`) : null,
                isPkg ? e('button', { onClick: onLabelPhoto, className: 'w-full mt-3 py-3 rounded-xl text-base font-bold flex items-center justify-center gap-2 active:scale-95', style: primaryBtn },
                    e(MIcon, { icon: 'photo_camera', style: { fontSize: '20px' } }), 'Photo the nutrition table instead') : null,
                isPkg ? e('div', { className: 'text-xs mt-2', style: { color: 'var(--on-surface-variant)' } }, 'The table on the back gives exact values. The front only shows what the product is.') : null
            ),
            e('div', { className: 'mt-4' },
                label(isPkg ? `Products matching “${query}”` : `Foods matching “${query}”`),
                searching ? e('div', { className: 'text-sm', style: { color: 'var(--on-surface-variant)' } }, 'Searching…')
                    : matches.length ? e('div', { className: 'rounded-2xl px-3', style: card }, matches.map((f, i) => e('div', { key: (f.code || f.id || f.name) + i, style: { borderBottom: i < matches.length - 1 ? '1px solid var(--surface-container-highest)' : 'none' } }, e(FoodRow, { food: f, onClick: () => onPick(f) }))))
                        : e('div', { className: 'text-sm', style: { color: 'var(--outline)' } }, 'Nothing matching found.')
            ),
            estimate
        );
    }

    // Your foods + basic foods whose name contains every word of `query` (accents ignored).
    function localMatches(query, customFoods) {
        const tokens = fold(query).split(/\s+/).filter(t => t.length > 1);
        if (!tokens.length) return [];
        const hit = (f) => { const h = fold([f.name, f.brand, f.alt].join(' ')); return tokens.every(t => h.includes(t)); };
        let out = [...Object.values(customFoods || {}), ...BASIC_FOODS].filter(hit);
        // Fall back to "any word" for multi-word dish names ("chicken with rice").
        if (!out.length) out = [...Object.values(customFoods || {}), ...BASIC_FOODS].filter(f => { const h = fold([f.name, f.alt].join(' ')); return tokens.some(t => t.length > 3 && h.includes(t)); });
        return out.slice(0, 8);
    }

    // AI photo result → food object (per100 uses long names; ours are short keys).
    function aiToFood(r) {
        const p = r.per100 || {};
        const sg = num(r.servingGrams);
        return {
            name: String(r.name || 'Food').trim(), brand: String(r.brand || '').trim(), code: String(r.barcode || '').replace(/\D/g, ''),
            src: 'ai', unit: r.unit === 'ml' ? 'ml' : 'g',
            n: roundN({ kcal: p.kcal, p: p.protein, c: p.carbs, f: p.fat, fib: p.fibre != null ? p.fibre : p.fiber, sug: p.sugar, salt: p.salt }),
            serving: sg > 0 ? { g: Math.round(sg), label: '1 portion' } : null,
        };
    }

    // ---------- one nutrient, split by food (tap it in the day summary) ----------
    const unitOf = (k) => (k === 'kcal' ? 'kcal' : 'g');
    // The day's foods by how much of nutrient k each gave (the same food logged twice is one
    // row), the foods with none of it, and the split by meal.
    // "5× vejce · 275 g" when every entry counts the same piece, else "2× · 275 g".
    function groupAmount(g) {
        if (g.entries.length === 1) return amountText(g.entries[0]);
        const sv = g.entries[0].serving;
        const same = sv && g.entries.every(en => en.serving && en.serving.g === sv.g && en.serving.label === sv.label);
        const c = same ? piecesOf(g.grams, sv) : null;
        return c ? `${fmtCount(c)}× ${pieceName(sv)} · ${fmtG(g.grams)} g` : `${g.entries.length}× · ${fmtG(g.grams)} g`;
    }
    function macroSplit(entries, k) {
        const tiny = k === 'kcal' ? 0.5 : k === 'salt' ? 0.005 : 0.05;
        const groups = new Map();
        (entries || []).forEach(en => {
            const id = foodKey(en);
            const g = groups.get(id) || { id, name: en.name || 'Food', brand: en.brand || '', value: 0, grams: 0, entries: [] };
            g.value += entryTotals(en)[k] || 0;
            g.grams += num(en.g) || 0;
            g.entries.push(en);
            groups.set(id, g);
        });
        const all = [...groups.values()];
        const total = all.reduce((a, g) => a + g.value, 0);
        const items = all.filter(g => g.value >= tiny).sort((a, b) => b.value - a.value)
            .map(g => ({ ...g, share: total > 0 ? g.value / total : 0, amount: groupAmount(g) }));
        const none = all.filter(g => g.value < tiny).map(g => g.name);
        const meals = MEALS.map(m => ({ id: m.id, label: m.label, value: (entries || []).filter(en => en.meal === m.id).reduce((a, en) => a + (entryTotals(en)[k] || 0), 0) }))
            .filter(m => m.value >= tiny);
        return { total, items, none, meals };
    }

    function MacroSheet({ k, entries, totals, targets, dayLabel, onPick, onClose, onEditTargets }) {
        const split = macroSplit(entries, k);
        const unit = unitOf(k);
        const target = targets[k];
        const top = split.items.length ? split.items[0].value : 0;
        const limit = k === 'sug' || k === 'salt';
        const over = target > 0 && totals[k] > target;
        const pct = (x) => (x > 0 && x < 0.005 ? '<1 %' : `${Math.round(x * 100)} %`);
        const chip = (key) => e('button', {
            key, onClick: () => onPick(key), 'aria-pressed': key === k,
            className: 'flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm font-bold whitespace-nowrap active:scale-95 flex-shrink-0',
            style: key === k ? { background: 'var(--surface-container-highest)', color: 'var(--on-surface)' } : { color: 'var(--on-surface-variant)' },
        }, e('span', { style: { width: 8, height: 8, borderRadius: 4, background: COLOR[key], flexShrink: 0 } }), LABEL[key]);

        return e(Sheet, {
            title: LABEL[k].toUpperCase(), onClose,
            footer: e('button', { onClick: onEditTargets, className: 'w-full py-3.5 rounded-2xl text-base font-bold flex items-center justify-center gap-2 active:scale-95', style: ghostBtn },
                e(MIcon, { icon: 'tune', style: { fontSize: '20px' } }), 'Edit daily targets'),
        },
            e('div', { className: 'flex gap-1 overflow-x-auto -mx-4 px-4 pb-1 mb-4', role: 'group', 'aria-label': 'Nutrient' }, KEYS.map(chip)),
            e('div', { className: 'rounded-2xl p-4 mb-3', style: card },
                e('div', { className: 'text-xs uppercase tracking-widest', style: { color: 'var(--on-surface-variant)' } }, dayLabel),
                e('div', { className: 'flex items-baseline gap-1.5 mt-1' },
                    e('span', { className: 'font-black', style: { fontSize: 36, lineHeight: 1, color: over && limit ? 'var(--error)' : 'var(--on-surface)' } }, fmtVal(k, totals[k])),
                    e('span', { className: 'text-sm', style: { color: 'var(--on-surface-variant)' } }, `${unit} of ${fmtVal(k, target)} ${unit}` + (target > 0 ? ` · ${pct(totals[k] / target)}` : ''))),
                split.meals.length > 1 ? e('div', { className: 'text-xs mt-2 leading-relaxed', style: { color: 'var(--on-surface-variant)' } },
                    split.meals.map((m, i) => e('span', { key: m.id, className: 'whitespace-nowrap' }, (i ? ' · ' : '') + `${m.label} `, e('b', { style: { color: 'var(--on-surface)' } }, fmtVal(k, m.value)), ` ${unit}`))) : null
            ),
            split.items.length
                ? e('div', { className: 'rounded-2xl px-4 py-1', style: card },
                    e('div', { className: 'flex justify-between text-[11px] uppercase tracking-widest pt-2 pb-1', style: { color: 'var(--on-surface-variant)' } },
                        e('span', null, 'Food'), e('span', null, `${k === 'kcal' ? 'kcal' : 'grams'} · share`)),
                    split.items.map((it, i) => e('div', { key: it.id, className: 'py-2.5', style: { borderTop: i ? '1px solid var(--surface-container-highest)' : 'none' } },
                        e('div', { className: 'flex items-baseline justify-between gap-3' },
                            e('div', { className: 'min-w-0' },
                                e('div', { className: 'text-sm font-bold truncate' }, it.name),
                                e('div', { className: 'text-[11px] truncate', style: { color: 'var(--on-surface-variant)' } }, [it.brand, it.amount].filter(Boolean).join(' · '))),
                            e('div', { className: 'text-right flex-shrink-0 whitespace-nowrap', style: { fontVariantNumeric: 'tabular-nums' } },
                                e('span', { className: 'text-sm font-black' }, fmtVal(k, it.value)),
                                e('span', { className: 'text-xs', style: { color: 'var(--on-surface-variant)' } }, ` ${unit} · ${pct(it.share)}`))),
                        // Ranked bars: the biggest source is full width, the rest relative to it.
                        e('div', { className: 'mt-1.5', style: { height: 8, width: `${Math.max(2, (it.value / top) * 100)}%`, background: COLOR[k], borderRadius: '0 4px 4px 0' } })
                    )))
                : e('div', { className: 'text-center text-sm py-10', style: { color: 'var(--on-surface-variant)' } },
                    entries.length ? `Nothing logged on this day has any ${LABEL[k].toLowerCase()}.` : 'Nothing logged on this day yet.'),
            split.none.length && split.items.length ? e('div', { className: 'text-xs mt-3 px-1 leading-snug', style: { color: 'var(--outline)' } },
                `No ${LABEL[k].toLowerCase()}: ${split.none.join(', ')}.`) : null
        );
    }

    // ---------- the screen ----------
    function FoodScreen({ app }) {
        const date = app.date;
        const today = dayKey(Date.now());
        const entries = (app.log[date] || []).slice().sort(byMeal);
        const totals = dayTotals(entries);
        const targets = targetsFor(app.profile, app.metrics);
        const [sheet, setSheet] = useState(null); // { type, ... }
        const [busy, setBusy] = useState('');
        const [error, setError] = useState('');
        const photoInput = useRef(null);
        const cover = useViewport().isCover;

        const shiftDay = (delta) => { const d = keyToDate(date); d.setDate(d.getDate() + delta); app.setDate(dayKey(d.getTime())); };
        const dateLabel = date === today ? 'Today' : date === dayKey(Date.now() - 86400000) ? 'Yesterday'
            : keyToDate(date).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });

        const addEntry = (food, { g, meal, t }) => {
            const entry = { id: newId('e'), t, meal, name: food.name, brand: food.brand || '', code: food.code || '', src: food.src || 'custom', foodId: food.src === 'custom' ? (food.id || '') : '', g, unit: food.unit || 'g', n: food.n };
            const sv = servingOf(food);
            if (sv) entry.serving = sv; // so the diary can say "3× vejce" and edit by count
            app.saveDay(date, entries.concat(entry).sort(byMeal));
            app.toast(`Added ${fmtK(entryTotals(entry).kcal)} kcal`);
            setSheet(null);
        };
        const updateEntry = (entry, changes) => {
            app.saveDay(date, entries.map(x => (x.id === entry.id ? { ...x, ...changes } : x)).sort(byMeal));
            setSheet(null);
        };
        const deleteEntry = (entry) => { app.saveDay(date, entries.filter(x => x.id !== entry.id)); setSheet(null); app.toast('Removed'); };
        const saveFood = (food) => { app.setFoods(prev => ({ ...prev, [food.id]: food })); return food; };
        const deleteFood = (food) => { app.setFoods(prev => { const next = { ...prev }; delete next[food.id]; return next; }); };

        // Barcode → your foods, then Open Food Facts; unknown → photo of the label or manual entry.
        const lookupCode = async (code) => {
            setSheet(null); setError('');
            const mine = Object.values(app.foods || {}).find(f => f.code === code);
            if (mine) { setSheet({ type: 'amount', food: mine }); return; }
            setBusy('Looking up ' + code + '…');
            try {
                const r = await offLookup(code);
                if (r.found && r.food.hasNutrition) setSheet({ type: 'amount', food: r.food });
                else setSheet({ type: 'missing', code, name: r.found ? r.food.name : '', brand: r.found ? r.food.brand : '' });
            } catch (err) {
                setSheet({ type: 'missing', code, offline: true });
            } finally { setBusy(''); }
        };

        const photoCount = () => { try { return parseInt(localStorage.getItem('cwa-photoai-' + today) || '0', 10); } catch (err) { return 0; } };
        const takePhoto = () => {
            setError('');
            if (!app.aiEnabled) { setError('The AI service is not configured.'); return; }
            if (photoCount() >= PHOTO_DAILY_LIMIT) { setError(`Daily photo limit reached (${PHOTO_DAILY_LIMIT}). Resets tomorrow.`); return; }
            setSheet(null);
            if (photoInput.current) photoInput.current.click();
        };
        const onPhotoFile = async (file) => {
            if (!file) return;
            setBusy('Reading photo…'); setError('');
            try {
                const image = await compressImage(file, 1280, 0.85);
                const r = await callFoodVision(image, app.user);
                try { localStorage.setItem('cwa-photoai-' + today, String(photoCount() + 1)); } catch (err) {}
                const food = aiToFood(r);
                const hasCode = food.code.length >= 8;
                // 1) A product you already have (your foods, or one looked up before) → that.
                if (hasCode) {
                    const mine = Object.values(app.foods || {}).find(f => f.code === food.code);
                    const cached = mine ? null : cacheGet(food.code);
                    if (mine || (cached && cached.hasNutrition)) { setSheet({ type: 'amount', food: mine || cached }); return; }
                }
                // 2) A nutrition table → its numbers right away (no waiting on Open Food Facts);
                //    check them, save as your food.
                if (r.source === 'label' && food.n.kcal != null) {
                    setSheet({ type: 'editor', food, note: 'Read by AI from the label — check the numbers, then save. It becomes one of your foods.', thenAdd: true });
                    return;
                }
                // 3) No table but a readable barcode → the real product data.
                if (hasCode) {
                    setBusy('Looking up ' + food.code + '…');
                    try {
                        const hit = await offLookup(food.code);
                        if (hit.found && hit.food.hasNutrition) { setSheet({ type: 'amount', food: hit.food }); return; }
                    } catch (err) {}
                }
                // 4) No table: a package → look the product up by the name printed on it;
                //    unpackaged food / a meal → your and basic foods. The AI's estimate is the fallback.
                const kind = r.kind === 'meal' || r.kind === 'food' || r.kind === 'package' ? r.kind : 'package';
                const q = String(r.searchText || [food.brand, food.name].filter(Boolean).join(' ')).trim();
                if (kind !== 'package') {
                    setSheet({ type: 'photo', result: r, food, kind, query: q, matches: localMatches(q, app.foods).concat(localMatches(food.name, app.foods)).filter((f, i, a) => a.indexOf(f) === i).slice(0, 8), searching: false });
                    return;
                }
                setSheet({ type: 'photo', result: r, food, kind, query: q, matches: [], searching: true });
                let matches = [];
                if (q.length >= 3) {
                    try { matches = await offSearch(q, false); } catch (err) {}
                    if (matches.length < 3 && !matches.global) { try { const w = await offSearch(q, true); const seen = new Set(matches.map(f => f.code)); matches = matches.concat(w.filter(f => !seen.has(f.code))); } catch (err) {} }
                }
                setSheet(s => (s && s.type === 'photo' && s.result === r ? { ...s, matches: matches.slice(0, 8), searching: false } : s));
            } catch (err) {
                setError(err.message || 'Could not read the photo.');
            } finally { setBusy(''); }
        };

        app = { ...app, lookupCode };
        let sheetEl = null;
        if (sheet) {
            const close = () => setSheet(null);
            if (sheet.type === 'add') {
                sheetEl = e(AddSheet, {
                    app, onClose: close,
                    onPick: (food) => setSheet({ type: 'amount', food }),
                    onScan: () => setSheet({ type: 'scan' }),
                    onPhoto: takePhoto,
                    onQuick: () => setSheet({ type: 'quick' }),
                    onNewFood: (food) => setSheet({ type: 'editor', food, thenAdd: true }),
                    onNewRecipe: () => setSheet({ type: 'recipe', food: null, thenAdd: true }),
                    onEditFood: (food) => setSheet({ type: food.recipe ? 'recipe' : 'editor', food, back: 'add' }),
                });
            } else if (sheet.type === 'amount') {
                const en = sheet.entry;
                const food = sheet.food || {};
                // A diary entry edits the food it came from (by foodId; the entry's own id is not a food id).
                const editable = en ? (en.foodId && app.foods[en.foodId]) || null : (food.src === 'custom' && food.id ? food : null);
                sheetEl = e(AmountSheet, {
                    key: (en && en.id) || food.code || food.name, food, entry: en, date, onClose: close, defaultMeal: sheet.meal, defaultTime: sheet.time,
                    onSave: (v) => (en ? updateEntry(en, v) : addEntry(food, v)),
                    onDelete: en ? () => deleteEntry(en) : null,
                    onEditFood: editable ? () => setSheet({ type: editable.recipe ? 'recipe' : 'editor', food: editable, back: en ? null : 'amount' }) : (food.src === 'ai' ? () => setSheet({ type: 'editor', food, thenAdd: true, note: 'AI estimate — adjust the numbers, then save as your food.' }) : null),
                });
            } else if (sheet.type === 'recipe' || (sheet.type === 'editor' && sheet.food && sheet.food.recipe)) {
                const f = sheet.food || {};
                sheetEl = e(RecipeEditor, {
                    key: f.id || 'new-recipe', initial: f, app, onClose: close,
                    onDelete: f.id && app.foods[f.id] ? () => app.confirm({ title: 'Delete recipe?', message: `"${f.name}" will be removed from your foods. Logged entries stay.`, confirmLabel: 'Delete', onConfirm: () => { deleteFood(f); setSheet(null); } }) : null,
                    onSave: (food) => { saveFood(food); app.toast('Recipe saved'); setSheet(sheet.thenAdd || sheet.back === 'amount' ? { type: 'amount', food } : sheet.back === 'add' ? { type: 'add' } : null); },
                });
            } else if (sheet.type === 'editor') {
                const f = sheet.food || {};
                sheetEl = e(FoodEditor, {
                    key: f.id || f.code || 'new', initial: f, note: sheet.note, onClose: close,
                    onDelete: f.src === 'custom' && f.id && app.foods[f.id] ? () => app.confirm({ title: 'Delete food?', message: `"${f.name}" will be removed from your foods. Logged entries stay.`, confirmLabel: 'Delete', onConfirm: () => { deleteFood(f); setSheet(null); } }) : null,
                    onSave: (food) => { saveFood(food); app.toast('Food saved'); setSheet(sheet.thenAdd || sheet.back === 'amount' ? { type: 'amount', food } : sheet.back === 'add' ? { type: 'add' } : null); },
                });
            } else if (sheet.type === 'quick') {
                sheetEl = e(QuickAdd, { date, onClose: close, onSave: (v) => addEntry({ name: v.name, src: 'quick', unit: 'g', n: v.n }, { g: 100, meal: v.meal, t: v.t }) });
            } else if (sheet.type === 'macro') {
                sheetEl = e(MacroSheet, { k: sheet.k, entries, totals, targets, dayLabel: dateLabel, onPick: (k) => setSheet({ type: 'macro', k }), onClose: close, onEditTargets: () => setSheet({ type: 'targets' }) });
            } else if (sheet.type === 'targets') {
                sheetEl = e(TargetsSheet, { profile: app.profile, metrics: app.metrics, onClose: close, onSave: (vals) => { app.setProfileFields(vals); setSheet(null); app.toast('Targets saved'); } });
            } else if (sheet.type === 'scan') {
                sheetEl = e(ScanSheet, { onClose: close, onCode: lookupCode, onPhoto: takePhoto });
            } else if (sheet.type === 'photo') {
                sheetEl = e(PhotoResultSheet, {
                    result: sheet.result, kind: sheet.kind, query: sheet.query, matches: sheet.matches, searching: sheet.searching, onClose: close, onLabelPhoto: takePhoto,
                    onPick: (food) => setSheet({ type: 'amount', food }),
                    onUseEstimate: () => setSheet({ type: 'amount', food: sheet.food }),
                });
            } else if (sheet.type === 'missing') {
                sheetEl = e(Sheet, { title: 'NOT FOUND', onClose: close },
                    e('div', { className: 'text-center py-4' },
                        e(MIcon, { icon: sheet.offline ? 'cloud_off' : 'barcode_scanner', style: { fontSize: '44px', color: 'var(--on-surface-variant)' } }),
                        e('div', { className: 'text-lg font-black mt-3' }, sheet.offline ? "Couldn't reach Open Food Facts" : sheet.name ? 'No nutrition data for this product' : 'Product not in Open Food Facts'),
                        e('div', { className: 'text-sm mt-1', style: { color: 'var(--on-surface-variant)' } }, [sheet.brand, sheet.name].filter(Boolean).join(' ') || `Barcode ${sheet.code}`)
                    ),
                    e('div', { className: 'space-y-2 mt-4' },
                        e('button', { onClick: takePhoto, className: 'w-full py-4 rounded-2xl text-base font-black flex items-center justify-center gap-2 active:scale-95', style: primaryBtn }, e(MIcon, { icon: 'photo_camera', style: { fontSize: '20px' } }), 'Photo of the nutrition label'),
                        e('button', { onClick: () => setSheet({ type: 'editor', food: { code: sheet.code, name: sheet.name, brand: sheet.brand }, thenAdd: true }), className: 'w-full py-4 rounded-2xl text-base font-bold active:scale-95', style: ghostBtn }, 'Enter values myself'),
                        sheet.offline ? e('button', { onClick: () => lookupCode(sheet.code), className: 'w-full py-3 rounded-2xl text-base font-bold active:scale-95', style: ghostBtn }, 'Try again') : null
                    )
                );
            }
        }

        return e('div', { className: 'min-h-screen flex flex-col', style: { background: 'var(--void)', color: 'var(--on-surface)' } },
            e(TopAppBar, { title: 'FOOD', rightAction: app.profileBtn }),
            e('div', { className: 'flex-1 pt-20 px-4 pb-28 overflow-y-auto' },
                e('div', { className: 'max-w-lg mx-auto' },
                    cover
                        // Cover screen (short): day + actions in one row so Add/Scan/Photo are always on screen.
                        ? e('div', { className: 'flex items-center gap-1.5 mb-2' },
                            iconBtn('chevron_left', () => shiftDay(-1), 'Previous day', { width: 36, height: 36 }),
                            e('button', { onClick: () => app.setDate(today), className: 'flex-1 min-w-0 truncate text-base font-black active:opacity-70' }, dateLabel),
                            iconBtn('chevron_right', () => shiftDay(1), 'Next day', { width: 36, height: 36 }),
                            iconBtn('barcode_scanner', () => setSheet({ type: 'scan' }), 'Scan barcode', { width: 40, height: 40 }),
                            iconBtn('photo_camera', takePhoto, 'Photo', { width: 40, height: 40 }),
                            iconBtn('add', () => setSheet({ type: 'add' }), 'Add food', { width: 40, height: 40, background: 'var(--primary-container)', color: 'var(--on-primary-container)' })
                        )
                        : e('div', { className: 'flex items-center justify-between mb-3' },
                            iconBtn('chevron_left', () => shiftDay(-1), 'Previous day'),
                            e('button', { onClick: () => app.setDate(today), className: 'text-lg font-black active:opacity-70 px-3' }, dateLabel),
                            iconBtn('chevron_right', () => shiftDay(1), 'Next day')
                        ),
                    e(DaySummary, { totals, targets, compact: cover, onEditTargets: () => setSheet({ type: 'targets' }), onMacro: (k) => setSheet({ type: 'macro', k }) }),
                    cover ? null : e('div', { className: 'grid grid-cols-3 gap-2 mt-3' },
                        e('button', { onClick: () => setSheet({ type: 'add' }), className: 'py-3.5 rounded-2xl text-base font-black flex items-center justify-center gap-1.5 active:scale-95', style: primaryBtn }, e(MIcon, { icon: 'add', style: { fontSize: '20px' } }), 'Add'),
                        e('button', { onClick: () => setSheet({ type: 'scan' }), className: 'py-3.5 rounded-2xl text-base font-bold flex items-center justify-center gap-1.5 active:scale-95', style: ghostBtn }, e(MIcon, { icon: 'barcode_scanner', style: { fontSize: '20px' } }), 'Scan'),
                        e('button', { onClick: takePhoto, className: 'py-3.5 rounded-2xl text-base font-bold flex items-center justify-center gap-1.5 active:scale-95', style: ghostBtn }, e(MIcon, { icon: 'photo_camera', style: { fontSize: '20px' } }), 'Photo')
                    ),
                    error ? e('div', { className: 'mt-3 rounded-xl px-3 py-2 text-sm', style: { background: 'rgba(255,115,81,0.12)', color: 'var(--error)' } }, error) : null,
                    e('div', { className: 'mt-4' }, e(Timeline, {
                        entries,
                        suggest: date === today ? pendingUsual(usualFoods(app.log, today, app.foods), entries) : null,
                        onAccept: (u) => addEntry(u.food, { g: u.g, meal: u.meal, t: timeOnDay(date, u.time) }),
                        onOpenSuggestion: (u) => setSheet({ type: 'amount', food: { ...u.food, lastG: u.g }, meal: u.meal, time: u.time }),
                        onOpen: (en) => {
                        const live = (en.foodId && app.foods[en.foodId]) || {};
                        setSheet({ type: 'amount', entry: en, food: { ...en, serving: servingOf(en) || servingOf(live), recipe: live.recipe, ingredients: live.ingredients } });
                    } }))
                )
            ),
            e('input', { ref: photoInput, type: 'file', accept: 'image/*', capture: 'environment', className: 'hidden', onChange: (ev) => { const f = ev.target.files && ev.target.files[0]; ev.target.value = ''; onPhotoFile(f); } }),
            sheetEl,
            busy ? busyOverlay(busy) : null,
            app.toastText ? e('div', { className: 'fixed left-1/2 -translate-x-1/2 z-[190] px-4 py-2 rounded-xl text-sm font-bold', style: { bottom: 'max(env(safe-area-inset-bottom), 90px)', background: 'var(--primary-container)', color: 'var(--on-primary-container)', boxShadow: '0 4px 20px rgba(0,0,0,0.4)' } }, app.toastText) : null,
            app.confirmEl || null,
            e(BottomNavBar, { activeTab: 'food', onTabChange: app.onTabChange })
        );
    }

    // Breakdown of one week's rating (tap a score in Calendar or Stats).
    function WeekRatingDialog({ rating, onClose }) {
        const r = rating;
        const mon = new Date(r.mondayMs), sun = new Date(r.mondayMs); sun.setDate(sun.getDate() + 6);
        const fmt = (d) => `${d.getDate()}.${d.getMonth() + 1}.`;
        const row = (title, value, sub) => e('div', { className: 'flex items-start justify-between gap-3 py-2', style: { borderTop: '1px solid var(--surface-container-high)' } },
            e('div', null, e('div', { className: 'text-sm font-bold' }, title), sub ? e('div', { className: 'text-xs', style: { color: 'var(--on-surface-variant)' } }, sub) : null),
            e('div', { className: 'text-sm font-bold flex-shrink-0' }, value));
        return e('div', { className: 'fixed inset-0 z-[200] flex items-center justify-center px-6', onClick: onClose },
            e('div', { className: 'absolute inset-0', style: { background: 'rgba(0,0,0,0.7)' } }),
            e('div', { className: 'relative z-10 w-full max-w-xs rounded-2xl p-5', style: { background: 'var(--surface-container-highest)', color: 'var(--on-surface)' }, onClick: (ev) => ev.stopPropagation() },
                e('div', { className: 'text-xs font-bold uppercase tracking-widest', style: { color: 'var(--on-surface-variant)' } }, `Week ${fmt(mon)}–${fmt(sun)}${r.complete ? '' : ' · so far'}`),
                e('div', { className: 'flex items-baseline gap-1 mt-1 mb-2' },
                    e('span', { className: 'font-black', style: { fontSize: 44, lineHeight: 1, color: ratingColor(r.score) } }, r.score == null ? '—' : r.score.toFixed(1)),
                    e('span', { className: 'text-base', style: { color: 'var(--on-surface-variant)' } }, '/ 10')),
                row('Training', r.training ? `${Math.round(r.training.score * 100)} %` : '—',
                    r.training ? `${r.training.done} of ${r.training.planned} planned workouts` + (r.training.sessions > r.training.planned ? ` (${r.training.sessions} done)` : '') : 'No workouts planned'),
                row('Nutrition', r.nutrition ? `${Math.round(r.nutrition.score * 100)} %` : '—',
                    r.nutrition ? `${r.nutrition.logged} of ${r.nutrition.days} days logged · avg ${fmtK(r.nutrition.avgKcal)} kcal` : 'No food logged'),
                e('div', { className: 'text-[11px] leading-snug mt-2', style: { color: 'var(--outline)' } },
                    'Score = average of the parts with data. Training: workouts done vs planned. Nutrition: each day scores on calories (±10 %), protein (≥90 %) and carbs/fat (±20 %) vs your targets; unlogged days count 0.'),
                e('button', { onClick: onClose, className: 'w-full mt-4 py-3 rounded-xl text-base font-bold active:scale-95', style: ghostBtn }, 'Close')
            )
        );
    }

    window.CWANutrition = { macroSplit, usualFoods, pendingUsual, FoodScreen, dayTotals, entryTotals, targetsFor, weekRating, weekStartOf, ratingColor, WeekRatingDialog, KEYS, LABEL, BASIC_FOODS, offToFood };
})();
