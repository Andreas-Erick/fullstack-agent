package com.nexusagent.android;

import android.app.NotificationManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.nio.charset.StandardCharsets;

/** Allow / Deny on an approval notification: answers the desktop without opening the app. */
public class ApprovalReceiver extends BroadcastReceiver {
    private static final String EXTRA_ID = "id";
    private static final String EXTRA_ALLOW = "allow";
    private static final String EXTRA_NOTIF = "notif";

    static Intent intent(Context c, String approvalId, boolean allow, int notifId) {
        return new Intent(c, ApprovalReceiver.class)
                .putExtra(EXTRA_ID, approvalId)
                .putExtra(EXTRA_ALLOW, allow)
                .putExtra(EXTRA_NOTIF, notifId);
    }

    @Override
    public void onReceive(Context context, Intent intent) {
        String id = intent.getStringExtra(EXTRA_ID);
        boolean allow = intent.getBooleanExtra(EXTRA_ALLOW, false);
        int notif = intent.getIntExtra(EXTRA_NOTIF, 0);
        Context app = context.getApplicationContext();
        app.getSystemService(NotificationManager.class).cancel(notif);
        if (id == null || !id.matches("[\\w-]+")) return;
        PendingResult result = goAsync();
        new Thread(() -> {
            try {
                String server = Prefs.server(app);
                String token = Prefs.token(app);
                if (server == null || token == null) return;
                HttpURLConnection c = ConnectionService.open(server + "/api/approvals/" + id, token);
                c.setRequestMethod("POST");
                c.setDoOutput(true);
                c.setRequestProperty("Content-Type", "application/json");
                try (OutputStream out = c.getOutputStream()) {
                    out.write(("{\"allow\":" + allow + "}").getBytes(StandardCharsets.UTF_8));
                }
                c.getResponseCode(); // 404 = already answered on the desktop or timed out
                c.disconnect();
            } catch (Exception ignored) {
                // the approval times out on the desktop and counts as no
            } finally {
                result.finish();
            }
        }, "nexus-approval").start();
    }
}
