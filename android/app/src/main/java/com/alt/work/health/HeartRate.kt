package com.alt.work.health

import java.time.Duration
import java.time.Instant
import kotlin.math.roundToInt

/**
 * A resting heart rate estimate for wearables that write heart-rate readings but no resting
 * value (e.g. a ring): the lowest average over any [window] of readings, needing at least
 * [minSamples] of them so one low glitch doesn't count. Rings read most at night, so this
 * lands close to what they call resting / lowest heart rate.
 */
object HeartRate {
    fun restingEstimate(samples: List<Pair<Instant, Long>>, window: Duration = Duration.ofMinutes(30), minSamples: Int = 3): Int? {
        val s = samples.filter { it.second in 25..230 }.sortedBy { it.first }
        var best: Double? = null
        var sum = 0L
        var lo = 0
        for (hi in s.indices) {
            sum += s[hi].second
            while (Duration.between(s[lo].first, s[hi].first) > window) { sum -= s[lo].second; lo++ }
            val n = hi - lo + 1
            if (n >= minSamples) {
                val avg = sum.toDouble() / n
                if (best == null || avg < best) best = avg
            }
        }
        return best?.roundToInt()
    }
}
