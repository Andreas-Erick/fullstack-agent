package com.nexusagent.android;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import android.webkit.CookieManager;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.HashSet;
import java.util.Set;

/**
 * Optional (the "notifications when closed" switch): keeps the event stream from the desktop open
 * while the app is closed, and shows approvals (with Allow / Deny) and replies to messages sent from
 * this phone. Runs as a foreground service with a visible "Connected" notification that can turn it off.
 * Nothing goes through a push service: the connection is straight to the user's own desktop.
 */
public class ConnectionService extends Service {
    static final String CH_STATUS = "status";
    static final String CH_ALERTS = "alerts";
    private static final int ID_STATUS = 1;
    private static final String ACTION_STOP = "com.nexusagent.android.STOP";
    /**
     * Without a connection for this long (the computer is off, the phone left the network), the service
     * stops quietly instead of showing "Reconnecting…" all day. It starts again the next time the app
     * opens (MainActivity.onResume): the switch stays on.
     */
    private static final long GIVE_UP_MS = 10 * 60 * 1000;

    private volatile boolean running;
    private volatile HttpURLConnection conn;
    private Thread thread;
    private final Set<String> myTurns = new HashSet<>(); // requestIds of turns started on this phone

    static void start(Context c) {
        if (Prefs.token(c) == null || Prefs.server(c) == null) return;
        Intent i = new Intent(c, ConnectionService.class);
        if (Build.VERSION.SDK_INT >= 26) c.startForegroundService(i);
        else c.startService(i);
    }

    static void stop(Context c) {
        c.stopService(new Intent(c, ConnectionService.class));
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onCreate() {
        super.onCreate();
        NotificationManager nm = getSystemService(NotificationManager.class);
        NotificationChannel status = new NotificationChannel(CH_STATUS, getString(R.string.ch_status), NotificationManager.IMPORTANCE_MIN);
        status.setShowBadge(false);
        nm.createNotificationChannel(status);
        nm.createNotificationChannel(new NotificationChannel(CH_ALERTS, getString(R.string.ch_alerts), NotificationManager.IMPORTANCE_HIGH));
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_STOP.equals(intent.getAction())) {
            Prefs.setBackground(this, false);
            stopSelf();
            return START_NOT_STICKY;
        }
        Notification n = statusNotification(getString(R.string.status_connecting));
        if (Build.VERSION.SDK_INT >= 34) startForeground(ID_STATUS, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING);
        else startForeground(ID_STATUS, n);
        if (!Prefs.background(this) || Prefs.token(this) == null) {
            stopSelf();
            return START_NOT_STICKY;
        }
        if (thread == null) {
            running = true;
            thread = new Thread(this::loop, "nexus-events");
            thread.start();
        }
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        running = false;
        HttpURLConnection c = conn;
        if (c != null) c.disconnect();
        if (thread != null) thread.interrupt();
        super.onDestroy();
    }

    // ------------------------------------------------------------ stream
    private void loop() {
        long delay = 1000;
        long lastConnected = System.currentTimeMillis();
        while (running) {
            String server = Prefs.server(this);
            String token = Prefs.token(this);
            if (server == null || token == null) break;
            try {
                HttpURLConnection c = open(server + "/api/events", token);
                conn = c;
                int code = c.getResponseCode();
                if (code == 401) {
                    if (!running) break; // stopped meanwhile (e.g. moving to the secure address)
                    Prefs.setToken(this, null, null);
                    Prefs.setBackground(this, false);
                    alert(2, getString(R.string.app_name), getString(R.string.unpaired), null);
                    break;
                }
                if (code != 200) throw new Exception("HTTP " + code);
                status(getString(R.string.status_connected));
                delay = 1000;
                lastConnected = System.currentTimeMillis();
                read(c);
                lastConnected = System.currentTimeMillis();
            } catch (Exception e) {
                if (!running) break;
                // Out of reach for a while: stop quietly (no notification) until the app is opened again.
                if (System.currentTimeMillis() - lastConnected > GIVE_UP_MS) break;
                status(getString(R.string.status_reconnecting));
            }
            try {
                Thread.sleep(delay);
            } catch (InterruptedException e) {
                break;
            }
            delay = Math.min(30000, delay * 2);
        }
        running = false;
        stopSelf();
    }

