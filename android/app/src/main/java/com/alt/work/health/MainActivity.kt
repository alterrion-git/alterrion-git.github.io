package com.alt.work.health

import android.Manifest
import android.annotation.SuppressLint
import android.bluetooth.BluetoothManager
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.content.Intent
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.provider.Settings
import android.view.Gravity
import android.view.View
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.PermissionController
import androidx.lifecycle.lifecycleScope
import com.google.android.material.button.MaterialButton
import com.google.android.material.materialswitch.MaterialSwitch
import kotlinx.coroutines.launch
import java.text.DateFormat
import java.util.Date
import kotlin.math.abs

/**
 * The companion's one screen: which CWA account it's linked to, Health Connect access + sync,
 * and the scale (weigh in now / save weigh-ins automatically in the background).
 */
class MainActivity : AppCompatActivity() {
    private val store by lazy { Store(this) }
    private val handler = Handler(Looper.getMainLooper())

    private lateinit var accountText: TextView
    private lateinit var hcText: TextView
    private lateinit var hcButton: MaterialButton
    private lateinit var syncButton: MaterialButton
    private lateinit var syncText: TextView
    private lateinit var weightText: TextView
    private lateinit var scaleText: TextView
    private lateinit var weighButton: MaterialButton
    private lateinit var autoSwitch: MaterialSwitch
    private lateinit var mineSwitch: MaterialSwitch
    private lateinit var batteryButton: MaterialButton

    private var scanCallback: ScanCallback? = null
    private var afterBtPermission: (() -> Unit)? = null

    private val hcPermissionRequest = registerForActivityResult(PermissionController.createRequestPermissionResultContract()) { granted ->
        refresh()
        if (granted.isNotEmpty() && store.linked) syncNow()
    }
    private val btPermissionRequest = registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { result ->
        val ok = ScaleListener.hasPermission(this)
        if (ok) afterBtPermission?.invoke() else if (result.isNotEmpty()) toast("Bluetooth permission is needed to hear the scale.")
        afterBtPermission = null
        refresh()
    }

