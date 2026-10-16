package com.alt.work.health

import android.content.Context
import kotlin.math.abs

/** A finished weigh-in, ready to upload. [at] is the phone's time of the weigh-in. */
data class WeighIn(val kg: Double, val impedance: Int?, val at: Long, val address: String)

/** What the weigh-in logic remembers between packets and app launches (kept in [Store]). */
interface ScaleState {
    val onlyMyWeight: Boolean
    var lastWeight: Float
    var scaleAddress: String?

    // A stable weight seen, waiting for its impedance or step-off packet.
    var pendingKey: String?
    var pendingKg: Float
    /** Phone time of the first stable packet: the weigh-in's time. */
    var pendingAt: Long
    /** Phone time of the latest stable packet: the wait runs from here. */
    var pendingLastAt: Long
    var pendingAddr: String?

    // The latest saved weigh-ins, so the scale's repeats of a result aren't saved again.
    /** Keys of the last few saved weigh-ins, "|"-separated. */
    var doneKeys: String?
    var doneAt: Long
    var doneKg: Float
    var doneImp: Boolean
}

/**
 * Turns the stream of scale packets into weigh-ins. While you stand on the scale it repeats
 * packets: unstable → stable weight → stable weight + impedance (barefoot, a few seconds later);
 * after you step off it keeps showing and broadcasting the result (stable + stepped off) for a
 * while. A weigh-in is complete at the first of:
 *  - a stable packet with impedance,
 *  - a stable step-off packet (the result, with impedance if it was measured) — in the
 *    background Android listens only now and then, so this may be the only packet it hears,
 *  - [PENDING_TIMEOUT_MS] after the last stable packet, when nothing else came ([flushStale]).
 * Each weigh-in is reported once.
 *
 * Used by both the in-app "Weigh in" screen and the background listener.
 */
object WeighIns {
    const val MIN_KG = 20.0
    const val MAX_KG = 250.0
    const val PENDING_TIMEOUT_MS = 60_000L
    /** Stable packets this close (time and weight) to a saved weigh-in are its repeats. */
    private const val REPEAT_MS = 5 * 60_000L
    private const val REPEAT_KG = 1.0
    private const val KEEP_KEYS = 10

    sealed class Result {
        data class Done(val weighIn: WeighIn) : Result()
        data class Measuring(val kg: Double, val stable: Boolean) : Result()
        data class Skipped(val reason: String) : Result()
        object Ignore : Result()
    }

    fun onPacket(context: Context, r: ScaleReading): Result = onPacket(Store(context), r)

    fun onPacket(s: ScaleState, r: ScaleReading): Result {
        if (r.kg < MIN_KG || r.kg > MAX_KG) return Result.Ignore
        if (r.stable && isRepeat(s, r)) return Result.Ignore

        // Someone else on the scale? (±15 % of your last weight, when we know it)
        val last = s.lastWeight.toDouble()
        if (s.onlyMyWeight && last > 0 && abs(r.kg - last) / last > 0.15) {
            return if (r.stable) Result.Skipped("%.1f kg isn't within 15%% of your %.1f kg, so it wasn't saved.".format(r.kg, last)) else Result.Ignore
        }

        val pending = hasPending(s, r.seenAt)
        if (r.stable && (r.impedance != null || r.removed)) {
            val at = if (pending) s.pendingAt else r.seenAt
            return finish(s, WeighIn(r.kg, r.impedance, at, r.address), r.key, r.seenAt)
        }
        if (r.stable) {
            if (!pending) s.pendingAt = r.seenAt
            s.pendingKey = r.key; s.pendingKg = r.kg.toFloat(); s.pendingLastAt = r.seenAt; s.pendingAddr = r.address
            return Result.Measuring(r.kg, true)
        }
        if (r.removed && pending) return flush(s)
        return Result.Measuring(r.kg, false)
    }

    /**
     * Saves a stable weight that never got its impedance or step-off packet, once it has waited
     * [PENDING_TIMEOUT_MS] — or now, with [force] (the Weigh in screen closed).
     */
    fun flushStale(context: Context, force: Boolean = false): Result = flushStale(Store(context), System.currentTimeMillis(), force)

    fun flushStale(s: ScaleState, now: Long, force: Boolean = false): Result {
        if (s.pendingKey == null || s.pendingKg <= 0) return Result.Ignore
        if (!force && now - s.pendingLastAt < PENDING_TIMEOUT_MS) return Result.Ignore
        return flush(s)
    }

    /** A stable weight is waiting and the scale was still on it recently. */
    fun hasPending(s: ScaleState, now: Long): Boolean =
        s.pendingKey != null && s.pendingKg > 0 && now - s.pendingLastAt < PENDING_TIMEOUT_MS

    private fun flush(s: ScaleState): Result {
        val key = s.pendingKey ?: return Result.Ignore
        return finish(s, WeighIn(s.pendingKg.toDouble(), null, s.pendingAt, s.pendingAddr ?: ""), key, s.pendingLastAt)
    }

    private fun isRepeat(s: ScaleState, r: ScaleReading): Boolean {
        if (r.impedance != null && !s.doneImp) return false // barefoot after a weigh-in in socks: keep it
        if (r.key in keys(s)) return true
        return abs(r.seenAt - s.doneAt) < REPEAT_MS && abs(r.kg - s.doneKg) < REPEAT_KG
    }

    private fun keys(s: ScaleState) = s.doneKeys?.split('|')?.filter { it.isNotEmpty() } ?: emptyList()

    private fun finish(s: ScaleState, w: WeighIn, key: String, seenAt: Long): Result {
        s.doneKeys = (listOf(key) + keys(s).filter { it != key }).take(KEEP_KEYS).joinToString("|")
        s.doneAt = seenAt; s.doneKg = w.kg.toFloat(); s.doneImp = w.impedance != null
        s.pendingKey = null; s.pendingKg = 0f; s.pendingAddr = null
        s.lastWeight = w.kg.toFloat()
        if (s.scaleAddress == null && w.address.isNotEmpty()) s.scaleAddress = w.address
        return Result.Done(w)
    }
}
