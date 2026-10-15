package com.alt.work.health

import android.content.Context
import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.aggregate.AggregateMetric
import androidx.health.connect.client.permission.HealthPermission
import androidx.health.connect.client.records.ActiveCaloriesBurnedRecord
import androidx.health.connect.client.records.BodyFatRecord
import androidx.health.connect.client.records.DistanceRecord
import androidx.health.connect.client.records.ExerciseSessionRecord
import androidx.health.connect.client.records.FloorsClimbedRecord
import androidx.health.connect.client.records.HeartRateRecord
import androidx.health.connect.client.records.HeartRateVariabilityRmssdRecord
import androidx.health.connect.client.records.OxygenSaturationRecord
import androidx.health.connect.client.records.Record
import androidx.health.connect.client.records.RestingHeartRateRecord
import androidx.health.connect.client.records.SleepSessionRecord
import androidx.health.connect.client.records.StepsRecord
import androidx.health.connect.client.records.TotalCaloriesBurnedRecord
import androidx.health.connect.client.records.WeightRecord
import androidx.health.connect.client.request.AggregateGroupByPeriodRequest
import androidx.health.connect.client.request.ReadRecordsRequest
import androidx.health.connect.client.time.TimeRangeFilter
import org.json.JSONArray
import org.json.JSONObject
import java.time.Duration
import java.time.Instant
import java.time.LocalDate
import java.time.Period
import java.time.ZoneId
import kotlin.math.roundToInt
import kotlin.math.roundToLong
import kotlin.reflect.KClass

/**
 * Reads Health Connect (whatever your apps write there: the Luna ring, Samsung Health, Garmin
 * Connect, Zepp…) and uploads one summary per day to users/<uid>/health/<YYYY-MM-DD>/hc:
 *
 *   { steps, distM, activeKcal, totalKcal, floors, hr: {avg,min,max}, rhr, hrv, spo2,
 *     sleep: {min, start, end, deep, light, rem, awake}, weight, fat,
 *     ex: [{type, title, start, end, min}], sources: [package names], updated }
 *
 * Totals come from Health Connect's own aggregation, which de-duplicates overlapping sources
 * using the priority order set in Health Connect. Sleep belongs to the day you woke up.
 */
object HealthSync {
    const val PROVIDER = "com.google.android.apps.healthdata"
    const val BACKGROUND_PERMISSION = "android.permission.health.READ_HEALTH_DATA_IN_BACKGROUND"

    private val TYPES: List<KClass<out Record>> = listOf(
        StepsRecord::class, DistanceRecord::class, ActiveCaloriesBurnedRecord::class, TotalCaloriesBurnedRecord::class,
        FloorsClimbedRecord::class, HeartRateRecord::class, RestingHeartRateRecord::class,
        HeartRateVariabilityRmssdRecord::class, OxygenSaturationRecord::class, SleepSessionRecord::class,
        WeightRecord::class, BodyFatRecord::class, ExerciseSessionRecord::class,
    )

    private fun perm(t: KClass<out Record>) = HealthPermission.getReadPermission(t)

    /** Everything we ask for (all read-only), plus reading in the background. */
    val PERMISSIONS: Set<String> = TYPES.map { perm(it) }.toSet() + BACKGROUND_PERMISSION

    fun sdkStatus(context: Context): Int = HealthConnectClient.getSdkStatus(context, PROVIDER)
    fun available(context: Context) = sdkStatus(context) == HealthConnectClient.SDK_AVAILABLE

    suspend fun granted(context: Context): Set<String> =
        HealthConnectClient.getOrCreate(context).permissionController.getGrantedPermissions()

