package com.alt.work.health

import android.Manifest
import android.annotation.SuppressLint
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.bluetooth.BluetoothManager
import android.bluetooth.le.BluetoothLeScanner
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.SystemClock
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import androidx.work.workDataOf
import org.json.JSONObject
import java.time.Instant
import java.time.ZoneId
import java.text.DateFormat
import java.util.Date
import java.util.concurrent.TimeUnit

/** Hourly Health Connect upload (while linked), and a re-arm of the scale listener. */
class SyncWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        val store = Store(applicationContext)
        if (!store.linked) return Result.success()
        if (store.scaleAuto) ScaleListener.start(applicationContext)
        WeighInWorker.saveIfDone(applicationContext, WeighIns.flushStale(applicationContext))
        if (!HealthSync.available(applicationContext)) return Result.success()
        return try {
            HealthSync.syncToCloud(applicationContext, if (store.firstSyncDone) 3 else 30)
            Result.success()
        } catch (e: SecurityException) {
            store.lastError = "Health Connect blocked the background read — allow \"Access data in the background\" for CWA Health in Health Connect."
            Result.success()
        } catch (e: Exception) {
            store.lastError = e.message ?: e.toString()
            if (runAttemptCount < 2) Result.retry() else Result.success()
        }
    }

    companion object {
        fun schedule(context: Context) {
            val req = PeriodicWorkRequestBuilder<SyncWorker>(1, TimeUnit.HOURS)
                .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                .build()
            WorkManager.getInstance(context).enqueueUniquePeriodicWork("hc-sync", ExistingPeriodicWorkPolicy.KEEP, req)
        }
    }
}

/** Uploads one weigh-in to users/<uid>/health/<day>/weighins/<ms> (retries until online). */
class WeighInWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        val kg = inputData.getDouble("kg", 0.0)
        val at = inputData.getLong("at", 0L)
        if (kg <= 0 || at <= 0) return Result.success()
        val imp = inputData.getInt("imp", 0)
        val json = JSONObject().put("t", at).put("kg", Math.round(kg * 100) / 100.0).put("src", "mi-scale")
        if (imp > 0) json.put("imp", imp)
        val day = Instant.ofEpochMilli(at).atZone(ZoneId.systemDefault()).toLocalDate()
        val store = Store(applicationContext)
        val latest = store.lastWeighInAt == at
        return try {
            Cloud(applicationContext).put("health/$day/weighins/$at", json)
            if (latest) store.lastWeighInState = "in CWA ✓"
            Result.success()
        } catch (e: Exception) {
            val msg = e.message ?: e.toString()
            if (latest) store.lastWeighInState = "upload failed: $msg" + (if (runAttemptCount < 5) " (will retry)" else "")
            if (runAttemptCount < 5) Result.retry() else Result.failure()
        }
    }

    companion object {
        fun enqueue(context: Context, w: WeighIn) {
            val store = Store(context)
            store.lastWeighIn = "%.1f kg".format(w.kg) + (if (w.impedance != null) " with body composition" else "") +
                " · " + DateFormat.getDateTimeInstance(DateFormat.SHORT, DateFormat.SHORT).format(Date(w.at))
            store.lastWeighInAt = w.at
            store.lastWeighInState = "waiting for internet to upload"
            val req = OneTimeWorkRequestBuilder<WeighInWorker>()
                .setInputData(workDataOf("kg" to w.kg, "at" to w.at, "imp" to (w.impedance ?: 0)))
                .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                .build()
            WorkManager.getInstance(context).enqueueUniqueWork("weighin-${w.at}", ExistingWorkPolicy.KEEP, req)
        }

        /** Uploads a weigh-in heard in the background, and says so in a notification. */
        fun saveIfDone(context: Context, result: WeighIns.Result) {
            if (result !is WeighIns.Result.Done) return
            enqueue(context, result.weighIn)
            Notify.weighIn(context, result.weighIn)
        }
    }
}

/**
 * Saves a stable weight heard in the background that never got its impedance or step-off packet
 * (the phone listens only now and then, and the scale goes quiet soon after you step off).
 */
class WeighInFlushWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        val store = Store(applicationContext)
        if (WeighIns.hasPending(store, System.currentTimeMillis())) schedule(applicationContext) // the scale's still talking
        else WeighInWorker.saveIfDone(applicationContext, WeighIns.flushStale(applicationContext))
        return Result.success()
    }

    companion object {
        fun schedule(context: Context) {
            val req = OneTimeWorkRequestBuilder<WeighInFlushWorker>()
                .setInitialDelay(WeighIns.PENDING_TIMEOUT_MS + 15_000, TimeUnit.MILLISECONDS)
                .build()
            WorkManager.getInstance(context).enqueueUniqueWork("weighin-flush", ExistingWorkPolicy.REPLACE, req)
        }
    }
}

/**
 * Listens for the scale in the background: Android delivers matching Bluetooth broadcasts to
 * [ScaleScanReceiver] even when the app isn't running (hardware-filtered, low power).
 */
object ScaleListener {
    private fun pendingIntent(context: Context): PendingIntent = PendingIntent.getBroadcast(
        context, 7, Intent(context, ScaleScanReceiver::class.java).setAction("com.alt.work.health.SCALE"),
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE,
    )

    /** When the phone heard a scan result, on its wall clock (results can arrive batched). */
    fun seenAt(res: ScanResult): Long {
        val now = System.currentTimeMillis()
        val ago = (SystemClock.elapsedRealtimeNanos() - res.timestampNanos) / 1_000_000L
        return if (ago in 0..600_000L) now - ago else now
    }

