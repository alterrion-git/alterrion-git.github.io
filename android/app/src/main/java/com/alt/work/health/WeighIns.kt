package com.alt.work.health

import android.content.Context
import kotlin.math.abs

/** A finished weigh-in, ready to upload. */
data class WeighIn(val kg: Double, val impedance: Int?, val at: Long, val address: String)

/**
 * Turns the stream of scale packets into weigh-ins. While you stand on the scale it repeats
 * packets: unstable → stable weight → stable weight + impedance (barefoot, a few seconds later)
 * → stepped off. A weigh-in is complete at the first stable packet with impedance, or at
 * step-off when there's no impedance (socks); each one is reported once.
 *
 * Used by both the in-app "Weigh in" screen and the background listener, so state lives in [Store].
 */
object WeighIns {
    const val MIN_KG = 20.0
    const val MAX_KG = 250.0
    private const val PENDING_TIMEOUT_MS = 120_000L

    sealed class Result {
        data class Done(val weighIn: WeighIn) : Result()
        data class Measuring(val kg: Double, val stable: Boolean) : Result()
        data class Skipped(val reason: String) : Result()
        object Ignore : Result()
    }

    fun onPacket(context: Context, r: ScaleReading): Result {
        val s = Store(context)
        if (r.kg < MIN_KG || r.kg > MAX_KG) return Result.Ignore
        val key = r.key
        if (key == s.doneKey) return Result.Ignore

        // Someone else on the scale? (±15 % of your last weight, when we know it)
        val last = s.lastWeight.toDouble()
        if (s.onlyMyWeight && last > 0 && abs(r.kg - last) / last > 0.15) {
            return if (r.stable) Result.Skipped("%.1f kg isn't within 15%% of your %.1f kg — not saved.".format(r.kg, last)) else Result.Ignore
        }

        if (r.stable && !r.removed && r.impedance != null) return finish(s, WeighIn(r.kg, r.impedance, r.measuredAt ?: System.currentTimeMillis(), r.address), key)

        if (r.stable && !r.removed) {
            s.pendingKey = key; s.pendingKg = r.kg.toFloat(); s.pendingAt = System.currentTimeMillis(); s.pendingMeasuredAt = r.measuredAt ?: System.currentTimeMillis()
            return Result.Measuring(r.kg, true)
        }
        if (r.removed && s.pendingKey == key && s.pendingKg > 0) return flushPending(s, r.address)
        return Result.Measuring(r.kg, false)
    }

    /** A stable weight without impedance that's waited long enough (or the app's screen closed). */
    fun flushPending(context: Context, address: String, force: Boolean): Result {
        val s = Store(context)
        if (s.pendingKey == null || s.pendingKg <= 0) return Result.Ignore
        if (!force && System.currentTimeMillis() - s.pendingAt < PENDING_TIMEOUT_MS) return Result.Ignore
        return flushPending(s, address)
    }

    private fun flushPending(s: Store, address: String): Result {
        val key = s.pendingKey ?: return Result.Ignore
        val w = WeighIn(s.pendingKg.toDouble(), null, s.pendingMeasuredAt, address)
        return finish(s, w, key)
    }

    private fun finish(s: Store, w: WeighIn, key: String): Result {
        s.doneKey = key
        s.pendingKey = null; s.pendingKg = 0f
        s.lastWeight = w.kg.toFloat()
        if (s.scaleAddress == null) s.scaleAddress = w.address
        return Result.Done(w)
    }
}