    /** Daily summaries for the last [days] days (today included), keyed by date. */
    suspend fun read(context: Context, days: Int): Map<LocalDate, JSONObject> {
        val client = HealthConnectClient.getOrCreate(context)
        val granted = client.permissionController.getGrantedPermissions()
        fun has(t: KClass<out Record>) = perm(t) in granted
        val zone = ZoneId.systemDefault()
        val today = LocalDate.now(zone)
        val first = today.minusDays((days - 1).toLong())
        val out = sortedMapOf<LocalDate, JSONObject>()
        fun day(d: LocalDate) = out.getOrPut(d) { JSONObject() }
        val sources = mutableMapOf<LocalDate, MutableSet<String>>()
        fun source(d: LocalDate, pkg: String) { sources.getOrPut(d) { mutableSetOf() }.add(pkg) }

        // Daily totals (one aggregation request; only metrics we may read, or it fails as a whole).
        val metrics = mutableSetOf<AggregateMetric<*>>()
        if (has(StepsRecord::class)) metrics += StepsRecord.COUNT_TOTAL
        if (has(DistanceRecord::class)) metrics += DistanceRecord.DISTANCE_TOTAL
        if (has(ActiveCaloriesBurnedRecord::class)) metrics += ActiveCaloriesBurnedRecord.ACTIVE_CALORIES_TOTAL
        if (has(TotalCaloriesBurnedRecord::class)) metrics += TotalCaloriesBurnedRecord.ENERGY_TOTAL
        if (has(FloorsClimbedRecord::class)) metrics += FloorsClimbedRecord.FLOORS_CLIMBED_TOTAL
        if (has(HeartRateRecord::class)) { metrics += HeartRateRecord.BPM_AVG; metrics += HeartRateRecord.BPM_MIN; metrics += HeartRateRecord.BPM_MAX }
        if (has(RestingHeartRateRecord::class)) metrics += RestingHeartRateRecord.BPM_AVG
        if (metrics.isNotEmpty()) {
            val buckets = client.aggregateGroupByPeriod(
                AggregateGroupByPeriodRequest(
                    metrics = metrics,
                    timeRangeFilter = TimeRangeFilter.between(first.atStartOfDay(), today.plusDays(1).atStartOfDay()),
                    timeRangeSlicer = Period.ofDays(1),
                )
            )
            for (b in buckets) {
                val d = b.startTime.toLocalDate()
                val r = b.result
                if (StepsRecord.COUNT_TOTAL in metrics) r[StepsRecord.COUNT_TOTAL]?.let { if (it > 0) day(d).put("steps", it) }
                if (DistanceRecord.DISTANCE_TOTAL in metrics) r[DistanceRecord.DISTANCE_TOTAL]?.let { if (it.inMeters > 0) day(d).put("distM", it.inMeters.roundToInt()) }
                if (ActiveCaloriesBurnedRecord.ACTIVE_CALORIES_TOTAL in metrics) r[ActiveCaloriesBurnedRecord.ACTIVE_CALORIES_TOTAL]?.let { if (it.inKilocalories > 0) day(d).put("activeKcal", it.inKilocalories.roundToInt()) }
                if (TotalCaloriesBurnedRecord.ENERGY_TOTAL in metrics) r[TotalCaloriesBurnedRecord.ENERGY_TOTAL]?.let { if (it.inKilocalories > 0) day(d).put("totalKcal", it.inKilocalories.roundToInt()) }
                if (FloorsClimbedRecord.FLOORS_CLIMBED_TOTAL in metrics) r[FloorsClimbedRecord.FLOORS_CLIMBED_TOTAL]?.let { if (it > 0) day(d).put("floors", it.roundToInt()) }
                if (HeartRateRecord.BPM_AVG in metrics) {
                    val avg = r[HeartRateRecord.BPM_AVG]
                    if (avg != null && avg > 0) day(d).put("hr", JSONObject().put("avg", avg).put("min", r[HeartRateRecord.BPM_MIN] ?: 0).put("max", r[HeartRateRecord.BPM_MAX] ?: 0))
                }
                if (RestingHeartRateRecord.BPM_AVG in metrics) r[RestingHeartRateRecord.BPM_AVG]?.let { if (it > 0) day(d).put("rhr", it) }
                r.dataOrigins.forEach { if (out.containsKey(d)) source(d, it.packageName) }
            }
        }

        val from = first.atStartOfDay(zone).toInstant()
        val to = Instant.now()
        val range = TimeRangeFilter.between(from, to)
        fun localDay(i: Instant): LocalDate = i.atZone(zone).toLocalDate()

        // Sleep: the longest session ending on a day is that night; stages in minutes.
        if (has(SleepSessionRecord::class)) {
            val sleepFrom = first.minusDays(1).atTime(12, 0).atZone(zone).toInstant()
            val recs = client.readRecords(ReadRecordsRequest(SleepSessionRecord::class, TimeRangeFilter.between(sleepFrom, to))).records
            for (s in recs) {
                val d = localDay(s.endTime)
                if (d.isBefore(first)) continue
                var deep = 0L; var light = 0L; var rem = 0L; var awake = 0L; var asleep = 0L
                for (st in s.stages) {
                    val m = Duration.between(st.startTime, st.endTime).toMinutes()
                    when (st.stage) {
                        SleepSessionRecord.STAGE_TYPE_DEEP -> deep += m
                        SleepSessionRecord.STAGE_TYPE_LIGHT -> light += m
                        SleepSessionRecord.STAGE_TYPE_REM -> rem += m
                        SleepSessionRecord.STAGE_TYPE_AWAKE, SleepSessionRecord.STAGE_TYPE_OUT_OF_BED, 7 /* awake in bed */ -> awake += m
                        else -> asleep += m
                    }
                }
                val total = Duration.between(s.startTime, s.endTime).toMinutes()
                val slept = if (s.stages.isEmpty()) total else deep + light + rem + asleep
                val prev = day(d).optJSONObject("sleep")
                if (prev == null || prev.optLong("min") < slept) {
                    day(d).put("sleep", JSONObject().put("min", slept).put("start", s.startTime.toEpochMilli()).put("end", s.endTime.toEpochMilli())
                        .put("deep", deep).put("light", light).put("rem", rem).put("awake", awake))
                }
                source(d, s.metadata.dataOrigin.packageName)
            }
        }

        // Daily averages of spot readings.
        if (has(HeartRateVariabilityRmssdRecord::class)) {
            client.readRecords(ReadRecordsRequest(HeartRateVariabilityRmssdRecord::class, range)).records
                .groupBy { localDay(it.time) }
                .forEach { (d, list) -> day(d).put("hrv", list.map { it.heartRateVariabilityMillis }.average().roundToInt()) }
        }
        if (has(OxygenSaturationRecord::class)) {
            client.readRecords(ReadRecordsRequest(OxygenSaturationRecord::class, range)).records
                .groupBy { localDay(it.time) }
                .forEach { (d, list) -> day(d).put("spo2", (list.map { it.percentage.value }.average() * 10).roundToLong() / 10.0) }
        }
        // Body: the day's latest reading.
        if (has(WeightRecord::class)) {
            client.readRecords(ReadRecordsRequest(WeightRecord::class, range)).records
                .groupBy { localDay(it.time) }
                .forEach { (d, list) -> val w = list.maxBy { it.time }; day(d).put("weight", (w.weight.inKilograms * 100).roundToLong() / 100.0); source(d, w.metadata.dataOrigin.packageName) }
        }
        if (has(BodyFatRecord::class)) {
            client.readRecords(ReadRecordsRequest(BodyFatRecord::class, range)).records
                .groupBy { localDay(it.time) }
                .forEach { (d, list) -> day(d).put("fat", (list.maxBy { it.time }.percentage.value * 10).roundToLong() / 10.0) }
        }
        // Workouts recorded by other apps/devices.
        if (has(ExerciseSessionRecord::class)) {
            client.readRecords(ReadRecordsRequest(ExerciseSessionRecord::class, range)).records
                .groupBy { localDay(it.startTime) }
                .forEach { (d, list) ->
                    val arr = JSONArray()
                    list.sortedBy { it.startTime }.forEach { s ->
                        arr.put(JSONObject().put("type", exerciseName(s.exerciseType)).put("title", s.title ?: "")
                            .put("start", s.startTime.toEpochMilli()).put("end", s.endTime.toEpochMilli())
                            .put("min", Duration.between(s.startTime, s.endTime).toMinutes()))
                        source(d, s.metadata.dataOrigin.packageName)
                    }
                    day(d).put("ex", arr)
                }
        }

        sources.forEach { (d, set) -> if (out.containsKey(d)) out.getValue(d).put("sources", JSONArray(set.sorted())) }
        return out.filterKeys { !it.isBefore(first) }.filterValues { it.length() > 0 }
    }

