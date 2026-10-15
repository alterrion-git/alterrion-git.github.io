package com.alt.work.health

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class MiScaleTest {
    // Mi Body Composition Scale 2 payload (service data 0x181B), measured 2026-10-15 07:30:05.
    private fun bodyComp(c0: Int, c1: Int, rawWeight: Int, impedance: Int) = byteArrayOf(
        c0.toByte(), c1.toByte(), 0xEA.toByte(), 0x07, 10, 15, 7, 30, 5,
        (impedance and 0xFF).toByte(), (impedance shr 8).toByte(),
        (rawWeight and 0xFF).toByte(), (rawWeight shr 8).toByte(),
    )

    @Test fun stableKgWithImpedance() {
        val r = MiScale.parseBodyComposition(bodyComp(0x02, 0x26, 16240, 500), "AA:BB")!!
        assertEquals(81.2, r.kg, 0.001)
        assertEquals(500, r.impedance)
        assertTrue(r.stable)
        assertFalse(r.removed)
        assertNotNull(r.measuredAt)
    }

    @Test fun impedanceOnlyWhenFlagged() {
        val r = MiScale.parseBodyComposition(bodyComp(0x02, 0x24, 16240, 500), "AA:BB")!!
        assertNull(r.impedance)
        assertTrue(r.stable)
    }

    @Test fun unstableAndSteppedOff() {
        val unstable = MiScale.parseBodyComposition(bodyComp(0x02, 0x04, 16000, 0), "AA:BB")!!
        assertFalse(unstable.stable)
        val off = MiScale.parseBodyComposition(bodyComp(0x02, 0xA4, 16240, 0), "AA:BB")!!
        assertTrue(off.removed)
    }

    @Test fun poundsAreConverted() {
        val r = MiScale.parseBodyComposition(bodyComp(0x03, 0x24, 17900, 0), "AA:BB")!!
        assertEquals(81.19, r.kg, 0.01)
    }

    @Test fun badDateIsNull() {
        val data = bodyComp(0x02, 0x26, 16240, 500).also { it[2] = 0; it[3] = 0 }
        assertNull(MiScale.parseBodyComposition(data, "AA:BB")!!.measuredAt)
    }

    @Test fun miSmartScale2() {
        // 0x181D: flags 0x22 (kg, stable), 80.0 kg = 16000, 2026-10-15 07:30:05
        val data = byteArrayOf(0x22, (16000 and 0xFF).toByte(), (16000 shr 8).toByte(), 0xEA.toByte(), 0x07, 10, 15, 7, 30, 5)
        val r = MiScale.parseWeightScale(data, "AA:BB")!!
        assertEquals(80.0, r.kg, 0.001)
        assertTrue(r.stable)
        assertNull(r.impedance)
    }

    @Test fun tooShort() {
        assertNull(MiScale.parseBodyComposition(ByteArray(5), "AA:BB"))
        assertNull(MiScale.parseWeightScale(ByteArray(5), "AA:BB"))
    }
}
