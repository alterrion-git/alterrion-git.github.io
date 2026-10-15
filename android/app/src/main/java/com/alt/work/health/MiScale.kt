package com.alt.work.health

import android.bluetooth.le.ScanFilter
import android.os.ParcelUuid
import java.time.LocalDateTime
import java.time.ZoneId

/** One packet from a Xiaomi scale's Bluetooth broadcast. */
data class ScaleReading(
    val kg: Double,
    val impedance: Int?,
    val stable: Boolean,
    val removed: Boolean,
    /** When the scale says it measured (its own clock), or null if it didn't send a valid date. */
    val measuredAt: Long?,
    val address: String,
) {
    /** Identifies one weigh-in across its repeated packets. */
    val key: String get() = "$address@" + (measuredAt ?: (System.currentTimeMillis() / 60_000)) // no date: per minute
}

/**
 * Xiaomi Mi scales broadcast every reading in their Bluetooth advertisement, so we only listen
 * (no pairing, and Zepp Life keeps working). Two formats:
 *
 *  Mi Body Composition Scale 2 (XMTZC05HM): service data 0x181B, 13 bytes
 *    [0] flags (bit0: lbs)  [1] flags (bit1: impedance present, bit5: stabilised, bit7: stepped off)
 *    [2..3] year LE, [4] month, [5] day, [6] hour, [7] minute, [8] second
 *    [9..10] impedance LE (ohm), [11..12] weight LE (kg × 200, or lbs × 100)
 *
 *  Mi Smart Scale 2 (XMTZC04HM): service data 0x181D, 10 bytes
 *    [0] flags (bit0: lbs, bit4: catty, bit5: stabilised, bit7: stepped off)
 *    [1..2] weight LE (kg × 200, or lbs/catty × 100), [3..4] year LE, [5] month, [6] day, [7] hour, [8] min, [9] sec
 */
object MiScale {
    val BODY_COMPOSITION: ParcelUuid by lazy { ParcelUuid.fromString("0000181b-0000-1000-8000-00805f9b34fb") }
    val WEIGHT_SCALE: ParcelUuid by lazy { ParcelUuid.fromString("0000181d-0000-1000-8000-00805f9b34fb") }
    private const val LB = 0.45359237

    /** Scan filters: either service, and the remembered scale's address when we know it. */
    fun filters(address: String?): List<ScanFilter> = listOf(BODY_COMPOSITION, WEIGHT_SCALE).map { uuid ->
        ScanFilter.Builder().setServiceData(uuid, ByteArray(0)).apply { if (address != null) setDeviceAddress(address) }.build()
    }

    private fun u8(b: ByteArray, i: Int) = b[i].toInt() and 0xFF
    private fun u16(b: ByteArray, i: Int) = u8(b, i) or (u8(b, i + 1) shl 8)

    private fun time(y: Int, mo: Int, d: Int, h: Int, mi: Int, s: Int): Long? = try {
        if (y < 2015 || y > 2100) null
        else LocalDateTime.of(y, mo, d, h, mi, s).atZone(ZoneId.systemDefault()).toInstant().toEpochMilli()
    } catch (e: Exception) { null }

    fun parseBodyComposition(data: ByteArray, address: String): ScaleReading? {
        if (data.size < 13) return null
        val c0 = u8(data, 0)
        val c1 = u8(data, 1)
        val raw = u16(data, 11)
        val kg = if (c0 and 0x01 != 0) raw / 100.0 * LB else raw / 200.0
        val imp = u16(data, 9)
        val hasImp = c1 and 0x02 != 0 && imp in 1..2999
        return ScaleReading(
            kg = kg,
            impedance = if (hasImp) imp else null,
            stable = c1 and 0x20 != 0,
            removed = c1 and 0x80 != 0,
            measuredAt = time(u16(data, 2), u8(data, 4), u8(data, 5), u8(data, 6), u8(data, 7), u8(data, 8)),
            address = address,
        )
    }

    fun parseWeightScale(data: ByteArray, address: String): ScaleReading? {
        if (data.size < 10) return null
        val c = u8(data, 0)
        val raw = u16(data, 1)
        val kg = when {
            c and 0x01 != 0 -> raw / 100.0 * LB
            c and 0x10 != 0 -> raw / 100.0 * 0.5 // catty (jin)
            else -> raw / 200.0
        }
        return ScaleReading(
            kg = kg, impedance = null, stable = c and 0x20 != 0, removed = c and 0x80 != 0,
            measuredAt = time(u16(data, 3), u8(data, 5), u8(data, 6), u8(data, 7), u8(data, 8), u8(data, 9)),
            address = address,
        )
    }

    /** Parses whichever format the advertisement carries. */
    fun parse(serviceData: Map<ParcelUuid, ByteArray>?, address: String): ScaleReading? {
        if (serviceData == null) return null
        serviceData[BODY_COMPOSITION]?.let { return parseBodyComposition(it, address) }
        serviceData[WEIGHT_SCALE]?.let { return parseWeightScale(it, address) }
        return null
    }
}