    /** A request to the desktop with the device token, and the Cloudflare Access cookie if signed in. */
    static HttpURLConnection open(String url, String token) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setConnectTimeout(15000);
        c.setReadTimeout(70000); // the server pings every 25 s
        c.setRequestProperty("Authorization", "Bearer " + token);
        c.setRequestProperty("Accept", "text/event-stream");
        try {
            String cookie = CookieManager.getInstance().getCookie(url);
            if (cookie != null) c.setRequestProperty("Cookie", cookie);
        } catch (Exception ignored) {
            // no WebView cookies (yet)
        }
        return c;
    }

    private void read(HttpURLConnection c) throws Exception {
        try (BufferedReader r = new BufferedReader(new InputStreamReader(c.getInputStream(), StandardCharsets.UTF_8))) {
            String event = "message";
            StringBuilder data = new StringBuilder();
            String line;
            while (running && (line = r.readLine()) != null) {
                if (line.isEmpty()) {
                    if (data.length() > 0) dispatch(event, data.toString());
                    event = "message";
                    data.setLength(0);
                } else if (line.startsWith("event: ")) event = line.substring(7);
                else if (line.startsWith("data: ")) data.append(line.substring(6));
            }
        }
    }

    private void dispatch(String event, String data) {
        try {
            JSONObject p = new JSONObject(data);
            if (event.equals("approval.request")) onApproval(p);
            else if (event.equals("approval.cancel")) cancel(notifId(p.optString("id")));
            else if (event.equals("chat.event")) onChat(p);
            // The persona, its look or its face changed on the computer: a paired watch gets the new one.
            else if (event.equals("info.changed")) WearRelayService.refreshLook(this);
        } catch (Exception ignored) {
            // a malformed event is skipped
        }
    }

    private void onApproval(JSONObject a) {
        if (MainActivity.foreground) return; // the page shows its own card
        String id = a.optString("id");
        int nid = notifId(id);
        String title = a.optString("title", getString(R.string.approval_title));
        String detail = a.optString("detail", "");
        Notification.Builder b = alertBuilder(getString(R.string.approval_title) + ": " + title, detail.length() > 300 ? detail.substring(0, 300) + "…" : detail)
                .setCategory(Notification.CATEGORY_REMINDER)
                .setOnlyAlertOnce(true) // open approvals are replayed after a reconnect
                .addAction(action(R.string.action_deny, ApprovalReceiver.intent(this, id, false, nid), nid * 2))
                // Allow on the phone only once it is unlocked: a locked phone in someone else's hand can't say yes.
                .addAction(action(R.string.action_allow, ApprovalReceiver.intent(this, id, true, nid), nid * 2 + 1, true))
                // On a paired watch (locked by its own PIN once off the wrist) both answers work right away.
                .extend(new Notification.WearableExtender()
                        .addAction(action(R.string.action_deny, ApprovalReceiver.intent(this, id, false, nid), nid * 2))
                        .addAction(action(R.string.action_allow, ApprovalReceiver.intent(this, id, true, nid), nid * 2 + 1)));
        if (a.optInt("timeoutSec", 0) > 0) b.setTimeoutAfter(a.optInt("timeoutSec") * 1000L);
        getSystemService(NotificationManager.class).notify(nid, b.build());
    }

    private void onChat(JSONObject ev) {
        String type = ev.optString("type");
        String requestId = ev.optString("requestId");
        if (type.equals("start")) {
            JSONObject user = ev.optJSONObject("userMessage");
            String mine = Prefs.deviceName(this);
            if (user != null && !mine.isEmpty() && mine.equals(user.optString("remote"))) myTurns.add(requestId);
            return;
        }
        if (!type.equals("done") && !type.equals("error")) return;
        if (!myTurns.remove(requestId) || MainActivity.foreground) return;
        JSONObject m = ev.optJSONObject("message");
        String text = type.equals("error") ? ev.optString("message") : m == null ? "" : plain(m.optString("content"));
        alert(notifId(requestId), getString(R.string.reply_title), text.length() > 400 ? text.substring(0, 400) + "…" : text, null);
    }

    // ------------------------------------------------------------ notifications
    private Notification statusNotification(String text) {
        Intent stop = new Intent(this, ConnectionService.class).setAction(ACTION_STOP);
        return new Notification.Builder(this, CH_STATUS)
                .setSmallIcon(R.drawable.ic_stat)
                .setContentTitle(getString(R.string.app_name))
                .setContentText(text)
                .setOngoing(true)
                .setOnlyAlertOnce(true) // its text changes (connected, reconnecting) without a new alert
                .setContentIntent(openApp(0))
                .addAction(new Notification.Action.Builder(null, getString(R.string.action_disconnect), PendingIntent.getService(this, 1, stop, PendingIntent.FLAG_IMMUTABLE)).build())
                .build();
    }

    private void status(String text) {
        getSystemService(NotificationManager.class).notify(ID_STATUS, statusNotification(text));
    }

    private Notification.Builder alertBuilder(String title, String text) {
        // The lock screen shows only that something came in; what it says needs the phone unlocked.
        Notification hidden = new Notification.Builder(this, CH_ALERTS)
                .setSmallIcon(R.drawable.ic_stat)
                .setContentTitle(getString(R.string.app_name))
                .setContentText(getString(R.string.locked_alert))
                .build();
        return new Notification.Builder(this, CH_ALERTS)
                .setSmallIcon(R.drawable.ic_stat)
                .setContentTitle(title)
                .setContentText(text)
                .setStyle(new Notification.BigTextStyle().bigText(text))
                .setVisibility(Notification.VISIBILITY_PRIVATE)
                .setPublicVersion(hidden)
                .setAutoCancel(true)
                .setContentIntent(openApp(1));
    }

    private void alert(int id, String title, String text, Notification.Action action) {
        Notification.Builder b = alertBuilder(title, text);
        if (action != null) b.addAction(action);
        getSystemService(NotificationManager.class).notify(id, b.build());
    }

    private void cancel(int id) {
        getSystemService(NotificationManager.class).cancel(id);
    }

    private Notification.Action action(int label, Intent intent, int requestCode) {
        return action(label, intent, requestCode, false);
    }

    private Notification.Action action(int label, Intent intent, int requestCode, boolean unlocked) {
        PendingIntent pi = PendingIntent.getBroadcast(this, requestCode, intent, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Notification.Action.Builder b = new Notification.Action.Builder(null, getString(label), pi);
        if (unlocked && Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) b.setAuthenticationRequired(true);
        return b.build();
    }

    private PendingIntent openApp(int requestCode) {
        Intent i = new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        return PendingIntent.getActivity(this, requestCode, i, PendingIntent.FLAG_IMMUTABLE);
    }

    static int notifId(String key) {
        return 1000 + (key.hashCode() & 0x3fffffff) % 1000000;
    }

    /** Markdown to plain text for a notification. */
    private static String plain(String md) {
        return md.replaceAll("```[\\s\\S]*?```", " ")
                .replaceAll("`([^`]+)`", "$1")
                .replaceAll("\\[([^\\]]+)\\]\\([^)]*\\)", "$1")
                .replaceAll("[*_~>#|]+", "")
                .replaceAll("\\s+", " ")
                .trim();
    }
}
