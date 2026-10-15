package com.alt.work.health

import android.content.Context
import android.content.SharedPreferences

/**
 * Everything the app remembers, in its private storage:
 *  - the CWA account it uploads to (set by the link from CWA: Profile › Health › Link Android app),
 *  - the Firebase sign-in (refresh token → short-lived ID tokens),
 *  - sync and scale state.
 */
class Store(context: Context) {
    private val p: SharedPreferences = context.applicationContext.getSharedPreferences("cwa", Context.MODE_PRIVATE)

    private fun str(key: String) = p.getString(key, null)
    private fun putStr(key: String, value: String?) = p.edit().apply { if (value == null) remove(key) else putString(key, value) }.apply()

    // Account link.
    var dbUrl: String? get() = str("db"); set(v) = putStr("db", v)
    var uid: String? get() = str("uid"); set(v) = putStr("uid", v)
    var apiKey: String? get() = str("apiKey"); set(v) = putStr("apiKey", v)
    var email: String? get() = str("email"); set(v) = putStr("email", v)
    /** Firebase refresh token; null for the old username accounts (no sign-in). */
    var refreshToken: String? get() = str("rt"); set(v) = putStr("rt", v)
    var idToken: String? get() = str("idToken"); set(v) = putStr("idToken", v)
    var idTokenExpires: Long get() = p.getLong("idTokenExp", 0); set(v) = p.edit().putLong("idTokenExp", v).apply()

    val linked: Boolean get() = !dbUrl.isNullOrEmpty() && !uid.isNullOrEmpty()

    fun unlink() {
        p.edit().remove("db").remove("uid").remove("apiKey").remove("email").remove("rt").remove("idToken").remove("idTokenExp").apply()
    }

    // Health Connect sync.
    var lastSync: Long get() = p.getLong("lastSync", 0); set(v) = p.edit().putLong("lastSync", v).apply()
    var lastSyncDays: Int get() = p.getInt("lastSyncDays", 0); set(v) = p.edit().putInt("lastSyncDays", v).apply()
    var lastError: String? get() = str("lastError"); set(v) = putStr("lastError", v)
    var firstSyncDone: Boolean get() = p.getBoolean("firstSync", false); set(v) = p.edit().putBoolean("firstSync", v).apply()

    // Scale.
    var scaleAuto: Boolean get() = p.getBoolean("scaleAuto", false); set(v) = p.edit().putBoolean("scaleAuto", v).apply()
    var scaleAddress: String? get() = str("scaleAddr"); set(v) = putStr("scaleAddr", v)
    /** Last weight we know (from CWA or the scale), to skip other people's weigh-ins. 0 = unknown. */
    var lastWeight: Float get() = p.getFloat("lastWeight", 0f); set(v) = p.edit().putFloat("lastWeight", v).apply()
    var onlyMyWeight: Boolean get() = p.getBoolean("onlyMine", true); set(v) = p.edit().putBoolean("onlyMine", v).apply()
    var lastWeighIn: String? get() = str("lastWeighIn"); set(v) = putStr("lastWeighIn", v)

    // Weigh-in in progress (a stable weight seen, waiting for the impedance reading or step-off).
    var pendingKey: String? get() = str("pendingKey"); set(v) = putStr("pendingKey", v)
    var pendingKg: Float get() = p.getFloat("pendingKg", 0f); set(v) = p.edit().putFloat("pendingKg", v).apply()
    var pendingAt: Long get() = p.getLong("pendingAt", 0); set(v) = p.edit().putLong("pendingAt", v).apply()
    var pendingMeasuredAt: Long get() = p.getLong("pendingMeasuredAt", 0); set(v) = p.edit().putLong("pendingMeasuredAt", v).apply()
    var doneKey: String? get() = str("doneKey"); set(v) = putStr("doneKey", v)
}
