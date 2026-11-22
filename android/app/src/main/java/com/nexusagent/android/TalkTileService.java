package com.nexusagent.android;

import android.app.PendingIntent;
import android.content.Intent;
import android.os.Build;
import android.service.quicksettings.TileService;

/** Quick Settings tile "Talk to Siren": opens the app and starts listening (tap the mic to send). */
public class TalkTileService extends TileService {
    @Override
    @SuppressWarnings("deprecation")
    public void onClick() {
        Intent i = MainActivity.talkIntent(this);
        if (Build.VERSION.SDK_INT >= 34) startActivityAndCollapse(PendingIntent.getActivity(this, 0, i, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT));
        else startActivityAndCollapse(i);
    }
}
