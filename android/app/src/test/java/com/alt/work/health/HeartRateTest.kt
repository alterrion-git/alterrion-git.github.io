package com.alt.work.health

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.time.Instant

class HeartRateTest {
    private val t0 = Instant.parse("2026-10-17T00:00:00Z")
    private fun every5min(vararg bpm: Long) = bpm.mapIndexed { i, b -> t0.plusSeconds(i * 300L) to b }

    @Test fun lowestHalfHourWins() {
        // Evening 70s, night 52–56, morning 80s. Every 30-minute window (7 readings) of the
        // night also takes in a 71 or an 80: the lowest is 10–40 min, 395 / 7 = 56.4.
        val s = every5min(72, 70, 71, 56, 54, 52, 53, 55, 54, 80, 85, 90)
        assertEquals(56, HeartRate.restingEstimate(s))
    }

    @Test fun oneLowGlitchDoesNotCount() {
        val s = every5min(70, 71, 30, 72, 70, 71, 69, 70)
        // the glitch is averaged with its neighbours, not taken alone
        val est = HeartRate.restingEstimate(s)!!
        assert(est in 55..70) { "estimate $est" }
    }

    @Test fun tooFewReadings() {
        assertNull(HeartRate.restingEstimate(every5min(60, 61)))
        // hourly readings never put 3 in one half hour
        val hourly = (0 until 10).map { t0.plusSeconds(it * 3600L) to 60L }
        assertNull(HeartRate.restingEstimate(hourly))
    }

    @Test fun unsortedAndImpossibleValuesAreHandled() {
        // 0 and 300 are dropped; the lowest window is 60, 58, 59 → 59.
        val s = every5min(60, 58, 59, 0, 300, 61).shuffled()
        assertEquals(59, HeartRate.restingEstimate(s))
    }
}
