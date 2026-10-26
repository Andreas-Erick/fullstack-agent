package com.nexusagent.android;

import com.google.android.gms.wearable.MessageEvent;
import com.google.android.gms.wearable.Wearable;
import com.google.android.gms.wearable.WearableListenerService;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.nio.charset.StandardCharsets;

/**
 * The phone's side of the Galaxy Watch app (android/wear): the watch can't reach the computer by
 * itself (no Tailscale on a watch), so it asks this phone over Bluetooth (Google's Wear Data Layer)
 * and the phone forwards each request to the desktop with its own pairing, like the phone app does.
 *
 * Messages from the watch (path, JSON body):
 *   /siren/ask   {id, text}           → a turn in the watch's conversation, spoken style; answers
 *                                        /siren/reply {id, text} or {id, error} when it is done
 *   /siren/today {}                   → /siren/today with the desktop's /api/data/today
 *   /siren/habit {name, done}         → checks a habit off; answers /siren/today
 *   /siren/new   {}                   → the next question starts a new conversation
 * Every answer also carries "status": ok | unpaired | offline, so the watch can say what to do.
 * Only the watch app with this app's package name and signing key can send these (Data Layer rule).
 */
public class WearRelayService extends WearableListenerService {
    private static final long TURN_TIMEOUT_MS = 180_000;

    @Override
    public void onMessageReceived(MessageEvent ev) {
        String path = ev.getPath();
        String node = ev.getSourceNodeId();
        JSONObject in;
        try {
            in = new JSONObject(new String(ev.getData(), StandardCharsets.UTF_8));
        } catch (Exception e) {
            in = new JSONObject();
        }
        final JSONObject body = in;
        // The listener runs on the main thread; network work goes to a thread of its own.
        new Thread(() -> handle(path, node, body), "siren-wear").start();
    }

    private void handle(String path, String node, JSONObject in) {
        String server = Prefs.server(this);
        String token = Prefs.token(this);
        if (server == null || token == null) {
            reply(node, path.equals("/siren/ask") ? "/siren/reply" : path, put(new JSONObject(), "id", in.optString("id")), "unpaired");
            return;
        }
        try {
            switch (path) {
                case "/siren/ask":
                    reply(node, "/siren/reply", ask(server, token, in), "ok");
                    break;
                case "/siren/today":
                    reply(node, "/siren/today", get(server + "/api/data/today", token), "ok");
                    break;
                case "/siren/habit":
                    post(server + "/api/data/habits/log", token, new JSONObject().put("name", in.optString("name")).put("done", in.optBoolean("done", true)));
                    reply(node, "/siren/today", get(server + "/api/data/today", token), "ok");
                    break;
                case "/siren/new":
                    Prefs.setWatchConversation(this, null);
                    reply(node, "/siren/new", new JSONObject(), "ok");
                    break;
                default:
                    break;
            }
        } catch (Unpaired e) {
            reply(node, path.equals("/siren/ask") ? "/siren/reply" : path, put(new JSONObject(), "id", in.optString("id")), "unpaired");
        } catch (Exception e) {
            JSONObject out = put(new JSONObject(), "id", in.optString("id"));
            put(out, "error", e.getMessage() == null ? "No connection to the computer" : e.getMessage());
            reply(node, path.equals("/siren/ask") ? "/siren/reply" : path, out, "offline");
        }
    }