    // ---------- small view helpers ----------
    private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()
    private fun color(id: Int) = ContextCompat.getColor(this, id)
    private fun text(size: Float, colorId: Int = R.color.text, bold: Boolean = false) = TextView(this).apply {
        textSize = size; setTextColor(color(colorId)); if (bold) setTypeface(typeface, Typeface.BOLD)
        setPadding(0, dp(2), 0, dp(2))
    }
    private fun button(label: String, primary: Boolean, onClick: () -> Unit) =
        (if (primary) MaterialButton(this) else MaterialButton(this, null, com.google.android.material.R.attr.materialButtonOutlinedStyle)).apply {
            text = label; isAllCaps = false; setOnClickListener { onClick() }
            layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(6) }
        }
    private fun card(parent: LinearLayout, title: String): LinearLayout {
        val c = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(16), dp(14), dp(16), dp(14))
            background = GradientDrawable().apply { setColor(color(R.color.card)); cornerRadius = dp(20).toFloat() }
            layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(12) }
        }
        c.addView(text(12f, R.color.muted, bold = true).apply { this.text = title.uppercase(); letterSpacing = 0.12f })
        parent.addView(c)
        return c
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val root = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(16), dp(20), dp(16), dp(32)) }
        root.addView(text(26f, R.color.lime, bold = true).apply { text = "CWA Health" })
        root.addView(text(13f, R.color.muted).apply { text = "Brings Health Connect data and your scale's weigh-ins into CWA. v${BuildConfig.VERSION_NAME}" })

        val account = card(root, "Account")
        accountText = text(15f).also { account.addView(it) }
        account.addView(button("Open CWA", false) { openCwa() })

        val hc = card(root, "Health Connect")
        hcText = text(15f).also { hc.addView(it) }
        hcButton = button("Allow access", true) { requestHealthPermissions() }.also { hc.addView(it) }
        syncButton = button("Sync now", false) { syncNow() }.also { hc.addView(it) }
        hc.addView(button("Open Health Connect (sources & priority)", false) { openHealthConnect() })
        syncText = text(13f, R.color.muted).also { hc.addView(it) }

        val scale = card(root, "Scale")
        weightText = text(40f, R.color.lime, bold = true).apply { gravity = Gravity.CENTER; text = "— kg" }.also { scale.addView(it) }
        scaleText = text(14f, R.color.muted).apply { gravity = Gravity.CENTER }.also { scale.addView(it) }
        weighButton = button("Weigh in now", true) { if (scanCallback == null) startWeighIn() else stopWeighIn("Stopped.") }.also { scale.addView(it) }
        autoSwitch = MaterialSwitch(this).apply {
            text = "Also listen for the scale in the background (uses more battery)"; setTextColor(color(R.color.text))
            setOnCheckedChangeListener { _, on -> if (on != store.scaleAuto) setAuto(on) }
        }.also { scale.addView(it) }
        mineSwitch = MaterialSwitch(this).apply {
            text = "Only my weight (within 15% of my last)"; setTextColor(color(R.color.text))
            setOnCheckedChangeListener { _, on -> store.onlyMyWeight = on }
        }.also { scale.addView(it) }
        batteryButton = button("Let it run in the background (battery)", false) { askBatteryExemption() }.also { scale.addView(it) }
        scale.addView(text(12f, R.color.muted).apply {
            text = "Mi Body Composition Scale 2 / Mi Smart Scale 2. Tap “Weigh in now” (or Weigh in in CWA › Health), then step on the scale. " +
                "Barefoot until the weight blinks adds body composition. Zepp Life keeps working alongside."
        })

        root.addView(button("Privacy & data", false) { startActivity(Intent(this, PrivacyActivity::class.java)) })
        setContentView(ScrollView(this).apply { setBackgroundColor(color(R.color.bg)); addView(root) })
        handleLink(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleLink(intent)
    }

    override fun onResume() {
        super.onResume()
        if (store.linked) {
            SyncWorker.schedule(this)
            if (store.scaleAuto) ScaleListener.start(this) else ScaleListener.stop(this)
            // Opening the app syncs when the last sync is over an hour old (the background one
            // runs only twice a day).
            if (System.currentTimeMillis() - store.lastSync > 3_600_000L && HealthSync.available(this)) lifecycleScope.launch {
                if (HealthSync.granted(this@MainActivity).isNotEmpty()) syncNow(quiet = true)
            }
        }
        refresh()
    }

    override fun onPause() {
        super.onPause()
        if (scanCallback != null) stopWeighIn("")
    }

    // ---------- linking (cwahealth://link?db=…&u=…&k=…&rt=…&e=…&w=…) ----------
    private fun handleLink(intent: Intent?) {
        val data: Uri = intent?.data ?: return
        if (data.scheme != "cwahealth") return
        when (data.host) {
            "link" -> {
                val db = data.getQueryParameter("db") ?: ""
                val uid = data.getQueryParameter("u") ?: ""
                // Only ever send the account's sign-in to a Firebase database.
                if (!db.startsWith("https://") || !(db.contains(".firebasedatabase.app") || db.contains(".firebaseio.com")) || uid.isEmpty()) {
                    toast("That link isn't a CWA account link."); return
                }
                store.dbUrl = db
                store.uid = uid
                store.apiKey = data.getQueryParameter("k")
                store.email = data.getQueryParameter("e")
                store.refreshToken = data.getQueryParameter("rt")?.ifEmpty { null }
                store.idToken = null; store.idTokenExpires = 0
                data.getQueryParameter("w")?.toFloatOrNull()?.let { if (it > 0) store.lastWeight = it }
                toast("Linked to CWA" + (store.email?.let { " ($it)" } ?: ""))
                SyncWorker.schedule(this)
                refresh()
                if (HealthSync.available(this)) lifecycleScope.launch {
                    if (!HealthSync.granted(this@MainActivity).containsAll(HealthSync.PERMISSIONS - HealthSync.BACKGROUND_PERMISSION)) requestHealthPermissions() else syncNow()
                }
            }
            "weigh" -> handler.post { startWeighIn() }
            "sync" -> handler.post { syncNow() }
        }
        intent?.setData(null)
    }

    // ---------- status ----------
    private fun refresh() {
        accountText.text = if (store.linked) "Linked to CWA" + (store.email?.let { ": $it" } ?: "") + "\nData goes to your CWA account (Profile › Health)."
        else "Not linked yet.\nOpen CWA → Profile → Health → “Link Android app”."
        autoSwitch.isChecked = store.scaleAuto
        mineSwitch.isChecked = store.onlyMyWeight
        if (scanCallback == null) scaleText.text = scaleStatus()
        batteryButton.visibility = if (store.scaleAuto && !ignoringBatteryOptimizations()) View.VISIBLE else View.GONE
        val sync = if (store.lastSync > 0) "Last sync: ${DateFormat.getDateTimeInstance(DateFormat.SHORT, DateFormat.SHORT).format(Date(store.lastSync))} (${store.lastSyncDays} days)" else "Not synced yet."
        syncText.text = sync + (store.lastError?.let { "\n⚠ $it" } ?: "") + "\nSyncs twice a day in the background, and when you open this app."

        when (HealthSync.sdkStatus(this)) {
            HealthConnectClient.SDK_AVAILABLE -> lifecycleScope.launch {
                val granted = HealthSync.granted(this@MainActivity)
                val data = HealthSync.PERMISSIONS - HealthSync.BACKGROUND_PERMISSION
                val n = data.count { it in granted }
                val bg = HealthSync.BACKGROUND_PERMISSION in granted
                hcText.text = "Access to $n of ${data.size} data types" + (if (bg) " · background reading allowed" else " · background reading not allowed")
                hcButton.visibility = if (n < data.size || !bg) View.VISIBLE else View.GONE
                syncButton.isEnabled = store.linked && n > 0
            }
            HealthConnectClient.SDK_UNAVAILABLE_PROVIDER_UPDATE_REQUIRED -> {
                hcText.text = "Health Connect needs an update."; hcButton.text = "Update Health Connect"; syncButton.isEnabled = false
            }
            else -> { hcText.text = "Health Connect isn't available on this phone."; hcButton.visibility = View.GONE; syncButton.isEnabled = false }
        }
    }

    private fun scaleStatus(): String {
        val fmt = DateFormat.getDateTimeInstance(DateFormat.SHORT, DateFormat.SHORT)
        val lines = mutableListOf<String>()
        lines += store.lastWeighIn?.let { "Last weigh-in: $it" + (store.lastWeighInState?.let { st -> "\n($st)" } ?: "") } ?: "No weigh-ins yet."
        lines += if (!store.scaleAuto) "Background listening is off (saves battery)." + (store.scanProblem?.let { "\n⚠ Last try: $it" } ?: "") else ScaleListener.problem(this)?.let { "⚠ $it" } ?: "Listening for the scale in the background."
        lines += if (store.lastHeardAt > 0) "Last heard the scale: ${fmt.format(Date(store.lastHeardAt))} (${store.lastHeard})" else "Haven't heard the scale yet."
        store.scaleAddress?.let { lines += "Scale: $it" }
        return lines.joinToString("\n")
    }

    private fun ignoringBatteryOptimizations() =
        (getSystemService(POWER_SERVICE) as PowerManager).isIgnoringBatteryOptimizations(packageName)

    @SuppressLint("BatteryLife")
    private fun askBatteryExemption() {
        val intents = listOf(
            Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:$packageName")),
            Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:$packageName")),
        )
        for (i in intents) {
            try { startActivity(i); return } catch (e: Exception) {}
        }
        toast("Open Settings › Apps › CWA Health › Battery and choose Unrestricted.")
    }

    // ---------- Health Connect ----------
    private fun requestHealthPermissions() {
        if (HealthSync.sdkStatus(this) == HealthConnectClient.SDK_UNAVAILABLE_PROVIDER_UPDATE_REQUIRED) {
            startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("market://details?id=${HealthSync.PROVIDER}&url=healthconnect%3A%2F%2Fonboarding")))
            return
        }
        try { hcPermissionRequest.launch(HealthSync.PERMISSIONS) } catch (e: Exception) { toast("Couldn't open Health Connect: ${e.message}") }
    }

    private fun openHealthConnect() {
        val actions = listOf("android.health.connect.action.HEALTH_HOME_SETTINGS", HealthConnectClient.ACTION_HEALTH_CONNECT_SETTINGS)
        for (a in actions) {
            try { startActivity(Intent(a)); return } catch (e: Exception) {}
        }
        toast("Couldn't open Health Connect.")
    }

    private fun syncNow(quiet: Boolean = false) {
        if (!store.linked) { if (!quiet) toast("Link the app from CWA first."); return }
        syncButton.isEnabled = false
        syncText.text = "Syncing…"
        lifecycleScope.launch {
            try {
                val n = HealthSync.syncToCloud(this@MainActivity, if (store.firstSyncDone) 7 else 30)
                if (!quiet) toast("Synced $n days to CWA")
            } catch (e: Exception) {
                store.lastError = e.message ?: e.toString()
            }
            refresh()
        }
    }

    // ---------- scale ----------
    private fun needBluetooth(then: () -> Unit) {
        if (ScaleListener.hasPermission(this)) { then(); return }
        afterBtPermission = then
        val perms = mutableListOf(if (Build.VERSION.SDK_INT >= 31) Manifest.permission.BLUETOOTH_SCAN else Manifest.permission.ACCESS_FINE_LOCATION)
        if (Build.VERSION.SDK_INT >= 33) perms += Manifest.permission.POST_NOTIFICATIONS
        btPermissionRequest.launch(perms.toTypedArray())
    }

    private fun setAuto(on: Boolean) {
        if (!on) { store.scaleAuto = false; store.scanProblem = null; ScaleListener.stop(this); refresh(); return }
        needBluetooth {
            store.scaleAuto = true
            val problem = ScaleListener.start(this)
            toast(problem ?: "Listening for the scale in the background.")
            if (problem != null) store.scaleAuto = false
            refresh()
        }
        if (!ScaleListener.hasPermission(this)) autoSwitch.isChecked = false
    }

    @SuppressLint("MissingPermission")
    private fun startWeighIn() {
        if (!store.linked) { toast("Link the app from CWA first."); return }
        needBluetooth {
            val adapter = (getSystemService(BLUETOOTH_SERVICE) as? BluetoothManager)?.adapter
            if (adapter == null || !adapter.isEnabled) { scaleText.text = "Turn on Bluetooth first."; return@needBluetooth }
            val scanner = adapter.bluetoothLeScanner ?: return@needBluetooth
            val cb = object : ScanCallback() {
                override fun onScanResult(callbackType: Int, result: ScanResult) { runOnUiThread { onScale(result) } }
                override fun onBatchScanResults(results: MutableList<ScanResult>) { runOnUiThread { results.forEach { onScale(it) } } }
                override fun onScanFailed(errorCode: Int) { runOnUiThread { stopWeighIn("Bluetooth scan failed ($errorCode).") } }
            }
            // A weigh-in from earlier that's still waiting: save it before starting a new one.
            WeighInWorker.saveIfDone(this, WeighIns.flushStale(this))
            scanCallback = cb
            scanner.startScan(MiScale.filters(null), ScanSettings.Builder().setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY).build(), cb)
            weightText.text = "— kg"
            scaleText.text = "Step on the scale…"
            weighButton.text = "Stop"
            handler.postDelayed(timeout, 90_000)
        }
    }

    private val timeout = Runnable { stopWeighIn("No weigh-in heard. Tap the scale to wake it and try again.") }

    private fun onScale(res: ScanResult) {
        if (scanCallback == null) return
        val r = MiScale.parse(res.scanRecord?.serviceData, res.device.address, ScaleListener.seenAt(res)) ?: return
        store.heard(r)
        when (val out = WeighIns.onPacket(store, r)) {
            is WeighIns.Result.Done -> saved(out.weighIn)
            is WeighIns.Result.Measuring -> {
                weightText.text = "%.1f kg".format(out.kg)
                scaleText.text = if (out.stable) "Hold still — measuring body composition…" else "Measuring…"
            }
            is WeighIns.Result.Skipped -> scaleText.text = out.reason
            // Already saved (by the background listener, which hears the same packets).
            WeighIns.Result.Ignore -> if (r.stable && store.doneAt > 0 && abs(r.seenAt - store.doneAt) < 120_000 && abs(r.kg - store.doneKg) < 1.0) {
                weightText.text = "%.1f kg".format(store.doneKg)
                stopWeighIn("Saved ✓")
            }
        }
    }

    private fun saved(w: WeighIn) {
        WeighInWorker.enqueue(this, w)
        weightText.text = "%.1f kg".format(w.kg)
        stopWeighIn(if (w.impedance != null) "Saved with body composition ✓" else "Saved ✓ (no body composition: stand barefoot)")
        if (store.scaleAuto) ScaleListener.start(this)
    }

    @SuppressLint("MissingPermission")
    private fun stopWeighIn(message: String) {
        handler.removeCallbacks(timeout)
        val cb = scanCallback ?: return
        scanCallback = null
        try { (getSystemService(BLUETOOTH_SERVICE) as? BluetoothManager)?.adapter?.bluetoothLeScanner?.stopScan(cb) } catch (e: Exception) {}
        weighButton.text = "Weigh in now"
        // A stable weight without impedance (socks) that never saw the step-off packet.
        val flushed = WeighIns.flushStale(this, force = true)
        if (flushed is WeighIns.Result.Done) { saved(flushed.weighIn); return }
        if (message.isNotEmpty()) scaleText.text = message
    }

    private fun openCwa() {
        startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("https://alterrion-git.github.io/")))
    }

    private fun toast(msg: String) = Toast.makeText(this, msg, Toast.LENGTH_LONG).show()
}
