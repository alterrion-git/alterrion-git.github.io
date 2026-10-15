package com.alt.work.health

import android.content.Context
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder

/**
 * Writes to the CWA account in Firebase Realtime Database over its REST API — the same data the
 * web app reads. Signed-in (Firebase Auth) accounts use a fresh ID token minted from the refresh
 * token the web app handed over; old username accounts write without one, like the web app.
 *
 * Only ever writes under users/<uid>/health/…, so it can't clash with what the web app saves.
 */
class Cloud(context: Context) {
    private val store = Store(context)

    private fun http(url: String, method: String, body: String?, contentType: String = "application/json"): Pair<Int, String> {
        val conn = (URL(url).openConnection() as HttpURLConnection).apply {
            requestMethod = method
            connectTimeout = 15_000
            readTimeout = 20_000
            // Same origin as the web app, so the token refresh keeps working if the Firebase API
            // key is restricted to the site (Google Cloud › Credentials › HTTP referrers).
            setRequestProperty("Referer", "https://alterrion-git.github.io/")
            if (body != null) {
                doOutput = true
                setRequestProperty("Content-Type", contentType)
            }
        }
        try {
            if (body != null) conn.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
            val code = conn.responseCode
            val text = (if (code in 200..299) conn.inputStream else conn.errorStream)?.bufferedReader()?.use { it.readText() } ?: ""
            return code to text
        } finally {
            conn.disconnect()
        }
    }

    /** A valid Firebase ID token, or null for accounts that don't sign in. */
    private fun idToken(forceRefresh: Boolean = false): String? {
        val rt = store.refreshToken ?: return null
        val cached = store.idToken
        if (!forceRefresh && cached != null && store.idTokenExpires > System.currentTimeMillis() + 60_000) return cached
        val key = store.apiKey ?: throw IOException("Missing API key — link the app again from CWA.")
        val (code, text) = http(
            "https://securetoken.googleapis.com/v1/token?key=" + URLEncoder.encode(key, "UTF-8"),
            "POST",
            "grant_type=refresh_token&refresh_token=" + URLEncoder.encode(rt, "UTF-8"),
            "application/x-www-form-urlencoded",
        )
        if (code !in 200..299) {
            throw IOException(if (code == 400) "Sign-in expired — link the app again from CWA (Profile › Health)." else "Sign-in failed ($code)")
        }
        val j = JSONObject(text)
        val token = j.getString("id_token")
        store.idToken = token
        store.refreshToken = j.optString("refresh_token", rt).ifEmpty { rt }
        store.idTokenExpires = System.currentTimeMillis() + (j.optString("expires_in", "3600").toLongOrNull() ?: 3600L) * 1000
        return token
    }

    /** PUT JSON at users/<uid>/<path>. */
    suspend fun put(path: String, value: JSONObject) = withContext(Dispatchers.IO) {
        val db = store.dbUrl?.trimEnd('/') ?: throw IOException("Not linked to a CWA account yet.")
        val uid = store.uid ?: throw IOException("Not linked to a CWA account yet.")
        fun url(token: String?) = "$db/users/$uid/$path.json" + (if (token != null) "?auth=" + URLEncoder.encode(token, "UTF-8") else "")
        var (code, text) = http(url(idToken()), "PUT", value.toString())
        if (code == 401 && store.refreshToken != null) { // token revoked/expired early: refresh once
            val retry = http(url(idToken(forceRefresh = true)), "PUT", value.toString())
            code = retry.first; text = retry.second
        }
        if (code !in 200..299) throw IOException("Upload failed ($code): ${text.take(120)}")
    }
}