    fun hasPermission(context: Context): Boolean =
        if (Build.VERSION.SDK_INT >= 31) ContextCompat.checkSelfPermission(context, Manifest.permission.BLUETOOTH_SCAN) == PackageManager.PERMISSION_GRANTED
        else ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED

    private fun scanner(context: Context): BluetoothLeScanner? {
        val adapter = (context.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager)?.adapter ?: return null
        return if (adapter.isEnabled) adapter.bluetoothLeScanner else null
    }

    @SuppressLint("MissingPermission")
    fun start(context: Context): Boolean {
        if (!hasPermission(context)) return false
        val sc = scanner(context) ?: return false
        return try {
            sc.stopScan(pendingIntent(context))
            // Balanced, not low power: the scale talks for only ~15 s per weigh-in. (With the screen
            // off Android lowers background scans further on its own.) Matching runs in the
            // Bluetooth chip, so the app only wakes when the scale is on.
            val settings = ScanSettings.Builder().setScanMode(ScanSettings.SCAN_MODE_BALANCED).build()
            sc.startScan(MiScale.filters(Store(context).scaleAddress), settings, pendingIntent(context)) == 0
        } catch (e: Exception) { false }
    }

    /** What's stopping the background listener, or null when it can listen. */
    fun problem(context: Context): String? = when {
        !hasPermission(context) -> "Needs the Nearby devices (Bluetooth) permission: turn the switch off and on again."
        scanner(context) == null -> "Bluetooth is off, so the phone can't hear the scale."
        else -> null
    }

    @SuppressLint("MissingPermission")
    fun stop(context: Context) {
        if (!hasPermission(context)) return
        try { scanner(context)?.stopScan(pendingIntent(context)) } catch (e: Exception) {}
    }
}

class ScaleScanReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val results: List<ScanResult> = (if (Build.VERSION.SDK_INT >= 33) intent.getParcelableArrayListExtra(BluetoothLeScanner.EXTRA_LIST_SCAN_RESULT, ScanResult::class.java)
        else @Suppress("DEPRECATION") intent.getParcelableArrayListExtra(BluetoothLeScanner.EXTRA_LIST_SCAN_RESULT)) ?: return
        val store = Store(context)
        // An earlier weigh-in still waiting for its impedance or step-off packet: save it first.
        WeighInWorker.saveIfDone(context, WeighIns.flushStale(context))
        for (res in results.sortedBy { it.timestampNanos }) {
            val r = MiScale.parse(res.scanRecord?.serviceData, res.device.address, ScaleListener.seenAt(res)) ?: continue
            store.heard(r)
            when (val out = WeighIns.onPacket(store, r)) {
                is WeighIns.Result.Done -> WeighInWorker.saveIfDone(context, out)
                is WeighIns.Result.Measuring -> if (out.stable) WeighInFlushWorker.schedule(context)
                is WeighIns.Result.Skipped -> Notify.skipped(context, out.reason)
                WeighIns.Result.Ignore -> {}
            }
        }
    }
}

/** Re-arms the scale listener and the hourly sync after a reboot or an app update. */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val store = Store(context)
        if (!store.linked) return
        SyncWorker.schedule(context)
        if (store.scaleAuto) ScaleListener.start(context)
    }
}

object Notify {
    private const val CHANNEL = "weighins"

    fun weighIn(context: Context, w: WeighIn) {
        if (Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return
        val nm = context.getSystemService(NotificationManager::class.java)
        if (nm.getNotificationChannel(CHANNEL) == null) nm.createNotificationChannel(NotificationChannel(CHANNEL, "Weigh-ins", NotificationManager.IMPORTANCE_LOW))
        val open = PendingIntent.getActivity(context, 0, Intent(context, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE)
        val n = NotificationCompat.Builder(context, CHANNEL)
            .setSmallIcon(android.R.drawable.stat_notify_sync)
            .setContentTitle("Weigh-in saved: %.1f kg".format(w.kg))
            .setContentText(if (w.impedance != null) "With body composition. It shows in CWA once it's uploaded." else "It shows in CWA once it's uploaded. (Barefoot adds body composition.)")
            .setContentIntent(open)
            .setAutoCancel(true)
            .build()
        try { NotificationManagerCompat.from(context).notify(1001, n) } catch (e: SecurityException) {}
    }

    /** Heard a weigh-in that "Only my weight" kept out. */
    fun skipped(context: Context, reason: String) {
        if (Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return
        val nm = context.getSystemService(NotificationManager::class.java)
        if (nm.getNotificationChannel(CHANNEL) == null) nm.createNotificationChannel(NotificationChannel(CHANNEL, "Weigh-ins", NotificationManager.IMPORTANCE_LOW))
        val open = PendingIntent.getActivity(context, 0, Intent(context, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE)
        val n = NotificationCompat.Builder(context, CHANNEL)
            .setSmallIcon(android.R.drawable.stat_notify_error)
            .setContentTitle("Weigh-in not saved")
            .setContentText(reason)
            .setStyle(NotificationCompat.BigTextStyle().bigText("$reason If that was you, turn off “Only my weight” in CWA Health."))
            .setContentIntent(open)
            .setOnlyAlertOnce(true)
            .setAutoCancel(true)
            .build()
        try { NotificationManagerCompat.from(context).notify(1002, n) } catch (e: SecurityException) {}
    }
}
