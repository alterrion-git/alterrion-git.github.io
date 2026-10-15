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
import java.util.concurrent.TimeUnit

/** Hourly Health Connect upload (while linked), and a re-arm of the scale listener. */
class SyncWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        val store = Store(applicationContext)
        if (!store.linked) return Result.success()
        if (store.scaleAuto) ScaleListener.start(applicationContext)
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
        return try {
            Cloud(applicationContext).put("health/$day/weighins/$at", json)
            Result.success()
        } catch (e: Exception) {
            Store(applicationContext).lastError = "Weigh-in upload: " + (e.message ?: e.toString())
            if (runAttemptCount < 5) Result.retry() else Result.failure()
        }
    }

    companion object {
        fun enqueue(context: Context, w: WeighIn) {
            Store(context).lastWeighIn = "%.1f kg".format(w.kg) + (if (w.impedance != null) " · body composition" else "")
            val req = OneTimeWorkRequestBuilder<WeighInWorker>()
                .setInputData(workDataOf("kg" to w.kg, "at" to w.at, "imp" to (w.impedance ?: 0)))
                .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                .build()
            WorkManager.getInstance(context).enqueueUniqueWork("weighin-${w.at}", ExistingWorkPolicy.KEEP, req)
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
            val settings = ScanSettings.Builder().setScanMode(ScanSettings.SCAN_MODE_LOW_POWER).build()
            sc.startScan(MiScale.filters(Store(context).scaleAddress), settings, pendingIntent(context)) == 0
        } catch (e: Exception) { false }
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
        for (res in results) {
            val r = MiScale.parse(res.scanRecord?.serviceData, res.device.address) ?: continue
            when (val out = WeighIns.onPacket(context, r)) {
                is WeighIns.Result.Done -> { WeighInWorker.enqueue(context, out.weighIn); Notify.weighIn(context, out.weighIn) }
                else -> {}
            }
        }
        // A stable weight that never got its impedance or step-off packet.
        val flushed = WeighIns.flushPending(context, results.lastOrNull()?.device?.address ?: "", force = false)
        if (flushed is WeighIns.Result.Done) { WeighInWorker.enqueue(context, flushed.weighIn); Notify.weighIn(context, flushed.weighIn) }
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
            .setContentText(if (w.impedance != null) "With body composition · synced to CWA" else "Synced to CWA (stand barefoot for body composition)")
            .setContentIntent(open)
            .setAutoCancel(true)
            .build()
        try { NotificationManagerCompat.from(context).notify(1001, n) } catch (e: SecurityException) {}
    }
}