    private fun exerciseName(type: Int): String = when (type) {
        ExerciseSessionRecord.EXERCISE_TYPE_WALKING -> "walking"
        ExerciseSessionRecord.EXERCISE_TYPE_RUNNING -> "running"
        ExerciseSessionRecord.EXERCISE_TYPE_BIKING -> "cycling"
        ExerciseSessionRecord.EXERCISE_TYPE_STRENGTH_TRAINING -> "strength"
        ExerciseSessionRecord.EXERCISE_TYPE_WEIGHTLIFTING -> "weightlifting"
        ExerciseSessionRecord.EXERCISE_TYPE_HIKING -> "hiking"
        ExerciseSessionRecord.EXERCISE_TYPE_YOGA -> "yoga"
        ExerciseSessionRecord.EXERCISE_TYPE_SWIMMING_POOL, ExerciseSessionRecord.EXERCISE_TYPE_SWIMMING_OPEN_WATER -> "swimming"
        ExerciseSessionRecord.EXERCISE_TYPE_HIGH_INTENSITY_INTERVAL_TRAINING -> "hiit"
        else -> "other"
    }

    /** Reads the last [days] days and uploads them. Returns how many days were uploaded. */
    suspend fun syncToCloud(context: Context, days: Int): Int {
        val store = Store(context)
        val cloud = Cloud(context)
        val data = read(context, days)
        val now = System.currentTimeMillis()
        for ((d, json) in data) {
            json.put("updated", now)
            cloud.put("health/$d/hc", json)
        }
        store.lastSync = now
        store.lastSyncDays = data.size
        store.lastError = null
        store.firstSyncDone = true
        return data.size
    }
}
