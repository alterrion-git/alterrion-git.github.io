package com.alt.work.health

import android.content.Context
import android.content.SharedPreferences

/**
 * Everything the app remembers, in its private storage:
 *  - the CWA account it uploads to (set by the link from CWA: Health tab › Link app),
 *  - the Firebase sign-in (refresh token → short-lived ID tokens),
 *  - sync and scale state.
 */
class Store(context: Context) : ScaleState {
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
    /** Optional always-on background listening for the scale (off by default: battery). A new
     *  key, so earlier versions' "on" doesn't carry over. */
    var scaleAuto: Boolean get() = p.getBoolean("scaleListen", false); set(v) = p.edit().putBoolean("scaleListen", v).apply()
    /** Why the background listener couldn't start last time (null when it started). */
    var scanProblem: String? get() = str("scanProblem"); set(v) = putStr("scanProblem", v)
    override var scaleAddress: String? get() = str("scaleAddr"); set(v) = putStr("scaleAddr", v)
    /** Last weight we know (from CWA or the scale), to skip other people's weigh-ins. 0 = unknown. */
    override var lastWeight: Float get() = p.getFloat("lastWeight", 0f); set(v) = p.edit().putFloat("lastWeight", v).apply()
    override var onlyMyWeight: Boolean get() = p.getBoolean("onlyMine", true); set(v) = p.edit().putBoolean("onlyMine", v).apply()
    /** The last weigh-in ("81.2 kg · 16/10/26 7:42") and how its upload went. */
    var lastWeighIn: String? get() = str("lastWeighIn"); set(v) = putStr("lastWeighIn", v)
    var lastWeighInState: String? get() = str("lastWeighInState"); set(v) = putStr("lastWeighInState", v)
    var lastWeighInAt: Long get() = p.getLong("lastWeighInAt", 0); set(v) = p.edit().putLong("lastWeighInAt", v).apply()
    /** The last packet heard from the scale, to tell "never heard it" from "heard it, didn't save". */
    var lastHeard: String? get() = str("lastHeard"); set(v) = putStr("lastHeard", v)
    var lastHeardAt: Long get() = p.getLong("lastHeardAt", 0); set(v) = p.edit().putLong("lastHeardAt", v).apply()

    fun heard(r: ScaleReading) {
        lastHeardAt = r.seenAt
        lastHeard = "%.1f kg, ".format(r.kg) + when {
            r.removed && r.stable -> "result after stepping off"
            r.removed -> "stepped off"
            r.impedance != null -> "stable, with body composition"
            r.stable -> "stable"
            else -> "measuring"
        }
    }

    // Weigh-in in progress and recently saved ones (see WeighIns).
    override var pendingKey: String? get() = str("pendingKey"); set(v) = putStr("pendingKey", v)
    override var pendingKg: Float get() = p.getFloat("pendingKg", 0f); set(v) = p.edit().putFloat("pendingKg", v).apply()
    override var pendingAt: Long get() = p.getLong("pendingAt", 0); set(v) = p.edit().putLong("pendingAt", v).apply()
    override var pendingLastAt: Long get() = p.getLong("pendingLastAt", 0); set(v) = p.edit().putLong("pendingLastAt", v).apply()
    override var pendingAddr: String? get() = str("pendingAddr"); set(v) = putStr("pendingAddr", v)
    override var doneKeys: String? get() = str("doneKeys"); set(v) = putStr("doneKeys", v)
    override var doneAt: Long get() = p.getLong("doneAt", 0); set(v) = p.edit().putLong("doneAt", v).apply()
    override var doneKg: Float get() = p.getFloat("doneKg", 0f); set(v) = p.edit().putFloat("doneKg", v).apply()
    override var doneImp: Boolean get() = p.getBoolean("doneImp", false); set(v) = p.edit().putBoolean("doneImp", v).apply()
}
