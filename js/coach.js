// ============================================================================
// CWA coach — what the AI coach is told
// ============================================================================
// Builds the coach's system prompt and a compact, pre-analysed picture of the user:
// lift progression (estimated 1RM trend, stalls, drops), weekly sets per muscle (planned and
// done), adherence, the last session vs the one before, nutrition vs targets (today, 7-day
// patterns, protein per meal, biggest food sources), body weight trend, week ratings, a few
// months of history in summary form, and the coach's memory of earlier chats.
//
// Facts are computed here, not left to the model: it gets numbers and flags to coach from,
// in a few thousand characters. The question's topic (food / training) decides which side
// gets the detailed version; a general question gets both.
//
// Memory: the model may end a reply with "MEMORY: <fact>" lines; extractMemories() strips
// them from the reply, mergeMemories() adds them to the user's list (newest kept, no repeats).
//
// Loaded before the main script; pure functions, exposed as window.CWACoach.
(function () {
    'use strict';
    const DAY = 86400000;
    const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
    const pad = (n) => String(n).padStart(2, '0');
    const dk = (ts) => { const d = new Date(ts); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
    const md = (ts) => { const d = new Date(ts); return `${d.getDate()}.${d.getMonth() + 1}.`; };
    const r0 = (x) => Math.round(x || 0);
    const r1 = (x) => String(Math.round((x || 0) * 10) / 10);
    const kg = (x) => String(Math.round((x || 0) * 100) / 100); // 81.25 stays 81.25
    const pct = (a, b) => (b > 0 ? Math.round(a / b * 100) : 0);
    const fold = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
    const avg = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);
    const mondayOf = (ts) => { const d = new Date(ts); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return d.getTime(); };
    const weekdayName = (ts) => DAYS[(new Date(ts).getDay() + 6) % 7];

    // ---------- the system prompt ----------
    const SYSTEM = [
        "You are Coach: the user's personal strength and nutrition coach inside their training app. Below is their real data, already analysed (lift progression with stalls, weekly sets per muscle, adherence, nutrition against targets, memory of earlier chats). Coach them; don't report back what they can already see.",
        '',
        'How to answer:',
        '- Start with a one-line verdict. Then the 2–4 points that matter most, each with the numbers behind it and a concrete action (exact weights/reps/sets, foods with grams, timing).',
        "- Never just list what they ate or did. Judge it: what was good, what was off or missing, what to change next time and why.",
        '- Eating: compare with the targets and with what is left of today; protein spread across meals; fibre, sugar, salt; recurring patterns from the last 7–14 days. Suggest specific meals or swaps using foods they already eat (their "biggest sources" and today\'s items), with amounts that close the gap.',
        "- Training: judge progression (e1RM trend), stalls and drops, adherence, weekly sets per muscle (≈10–20 hard sets/week per major muscle; under 8 is low), exercise selection and balance (push vs pull, quads vs hamstrings/glutes, muscles with no direct work), and give targets for the next session. Progression rule of thumb: when all sets reach the top of the rep range, add 2.5 kg (upper body) or 5 kg (lower body); after 3+ stalled sessions, deload ~10% or change the variation or rep range.",
        "- Use their goal, notes and the coach memory; respect injuries and limitations. If data is missing or a day looks only partly logged, say so in a few words instead of guessing.",
        '- Be direct and specific, like a good coach who knows them. No generic advice, no filler, no disclaimers (except: pain or injury → suggest a professional).',
        "- Reply in the user's language. Markdown: short paragraphs, **bold** key numbers, bullet lists, a small table only for comparisons. Stay under ~250 words unless they ask for a plan.",
        '',
        "Memory: when the user tells you something lasting (goal, preference, dislike, injury, schedule, equipment, diet) or agrees to a plan or change, end your reply with 1–3 lines like `MEMORY: Trains at 6 am before work` (one short fact per line, about the user). Don't repeat facts already in the coach memory. Most replies need no MEMORY line.",
    ].join('\n');

    // ---------- question topic ----------
    const FOOD_RE = /\b(eat|ate|eating|food|meal|kcal|calor|protein|carb|fat\b|fats|fib(re|er)|sugar|salt|diet|breakfast|lunch|dinner|snack|hungry|macro|recipe|cook|drink|alcohol|beer|cut(ting)?\b|bulk)|jidl|jedl|jim\b|jist|snist|snedl|snim\b|snid|snez|kalor|bilkovin|sachar|tuk|cukr|obed|vecer|snidan|svac|dieta|hlad|piti|pivo/;
    const TRAIN_RE = /\b(workout|train|exercise|lift|sets?\b|reps?\b|bench|squat|deadlift|press|row|pull|push|legs?\b|program|routine|split|volume|progress|pr\b|strength|stronger|muscle|cardio|gym|deload|weight to use|plateau|stall)|trenin|cvic|cvik|posil|seri|opakov|drep|bench|zada|nohy|prsa|ruce|ramen|silov|svaly|svalu/;
    // Topic of the question ({ food, training }): the newest user message that names one, so a
    // follow-up like "and tomorrow?" keeps the earlier topic; nothing recognisable → both.
    function focusFrom(texts) {
        const list = (texts || []).slice().reverse();
        for (const raw of list) {
            const t = fold(raw);
            const food = FOOD_RE.test(t), training = TRAIN_RE.test(t);
            if (food || training) return { food, training };
        }
        return { food: true, training: true };
    }

    // ---------- training analysis ----------
    // Muscle group from an exercise name (English and Czech keywords, accents ignored); first match wins.
    const MUSCLES = [
        ['calves', /calf|calves|lytk/],
        ['core', /plank|crunch|\babs?\b|ab wheel|sit-?up|leg raise|knee raise|pallof|\bcore\b|russian twist|dead ?bug|hollow|bric/],
        ['hams/glutes', /romanian|\brdl\b|stiff|good ?morning|leg curl|hamstring|nordic|hip thrust|glute|bridge|hyperext|back ext|swing|rumun|zakopav/],
        ['quads', /squat|leg press|lunge|step-?up|leg ext|hack|sissy|drep|vypad|predkop|wall sit/],
        ['triceps', /tricep|pushdown|push-?down|skull|french|close-?grip|kickback|overhead ext|\bdips?\b|trojhl/],
        ['shoulders', /overhead|\bohp\b|military|shoulder|arnold|lateral|side raise|front raise|upright|rear delt|face ?pull|reverse fl|delt|ramen|upaz|predpaz/],
        ['back', /deadlift|row|pull-?up|chin-?up|pulldown|pull-?down|\blat\b|\blats\b|pullover|shrug|rack pull|shyb|pritah|stahov|zada|mrtvy tah/],
        ['biceps', /curl|bicep|dvojhl|bicak/],
        ['chest', /bench|chest|\bpec|fly\b|flye|flies|push-?up|crossover|incline|decline|benc|lavic|klik|rozpaz|prsa|\bpress\b|tlak/],
    ];
    function muscleOf(name) {
        const n = fold(name);
        for (const [m, re] of MUSCLES) if (re.test(n)) return m;
        return 'other';
    }
    const MAJOR = ['chest', 'back', 'shoulders', 'quads', 'hams/glutes'];
    const ALL_GROUPS = ['chest', 'back', 'shoulders', 'quads', 'hams/glutes', 'biceps', 'triceps', 'calves', 'core'];
    const PUSH = ['chest', 'shoulders', 'triceps'], PULL = ['back', 'biceps'];

    // Estimated 1RM (Epley; reps capped at 12 where it stops being meaningful). 0 kg = bodyweight.
    const e1rm = (s) => (s.weight > 0 && s.reps > 0 ? s.weight * (1 + Math.min(s.reps, 12) / 30) : 0);
    const validSets = (ex) => (ex.sets || []).filter(s => s && s.reps > 0);
    const topSet = (sets) => sets.reduce((b, s) => (!b || s.weight > b.weight || (s.weight === b.weight && s.reps > b.reps) ? s : b), null);
    const setStr = (s) => (s.weight > 0 ? `${kg(s.weight)}×${s.reps}` : `${s.reps} reps`);
    // "4×8@60" when all sets match, else "8@60, 8@60, 6@65".
    function schemeStr(sets) {
        if (!sets.length) return '';
        const same = sets.every(s => s.reps === sets[0].reps && s.weight === sets[0].weight);
        const one = (s) => (s.weight > 0 ? `${s.reps}@${kg(s.weight)}` : `${s.reps}`);
        return same ? `${sets.length}×${one(sets[0])}` : sets.map(one).join(', ');
    }

    // Per exercise: its sessions (oldest first) with the best e1RM and top set.
    function exerciseSessions(history) {
        const by = {};
        (history || []).slice().sort((a, b) => a.date - b.date).forEach(w => (w.exercises || []).forEach(ex => {
            const sets = validSets(ex);
            if (!sets.length) return;
            const best = Math.max(...sets.map(e1rm));
            const reps = Math.max(...sets.map(s => s.reps));
            (by[ex.name] = by[ex.name] || []).push({ date: w.date, best, reps, top: topSet(sets), sets });
        }));
        return by;
    }
    // Trend of one exercise over the window: change %, stall length, drop.
    function trendOf(sessions) {
        const bw = sessions.every(s => s.best === 0); // bodyweight: use reps
        const val = (s) => (bw ? s.reps : s.best);
        const first = Math.max(...sessions.slice(0, 2).map(val));
        const last = Math.max(...sessions.slice(-2).map(val));
        const change = first > 0 ? (last - first) / first : 0;
        // Sessions since the last new best.
        let bestSoFar = -1, sinceBest = 0;
        sessions.forEach(s => { if (val(s) > bestSoFar * 1.005) { bestSoFar = val(s); sinceBest = 0; } else sinceBest++; });
        const lastVal = val(sessions[sessions.length - 1]);
        const peak = Math.max(...sessions.map(val));
        const flag = sessions.length >= 4 && lastVal < peak * 0.95 ? 'DOWN' : sinceBest >= 3 ? `STALLED ${sinceBest} sessions` : change >= 0.02 ? 'improving' : 'flat';
        return { bw, first, last, change, sinceBest, flag };
    }

    function trainingLines({ now, workouts, history, detailed }) {
        const out = [];
        const plan = DAYS.filter(d => workouts && workouts[d] && (workouts[d].exercises || []).length);
        const hist = (history || []).filter(h => h && h.date).sort((a, b) => a.date - b.date);
        out.push(`Plan: ${plan.length ? plan.map(d => `${d.slice(0, 3)} ${workouts[d].name}`).join(', ') : 'no weekly plan set'} (${plan.length}/week).`);
        if (!hist.length) { out.push('No workouts logged yet.'); return out; }

        // Adherence: sessions per week vs planned, last 8 full weeks + this week.
        const thisMon = mondayOf(now);
        const weeks = [];
        for (let k = 8; k >= 1; k--) {
            const a = thisMon - k * 7 * DAY, b = a + 7 * DAY;
            weeks.push(hist.filter(h => h.date >= a && h.date < b).length);
        }
        const firstWeek = mondayOf(hist[0].date);
        const shown = weeks.map((n, i) => ({ n, mon: thisMon - (8 - i) * 7 * DAY })).filter(w => w.mon >= firstWeek);
        const thisWeek = hist.filter(h => h.date >= thisMon);
        const todayIdx = (new Date(now).getDay() + 6) % 7;
        const plannedSoFar = plan.filter(d => DAYS.indexOf(d) <= todayIdx);
        const doneDays = new Set(thisWeek.map(h => h.day));
        const missed = plannedSoFar.filter(d => DAYS.indexOf(d) < todayIdx && !doneDays.has(d));
        if (shown.length) out.push(`Adherence (sessions per week, oldest→newest${plan.length ? `, planned ${plan.length}` : ''}): ${shown.map(w => w.n).join(', ')}. This week: ${thisWeek.length} done${plan.length ? ` of ${plan.length}` : ''}${missed.length ? `; missed so far: ${missed.join(', ')}` : ''}.`);
        const recentDur = hist.slice(-6).map(h => h.totalTime || 0).filter(Boolean);
        if (recentDur.length) out.push(`Typical session: ${r0(avg(recentDur) / 60)} min.`);

        // Last session vs the previous one of the same workout.
        const last = hist[hist.length - 1];
        const prev = hist.slice(0, -1).reverse().find(h => h.day === last.day || h.name === last.name);
        const exLine = (w) => (w.exercises || []).map(ex => { const s = validSets(ex); return s.length ? `${ex.name} ${schemeStr(s)}` : null; }).filter(Boolean).join('; ');
        out.push(`Last session: ${dk(last.date)} (${weekdayName(last.date).slice(0, 3)}) ${last.name}${last.totalTime ? `, ${r0(last.totalTime / 60)} min` : ''}${detailed ? `: ${exLine(last)}` : ''}.`);
        if (prev && detailed) {
            const changes = (last.exercises || []).map(ex => {
                const pe = (prev.exercises || []).find(x => x.name === ex.name);
                const a = topSet(validSets(ex)), b = pe && topSet(validSets(pe));
                if (!a || !b) return null;
                if (a.weight === b.weight && a.reps === b.reps) return `${ex.name} same`;
                return `${ex.name} ${setStr(b)}→${setStr(a)}`;
            }).filter(Boolean);
            if (changes.length) out.push(`  vs previous ${prev.name} (${dk(prev.date)}), top sets: ${changes.join('; ')}.`);
        }

        // Progression over the last 8 weeks.
        const by = exerciseSessions(hist);
        const since = now - 56 * DAY;
        const planned = new Set(plan.flatMap(d => workouts[d].exercises.map(ex => ex.name)));
        const rows = Object.keys(by).map(name => {
            const ss = by[name].filter(s => s.date >= since);
            if (ss.length < 2) return null;
            return { name, ss, t: trendOf(ss), planned: planned.has(name) };
        }).filter(Boolean);
        const fmtRow = (r) => {
            const tops = r.ss.slice(-3).map(s => setStr(s.top)).join(', ');
            const what = r.t.bw ? `best reps ${r0(r.t.first)}→${r0(r.t.last)}` : `e1RM ${r1(r.t.first)}→${r1(r.t.last)} kg (${r.t.change >= 0 ? '+' : ''}${Math.round(r.t.change * 100)}%)`;
            return `  ${r.name}: ${what} over ${r.ss.length} sessions; last top sets ${tops} — ${r.t.flag}`;
        };
        if (rows.length) {
            const flagged = rows.filter(r => r.t.flag !== 'improving' && r.t.flag !== 'flat');
            const list = detailed ? rows.sort((a, b) => (b.planned - a.planned) || (b.ss.length - a.ss.length)).slice(0, 24)
                : flagged.concat(rows.filter(r => r.t.flag === 'improving').sort((a, b) => b.t.change - a.t.change).slice(0, 3)).slice(0, 8);
            if (list.length) {
                out.push(`Lift progression, last 8 weeks (e1RM = estimated 1-rep max from the best set)${detailed ? '' : ', only notable ones'}:`);
                list.forEach(r => out.push(fmtRow(r)));
            }
        }

        // Weekly sets per muscle: planned program vs done (avg of the last 4 weeks).
        const plannedSets = {}, doneSets = {};
        ALL_GROUPS.forEach(g => { plannedSets[g] = 0; doneSets[g] = 0; });
        plan.forEach(d => workouts[d].exercises.forEach(ex => { const g = muscleOf(ex.name); if (g in plannedSets) plannedSets[g] += (ex.sets || []).length; }));
        const recent4 = hist.filter(h => h.date >= now - 28 * DAY);
        const weeks4 = Math.max(1, Math.min(4, (now - Math.max(hist[0].date, now - 28 * DAY)) / (7 * DAY)));
        recent4.forEach(h => (h.exercises || []).forEach(ex => { const g = muscleOf(ex.name); if (g in doneSets) doneSets[g] += validSets(ex).length; }));
        const flag = (g, v) => (v === 0 ? ' (none)' : MAJOR.includes(g) && v < 8 ? ' (low)' : v > 25 ? ' (high)' : '');
        out.push(`Weekly sets per muscle — planned / done (avg last ${Math.round(weeks4)} wk): ` + ALL_GROUPS.map(g => {
            const p = plannedSets[g], dn = Math.round(doneSets[g] / weeks4 * 10) / 10;
            return `${g} ${p}/${dn}${flag(g, plan.length ? p : dn)}`;
        }).join(', ') + '.');
        const push = PUSH.reduce((a, g) => a + plannedSets[g], 0), pull = PULL.reduce((a, g) => a + plannedSets[g], 0);
        if (push + pull > 0) out.push(`Planned push:pull sets ${push}:${pull}; quads:hams/glutes ${plannedSets.quads}:${plannedSets['hams/glutes']}.`);
        const others = plan.flatMap(d => workouts[d].exercises.map(ex => ex.name)).filter(n => muscleOf(n) === 'other');
        if (others.length) out.push(`Unclassified exercises (not counted above): ${[...new Set(others)].join(', ')}.`);

        // Program in full (training questions only).
        if (detailed && plan.length) {
            out.push('Current program (sets×reps@kg):');
            plan.forEach(d => out.push(`  ${d.slice(0, 3)} ${workouts[d].name}: ${workouts[d].exercises.map(ex => `${ex.name} ${schemeStr(ex.sets || [])}${ex.notes ? ` [${String(ex.notes).slice(0, 60)}]` : ''}`).join('; ')}`));
        }

        // Longer history, condensed.
        const months = {};
        hist.forEach(h => { const m = dk(h.date).slice(0, 7); months[m] = (months[m] || 0) + 1; });
        const mk = Object.keys(months).sort().slice(-6);
        if (mk.length > 1) out.push(`Sessions per month: ${mk.map(m => `${m} ${months[m]}`).join(', ')} (${hist.length} all-time since ${dk(hist[0].date)}).`);
        const bests = Object.keys(by).filter(n => by[n].length >= 3 && by[n].some(s => s.best > 0))
            .sort((a, b) => by[b].length - by[a].length).slice(0, detailed ? 10 : 6).map(n => {
                const ss = by[n], best = ss.reduce((b, s) => (s.best > b.best ? s : b));
                return `${n} ${r1(best.best)} (${dk(best.date)}; now ${r1(ss[ss.length - 1].best)})`;
            });
        if (bests.length) out.push(`All-time best e1RM (kg): ${bests.join('; ')}.`);
        return out;
    }

    // ---------- nutrition analysis ----------
    function nutritionLines({ now, N, profile, metrics, foodLog, detailed }) {
        const out = [];
        if (!N) return out;
        const tg = N.targetsFor(profile, metrics);
        const log = foodLog || {};
        out.push(`Targets/day: ${tg.kcal} kcal, protein ${tg.p} g, carbs ${tg.c} g, fat ${tg.f} g, fibre ≥${tg.fib} g, sugar ≤${tg.sug} g, salt ≤${tg.salt} g.`);
        const todayKey = dk(now);
        const amountOf = (en) => {
            if (en.src === 'quick') return 'quick add';
            const sv = en.serving && en.serving.g > 0 ? en.serving : null;
            const c = sv ? en.g / sv.g : 0;
            const pcs = sv && Math.abs(c * 2 - Math.round(c * 2)) < 0.04 ? Math.round(c * 2) / 2 : 0;
            return (pcs ? `${pcs}× ${String(sv.label || 'serving').replace(/^1\s+/, '')} = ` : '') + `${r0(en.g)} ${en.unit || 'g'}`;
        };
        const itemStr = (en) => { const t = N.entryTotals(en); return `${en.name} ${amountOf(en)} ${r0(t.kcal)} kcal P${r0(t.p)}`; };
        const MEALS = ['breakfast', 'lunch', 'snack', 'dinner'];
        const mealLines = (list) => {
            const meals = MEALS.concat([...new Set(list.map(en => en.meal))].filter(m => !MEALS.includes(m)));
            return meals.map(m => {
                const items = list.filter(en => en.meal === m).sort((a, b) => a.t - b.t);
                if (!items.length) return null;
                const t = N.dayTotals(items);
                return `  ${m} (${r0(t.kcal)} kcal, P${r0(t.p)}): ${items.map(itemStr).join('; ')}`;
            }).filter(Boolean);
        };
        // Today.
        const today = log[todayKey] || [];
        const time = new Date(now);
        if (today.length) {
            const t = N.dayTotals(today);
            const left = tg.kcal - t.kcal;
            out.push(`Today so far (${pad(time.getHours())}:${pad(time.getMinutes())}): ${r0(t.kcal)} kcal (${pct(t.kcal, tg.kcal)}%), protein ${r0(t.p)} g (${pct(t.p, tg.p)}%), carbs ${r0(t.c)} g, fat ${r0(t.f)} g, fibre ${r0(t.fib)} g, sugar ${r0(t.sug)} g, salt ${kg(t.salt)} g → ${left >= 0 ? `${r0(left)} kcal` : `${r0(-left)} kcal OVER`} and ${r0(Math.max(0, tg.p - t.p))} g protein left.`);
            mealLines(today).forEach(l => out.push(l));
        } else {
            out.push(`Today: nothing logged yet (it is ${pad(time.getHours())}:${pad(time.getMinutes())}).`);
        }
        // Yesterday's items (food questions).
        const yKey = dk(now - DAY);
        if (detailed && (log[yKey] || []).length) {
            const t = N.dayTotals(log[yKey]);
            out.push(`Yesterday: ${r0(t.kcal)} kcal, protein ${r0(t.p)} g, carbs ${r0(t.c)} g, fat ${r0(t.f)} g, fibre ${r0(t.fib)} g, sugar ${r0(t.sug)} g, salt ${kg(t.salt)} g.`);
            mealLines(log[yKey]).forEach(l => out.push(l));
        }
        // The last 7 days before today.
        const last7 = [...Array(7)].map((_, i) => dk(now - (i + 1) * DAY)).filter(d => (log[d] || []).length);
        if (last7.length) {
            const tots = last7.map(d => N.dayTotals(log[d]));
            const A = (k) => avg(tots.map(t => t[k]));
            const flagHi = (v, lim) => (v > lim ? ' (over)' : ''), flagLo = (v, lim) => (v < lim * 0.8 ? ' (low)' : '');
            const kcalOk = tots.filter(t => Math.abs(t.kcal - tg.kcal) <= tg.kcal * 0.1).length;
            const protOk = tots.filter(t => t.p >= tg.p * 0.9).length;
            out.push(`Last 7 days: ${last7.length}/7 logged${last7.length < 7 ? ' (unlogged days not counted)' : ''}. Avg ${r0(A('kcal'))} kcal (${pct(A('kcal'), tg.kcal)}%), protein ${r0(A('p'))} g (${pct(A('p'), tg.p)}%)${flagLo(A('p'), tg.p)}, carbs ${r0(A('c'))} g, fat ${r0(A('f'))} g, fibre ${r0(A('fib'))} g${flagLo(A('fib'), tg.fib)}, sugar ${r0(A('sug'))} g${flagHi(A('sug'), tg.sug)}, salt ${kg(A('salt'))} g${flagHi(A('salt'), tg.salt)}. Calories within ±10% on ${kcalOk}/${last7.length} days; protein ≥90% on ${protOk}/${last7.length}.`);
            // Low-logged days (likely incomplete).
            const partial = last7.filter((d, i) => tots[i].kcal < tg.kcal * 0.5);
            if (partial.length) out.push(`  Possibly incomplete days (<50% of target): ${partial.join(', ')}.`);
            if (detailed) {
                const perMeal = MEALS.map(m => `${m} ${r0(avg(last7.map(d => N.dayTotals((log[d] || []).filter(en => en.meal === m)).p)))}`);
                out.push(`  Protein per meal (avg g): ${perMeal.join(', ')}.`);
                const late = last7.map(d => (log[d] || []).filter(en => new Date(en.t).getHours() >= 21)).filter(l => l.length);
                if (late.length) out.push(`  Eating after 21:00 on ${late.length}/${last7.length} days (avg ${r0(avg(late.map(l => N.dayTotals(l).kcal)))} kcal).`);
            }
        }
        // Biggest sources over 14 days (food questions).
        if (detailed) {
            const days14 = [...Array(14)].map((_, i) => dk(now - i * DAY)).filter(d => (log[d] || []).length);
            const agg = {};
            let totK = 0, totP = 0;
            days14.forEach(d => (log[d] || []).forEach(en => {
                if (en.src === 'quick') return;
                const t = N.entryTotals(en), k = fold(en.name);
                const a = agg[k] || (agg[k] = { name: en.name, kcal: 0, p: 0, n: 0 });
                a.kcal += t.kcal; a.p += t.p; a.n++; totK += t.kcal; totP += t.p;
            }));
            const list = Object.values(agg);
            if (list.length >= 3) {
                out.push(`Biggest calorie sources (14 days): ${list.sort((a, b) => b.kcal - a.kcal).slice(0, 6).map(a => `${a.name} ${pct(a.kcal, totK)}% (${a.n}×)`).join(', ')}.`);
                out.push(`Biggest protein sources (14 days): ${list.sort((a, b) => b.p - a.p).slice(0, 5).map(a => `${a.name} ${pct(a.p, totP)}%`).join(', ')}.`);
            }
            // Weekly averages, up to 8 weeks back (logged days only).
            const thisMon = mondayOf(now), wk = [];
            for (let k = 8; k >= 1; k--) {
                const days = [...Array(7)].map((_, i) => dk(thisMon - k * 7 * DAY + i * DAY + 12 * 3600000)).filter(d => (log[d] || []).length);
                if (!days.length) continue;
                const tt = days.map(d => N.dayTotals(log[d]));
                wk.push(`${md(thisMon - k * 7 * DAY)} ${r0(avg(tt.map(t => t.kcal)))} kcal/P${r0(avg(tt.map(t => t.p)))} (${days.length}d)`);
            }
            if (wk.length > 1) out.push(`Weekly averages (week of; kcal/protein; days logged): ${wk.join(', ')}.`);
        }
        return out;
    }

    // ---------- body ----------
    function bodyLines({ now, metrics, profile, health, H }) {
        const out = [];
        // From the phone (Health Connect via the CWA Health app): activity, sleep, heart.
        if (health && H && H.summary) {
            const s = H.summary(health, now), t = s.today || {}, hm = H.hm;
            const parts = [];
            if (t.steps || s.steps7) parts.push(`steps today ${r0(t.steps)}${s.steps7 ? ` (7-day avg ${r0(s.steps7)}${s.steps28 ? `, 4-week ${r0(s.steps28)}` : ''})` : ''}`);
            if (t.activeKcal || s.activeKcal7) parts.push(`active kcal burned today ${r0(t.activeKcal)}${s.activeKcal7 ? ` (7-day avg ${r0(s.activeKcal7)})` : ''}`);
            if (s.totalKcal7) parts.push(`total burn 7-day avg ${r0(s.totalKcal7)} kcal`);
            if (parts.length) out.push(`Activity (phone/wearable): ${parts.join('; ')}.`);
            const ln = s.lastNight;
            if (ln || s.sleep7) out.push(`Sleep: ${ln ? `last night ${hm(ln.min)}${ln.deep || ln.rem ? ` (deep ${hm(ln.deep)}, REM ${hm(ln.rem)}, awake ${hm(ln.awake)})` : ''}` : 'last night not recorded'}${s.sleep7 ? `; 7-day avg ${hm(s.sleep7)}` : ''}${s.sleep28 ? `, 4-week ${hm(s.sleep28)}` : ''}.`);
            const hr = [];
            if (t.rhr || s.rhr7) hr.push(`resting HR ${t.rhr ? r0(t.rhr) + ' today' : ''}${s.rhr7 ? ` (7-day ${r0(s.rhr7)}${s.rhr28 ? `, 4-week ${r0(s.rhr28)}` : ''})` : ''}`);
            if (s.hrv7) hr.push(`HRV 7-day avg ${r0(s.hrv7)} ms`);
            if (s.spo27) hr.push(`SpO2 ${kg(s.spo27)} %`);
            if (hr.length) out.push(`Heart: ${hr.join('; ')}.`);
            if (s.workouts.length) out.push(`Activities recorded by other apps (7 days): ${s.workouts.slice(0, 8).map(w => `${w.day.slice(5)} ${w.title || w.type} ${r0(w.min)} min`).join('; ')}.`);
        }
        const ms = (metrics || []).filter(m => m && m.date).sort((a, b) => a.date - b.date);
        const w = ms.filter(m => m.weight != null);
        if (w.length) {
            const last = w[w.length - 1];
            const at = (days) => { const t = now - days * DAY; const c = w.filter(m => m.date <= t); return c.length ? c[c.length - 1] : null; };
            const w4 = at(28), w12 = at(84);
            const parts = [`latest ${kg(last.weight)} kg (${dk(last.date)})`];
            if (w4) parts.push(`${last.weight - w4.weight >= 0 ? '+' : ''}${kg(last.weight - w4.weight)} kg vs 4 weeks ago`);
            if (w12) parts.push(`${last.weight - w12.weight >= 0 ? '+' : ''}${kg(last.weight - w12.weight)} kg vs 12 weeks ago`);
            if (profile && profile.targetWeight) parts.push(`target ${kg(profile.targetWeight)} kg`);
            out.push(`Body weight: ${parts.join(', ')}.`);
            const bc = w.slice().reverse().find(m => m.bodyFat != null);
            if (bc) out.push(`  Body composition (scale estimate, ${dk(bc.date)}): body fat ${kg(bc.bodyFat)} %${bc.muscleKg != null ? `, muscle ${kg(bc.muscleKg)} kg` : ''}${bc.waterPct != null ? `, water ${kg(bc.waterPct)} %` : ''}.`);
            const months = {};
            w.forEach(m => { const k = dk(m.date).slice(0, 7); (months[k] = months[k] || []).push(m.weight); });
            const mk = Object.keys(months).sort().slice(-6);
            if (mk.length > 1) out.push(`  Monthly average weight: ${mk.map(k => `${k} ${kg(avg(months[k]))}`).join(', ')}.`);
        }
        const recent = ms.filter(m => m.date >= now - 14 * DAY);
        const sl = recent.filter(m => m.sleep).map(m => m.sleep), st = recent.filter(m => m.steps).map(m => m.steps);
        if (sl.length || st.length) out.push(`Last 14 days: ${[sl.length ? `sleep avg ${kg(avg(sl))} h` : '', st.length ? `steps avg ${r0(avg(st))}` : ''].filter(Boolean).join(', ')}.`);
        return out;
    }

    // ---------- the whole context ----------
    // data = { now, profile, workouts, history, metrics, foodLog, memory, N (CWANutrition), focus }
    function buildContext(data) {
        const now = data.now || Date.now();
        const p = data.profile || {};
        const focus = data.focus || { food: true, training: true };
        const L = [];
        const t = new Date(now);
        const todayName = weekdayName(now);
        const todayPlan = data.workouts && data.workouts[todayName];
        const doneToday = (data.history || []).find(h => dk(h.date) === dk(now));
        L.push(`Now: ${todayName} ${dk(now)} ${pad(t.getHours())}:${pad(t.getMinutes())} (user's local time). Today's planned workout: ${todayPlan ? todayPlan.name : 'rest day'}${doneToday ? ` — done (${doneToday.name})` : todayPlan ? ' — not done yet' : ''}.`);
        const prof = [p.heightCm ? `height ${p.heightCm} cm` : '', p.targetWeight ? `target weight ${p.targetWeight} kg` : '', p.targetBodyFat ? `target ${p.targetBodyFat}% body fat` : '', p.split ? `split ${p.split}` : ''].filter(Boolean);
        if (prof.length) L.push(`Profile: ${prof.join(', ')}.`);
        if (p.notes && String(p.notes).trim()) L.push(`Their goal & notes (in their words): ${String(p.notes).trim()}`);
        const mem = (data.memory || []).filter(m => m && m.text).slice(-30);
        if (mem.length) { L.push('Coach memory (from earlier chats, oldest first):'); mem.forEach(m => L.push(`- ${m.text}`)); }

        const sections = [
            ['NUTRITION', nutritionLines({ now, N: data.N, profile: p, metrics: data.metrics, foodLog: data.foodLog, detailed: focus.food })],
            ['TRAINING', trainingLines({ now, workouts: data.workouts || {}, history: data.history || [], detailed: focus.training })],
            ['BODY & RECOVERY', bodyLines({ now, metrics: data.metrics, profile: p, health: data.health, H: data.H })],
        ];
        // The topic asked about goes first.
        if (focus.training && !focus.food) sections.unshift(sections.splice(1, 1)[0]);
        sections.forEach(([title, lines]) => { if (lines.length) { L.push('', `## ${title}`); lines.forEach(l => L.push(l)); } });

        // Week ratings (deterministic 0–10): last 3 full weeks.
        if (data.N && data.N.weekRating) {
            const tg = data.N.targetsFor(p, data.metrics);
            const planDays = DAYS.filter(d => data.workouts && data.workouts[d]);
            const wr = [3, 2, 1, 0].map(k => data.N.weekRating({ mondayMs: mondayOf(now - k * 7 * DAY), history: data.history || [], planDays, log: data.foodLog || {}, targets: tg, now }))
                .filter(r => r.score != null)
                .map(r => `week of ${md(r.mondayMs)}${r.complete ? '' : ' (so far)'}: ${r.score.toFixed(1)}`);
            if (wr.length) L.push('', `Week ratings /10 (training adherence + nutrition vs targets): ${wr.join('; ')}.`);
        }
        return L.join('\n');
    }

    // ---------- memory ----------
    const MEMORY_LINE = /^[ \t>*_`-]*MEMORY[*_`]*\s*:[*_`]*\s*(.+?)[*_`\s]*$/gim;
    // → { text: reply without MEMORY lines, memories: ['fact', ...] }
    function extractMemories(reply) {
        const memories = [];
        const text = String(reply || '').replace(MEMORY_LINE, (_, fact) => { const f = fact.trim(); if (f) memories.push(f.slice(0, 200)); return ''; })
            .replace(/\n{3,}/g, '\n\n').trim();
        return { text, memories: memories.slice(0, 3) };
    }
    const MEMORY_MAX = 40;
    // Adds new facts to the list ([{ id, text, ts }], oldest first); skips repeats; keeps the newest MEMORY_MAX.
    function mergeMemories(list, facts, now) {
        const out = (list || []).slice();
        const norm = (s) => fold(s).replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
        (facts || []).forEach(f => {
            const n = norm(f);
            if (!n || out.some(m => { const o = norm(m.text); return o === n || o.includes(n) || n.includes(o); })) return;
            out.push({ id: 'm' + (now || Date.now()).toString(36) + Math.random().toString(36).slice(2, 5), text: String(f).trim(), ts: now || Date.now() });
        });
        return out.slice(-MEMORY_MAX);
    }

    window.CWACoach = { SYSTEM, buildContext, focusFrom, extractMemories, mergeMemories, muscleOf, MEMORY_MAX };
})();
