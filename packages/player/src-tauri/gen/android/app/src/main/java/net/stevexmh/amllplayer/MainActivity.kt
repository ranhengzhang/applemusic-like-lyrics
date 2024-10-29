package net.stevexmh.amllplayer

import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.provider.Settings
import android.view.WindowManager
import androidx.appcompat.app.AlertDialog
import androidx.core.view.WindowCompat

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    WindowCompat.setDecorFitsSystemWindows(window, false)
    if (Build.VERSION.SDK_INT >= 30) {
      if (!Environment.isExternalStorageManager()) {
        AlertDialog.Builder(this).setTitle(R.string.all_files_access_required_title)
          .setMessage(R.string.all_files_access_required_text)
          .setPositiveButton(R.string.all_files_access_required_go_to_setting) { _, _ ->
            startActivity(Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION))
          }.setNegativeButton(R.string.all_files_access_required_ignore) { _, _ ->

          }.setCancelable(true).create().show()
      }
    }
    window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
  }
}