    /**
     * One turn: listen to the desktop's event stream first (so the reply can't be missed), send the
     * question, then wait for that turn's "done" (or "error") event.
     */
    private JSONObject ask(String server, String token, JSONObject in) throws Exception {
        String text = in.optString("text").trim();
        if (text.isEmpty()) throw new Exception("Nothing was heard");
        HttpURLConnection events = ConnectionService.open(server + "/api/events", token);
        events.setReadTimeout(60_000);
        try {
            int code = events.getResponseCode();
            if (code == 401) throw new Unpaired();
            if (code != 200) throw new Exception("The computer answered " + code);
            JSONObject req = new JSONObject().put("text", text).put("voice", true).put("via", "watch");
            String conv = Prefs.watchConversation(this);
            if (conv != null) req.put("conversationId", conv);
            JSONObject started;
            try {
                started = post(server + "/api/chat", token, req);
            } catch (NotFound e) {
                // The watch's conversation was deleted on the computer: start a new one.
                req.remove("conversationId");
                started = post(server + "/api/chat", token, req);
            }
            Prefs.setWatchConversation(this, started.optString("conversationId", null));
            String requestId = started.optString("requestId");
            long until = System.currentTimeMillis() + TURN_TIMEOUT_MS;
            try (BufferedReader r = new BufferedReader(new InputStreamReader(events.getInputStream(), StandardCharsets.UTF_8))) {
                String event = "message";
                StringBuilder data = new StringBuilder();
                String line;
                while (System.currentTimeMillis() < until && (line = r.readLine()) != null) {
                    if (line.isEmpty()) {
                        if (event.equals("chat.event") && data.length() > 0) {
                            JSONObject ev = new JSONObject(data.toString());
                            if (requestId.equals(ev.optString("requestId"))) {
                                String type = ev.optString("type");
                                if (type.equals("done")) {
                                    JSONObject m = ev.optJSONObject("message");
                                    return new JSONObject().put("id", in.optString("id")).put("text", m == null ? "" : plain(m.optString("content")));
                                }
                                if (type.equals("error") || type.equals("aborted")) throw new Exception(ev.optString("message", "The reply was stopped"));
                            }
                        }
                        event = "message";
                        data.setLength(0);
                    } else if (line.startsWith("event: ")) event = line.substring(7);
                    else if (line.startsWith("data: ")) data.append(line.substring(6));
                }
            }
            throw new Exception("No reply within three minutes");
        } finally {
            events.disconnect();
        }
    }

    // ------------------------------------------------------------ HTTP
    private static JSONObject get(String url, String token) throws Exception {
        HttpURLConnection c = ConnectionService.open(url, token);
        c.setRequestProperty("Accept", "application/json");
        c.setReadTimeout(20_000);
        return read(c);
    }

    private static JSONObject post(String url, String token, JSONObject body) throws Exception {
        HttpURLConnection c = ConnectionService.open(url, token);
        c.setRequestMethod("POST");
        c.setRequestProperty("Accept", "application/json");
        c.setRequestProperty("Content-Type", "application/json");
        c.setReadTimeout(20_000);
        c.setDoOutput(true);
        try (OutputStream o = c.getOutputStream()) {
            o.write(body.toString().getBytes(StandardCharsets.UTF_8));
        }
        return read(c);
    }

    private static JSONObject read(HttpURLConnection c) throws Exception {
        try {
            int code = c.getResponseCode();
            if (code == 401) throw new Unpaired();
            if (code == 404) throw new NotFound();
            boolean ok = code >= 200 && code < 300;
            StringBuilder s = new StringBuilder();
            try (BufferedReader r = new BufferedReader(new InputStreamReader(ok ? c.getInputStream() : c.getErrorStream(), StandardCharsets.UTF_8))) {
                String line;
                while ((line = r.readLine()) != null) s.append(line);
            }
            JSONObject j = s.length() > 0 ? new JSONObject(s.toString()) : new JSONObject();
            if (!ok) throw new Exception(j.optString("error", "The computer answered " + code));
            return j;
        } finally {
            c.disconnect();
        }
    }

    // ------------------------------------------------------------ to the watch
    private void reply(String node, String path, JSONObject body, String status) {
        put(body, "status", status);
        Wearable.getMessageClient(this).sendMessage(node, path, body.toString().getBytes(StandardCharsets.UTF_8));
    }

    private static JSONObject put(JSONObject o, String k, Object v) {
        try {
            o.put(k, v);
        } catch (Exception ignored) {
            // keys are fixed strings
        }
        return o;
    }

    /** Markdown to plain text for the watch's small screen and its voice. */
    static String plain(String md) {
        return md.replaceAll("```[\\s\\S]*?```", " ")
                .replaceAll("`([^`]+)`", "$1")
                .replaceAll("\\[([^\\]]+)\\]\\([^)]*\\)", "$1")
                .replaceAll("(?m)^>.*$", "")
                .replaceAll("[*_~#|]+", "")
                .replaceAll("[ \\t]+", " ")
                .replaceAll("\\n{3,}", "\n\n")
                .trim();
    }

    private static final class Unpaired extends Exception {}

    private static final class NotFound extends Exception {}
}
