package com.alt.work.health

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class WeighInsTest {
    private class State : ScaleState {
        override var onlyMyWeight = true
        override var lastWeight = 0f
        override var scaleAddress: String? = null
        override var pendingKey: String? = null
        override var pendingKg = 0f
        override var pendingAt = 0L
        override var pendingLastAt = 0L
        override var pendingAddr: String? = null
        override var doneKeys: String? = null
        override var doneAt = 0L
        override var doneKg = 0f
        override var doneImp = false
    }

    private val t0 = 1_760_600_000_000L // the phone's clock
    private val scaleTime = 1_760_590_000_000L // the scale's own (it can be off)

    private fun packet(sec: Int, kg: Double, stable: Boolean, removed: Boolean = false, imp: Int? = null, measuredAt: Long? = scaleTime) =
        ScaleReading(kg = kg, impedance = imp, stable = stable, removed = removed, measuredAt = measuredAt, address = "AA:BB", seenAt = t0 + sec * 1000L)

    private fun done(r: WeighIns.Result): WeighIn {
        assertTrue("expected a saved weigh-in, got $r", r is WeighIns.Result.Done)
        return (r as WeighIns.Result.Done).weighIn
    }

    @Test fun barefootSavesAtImpedance() {
        val s = State()
        assertTrue(WeighIns.onPacket(s, packet(0, 80.4, stable = false)) is WeighIns.Result.Measuring)
        assertTrue(WeighIns.onPacket(s, packet(2, 81.2, stable = true)) is WeighIns.Result.Measuring)
        val w = done(WeighIns.onPacket(s, packet(6, 81.2, stable = true, imp = 480)))
        assertEquals(81.2, w.kg, 0.001)
        assertEquals(480, w.impedance)
        assertEquals(t0 + 2000, w.at) // the first stable packet, on the phone's clock
        assertEquals("AA:BB", s.scaleAddress)
        // The scale keeps showing the result after you step off: not saved again.
        assertEquals(WeighIns.Result.Ignore, WeighIns.onPacket(s, packet(9, 81.2, stable = true, removed = true, imp = 480)))
        assertEquals(WeighIns.Result.Ignore, WeighIns.onPacket(s, packet(15, 81.2, stable = true, removed = true, imp = 480, measuredAt = scaleTime + 9000)))
    }

    @Test fun socksSaveAtStepOff() {
        val s = State()
        WeighIns.onPacket(s, packet(2, 81.2, stable = true))
        val w = done(WeighIns.onPacket(s, packet(8, 81.2, stable = true, removed = true)))
        assertNull(w.impedance)
        assertEquals(t0 + 2000, w.at)
        assertNull(s.pendingKey)
    }

    // In the background the phone may hear only the result shown after stepping off.
    @Test fun onlyTheStepOffPacketIsEnough() {
        val s = State()
        val w = done(WeighIns.onPacket(s, packet(20, 81.2, stable = true, removed = true)))
        assertEquals(81.2, w.kg, 0.001)
        assertEquals(t0 + 20_000, w.at)
        val withImp = done(WeighIns.onPacket(State(), packet(20, 81.2, stable = true, removed = true, imp = 480)))
        assertEquals(480, withImp.impedance)
    }

    @Test fun unstableStepOffFinishesTheWaitingWeight() {
        val s = State()
        WeighIns.onPacket(s, packet(2, 81.2, stable = true))
        val w = done(WeighIns.onPacket(s, packet(5, 81.0, stable = false, removed = true)))
        assertEquals(81.2, w.kg, 0.001)
    }

    // Only a stable packet heard: saved once the wait is over (the background flush).
    @Test fun stableOnlyIsSavedAfterTheWait() {
        val s = State()
        WeighIns.onPacket(s, packet(2, 81.2, stable = true))
        WeighIns.onPacket(s, packet(4, 81.25, stable = true))
        assertEquals(WeighIns.Result.Ignore, WeighIns.flushStale(s, t0 + 30_000))
        assertTrue(WeighIns.hasPending(s, t0 + 30_000))
        val w = done(WeighIns.flushStale(s, t0 + 4000 + WeighIns.PENDING_TIMEOUT_MS))
        assertEquals(81.25, w.kg, 0.001)
        assertEquals(t0 + 2000, w.at)
        assertEquals(WeighIns.Result.Ignore, WeighIns.flushStale(s, t0 + 999_999))
        // Its late step-off packet is a repeat.
        assertEquals(WeighIns.Result.Ignore, WeighIns.onPacket(s, packet(70, 81.2, stable = true, removed = true)))
    }

    @Test fun forcedFlushWhenTheScreenCloses() {
        val s = State()
        WeighIns.onPacket(s, packet(2, 81.2, stable = true))
        done(WeighIns.flushStale(s, t0 + 3000, force = true))
    }

    @Test fun barefootRightAfterSocksIsKept() {
        val s = State()
        done(WeighIns.onPacket(s, packet(2, 81.2, stable = true, removed = true)))
        val w = done(WeighIns.onPacket(s, packet(60, 81.1, stable = true, imp = 480, measuredAt = scaleTime + 60_000)))
        assertEquals(480, w.impedance)
    }

    @Test fun nextDayIsANewWeighIn() {
        val s = State()
        done(WeighIns.onPacket(s, packet(2, 81.2, stable = true, removed = true)))
        done(WeighIns.onPacket(s, packet(86_400, 81.0, stable = true, removed = true, measuredAt = scaleTime + 86_400_000)))
    }

    @Test fun repeatOfAnOldResultIsIgnored() {
        val s = State()
        done(WeighIns.onPacket(s, packet(2, 81.2, stable = true, removed = true)))
        // The next morning the scale wakes up still holding yesterday's result.
        assertEquals(WeighIns.Result.Ignore, WeighIns.onPacket(s, packet(86_400, 81.2, stable = true, removed = true)))
    }

    @Test fun someoneElseIsSkipped() {
        val s = State().apply { lastWeight = 81f }
        assertTrue(WeighIns.onPacket(s, packet(2, 62.0, stable = true, removed = true)) is WeighIns.Result.Skipped)
        assertEquals(WeighIns.Result.Ignore, WeighIns.onPacket(s, packet(1, 62.0, stable = false)))
        s.onlyMyWeight = false
        done(WeighIns.onPacket(s, packet(3, 62.0, stable = true, removed = true)))
    }

    @Test fun nonsenseWeightsIgnored() {
        val s = State()
        assertEquals(WeighIns.Result.Ignore, WeighIns.onPacket(s, packet(1, 0.0, stable = true, removed = true)))
        assertEquals(WeighIns.Result.Ignore, WeighIns.onPacket(s, packet(1, 300.0, stable = true)))
    }

    @Test fun scaleWithoutAClock() {
        val s = State()
        WeighIns.onPacket(s, packet(2, 81.2, stable = true, measuredAt = null))
        val w = done(WeighIns.onPacket(s, packet(7, 81.2, stable = true, removed = true, measuredAt = null)))
        assertEquals(t0 + 2000, w.at)
        assertEquals(WeighIns.Result.Ignore, WeighIns.onPacket(s, packet(12, 81.2, stable = true, removed = true, measuredAt = null)))
    }
}
