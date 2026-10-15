package com.alt.work.health

import android.os.Bundle
import android.widget.ScrollView
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat

/** Shown by Health Connect as this app's privacy policy / permission rationale. */
class PrivacyActivity : AppCompatActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val pad = (20 * resources.displayMetrics.density).toInt()
        val tv = TextView(this).apply {
            setPadding(pad, pad, pad, pad)
            textSize = 15f
            setTextColor(ContextCompat.getColor(this@PrivacyActivity, R.color.text))
            text = """
                CWA Health — privacy

                What it reads: from Health Connect, only what you allow — steps, distance, calories burned, floors, heart rate, resting heart rate, heart rate variability, blood oxygen, sleep, weight, body fat and workouts. From your Xiaomi scale, the weight and impedance it broadcasts over Bluetooth.

                What it does with it: it adds up one summary per day and uploads it, with your weigh-ins, to your own CWA account (the same Firebase database the CWA app uses), so CWA and its AI coach can show and use it. Nothing is sent anywhere else, sold or shared, and the app shows no ads.

                What it never does: it doesn't write to Health Connect, doesn't use your location, and doesn't read anything you haven't allowed.

                Stop at any time: remove its access in Health Connect, turn off automatic weigh-ins, or uninstall the app. Data already in your CWA account stays there until you delete it in CWA.
            """.trimIndent()
        }
        setContentView(ScrollView(this).apply { setBackgroundColor(ContextCompat.getColor(this@PrivacyActivity, R.color.bg)); addView(tv) })
    }
}
