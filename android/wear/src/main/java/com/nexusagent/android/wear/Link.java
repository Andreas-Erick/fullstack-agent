package com.nexusagent.android.wear;

import android.content.Context;
import android.os.Handler;
import android.os.Looper;

import com.google.android.gms.wearable.CapabilityClient;
import com.google.android.gms.wearable.CapabilityInfo;
import com.google.android.gms.wearable.MessageClient;
import com.google.android.gms.wearable.Node;
import com.google.android.gms.wearable.Wearable;

import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;
import java.util.function.Consumer;

/**
 * The watch's line to the Siren phone app (its WearRelayService): find the phone that has the
 * "siren_relay" capability, send a request, and get the answer back on the main thread. Each request
 * waits for one answer on its reply path; a request without an answer in time fails with "timeout".
 */
final class Link {
    static final String CAPABILITY = "siren_relay";

    /** What came back: the JSON answer, or why there is none. */
    static final class Result {
        final JSONObject body; // null on failure
        final String problem; // null | no_phone | no_relay | unpaired | offline | timeout
        final String error; // a readable reason from the computer, for offline

        Result(JSONObject body, String problem, String error) {
            this.body = body;
            this.problem = problem;
            this.error = error;
        }
    }

    private final Context context;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final Map<String, Consumer<Result>> waiting = new HashMap<>();
    private final MessageClient.OnMessageReceivedListener listener = (ev) -> {
        JSONObject body;
        try {
            body = new JSONObject(new String(ev.getData(), StandardCharsets.UTF_8));
        } catch (Exception e) {
            return;
        }
        String key = ev.getPath() + "#" + body.optString("id");
        Consumer<Result> cb = waiting.remove(key);
        if (cb == null) cb = waiting.remove(ev.getPath() + "#");
        if (cb == null) return;
        String status = body.optString("status", "ok");
        Consumer<Result> done = cb;
        main.post(() -> done.accept(status.equals("ok") ? new Result(body, null, null) : new Result(null, status, body.optString("error", null))));
    };

    Link(Context context) {
        this.context = context.getApplicationContext();
    }

    void start() {
        Wearable.getMessageClient(context).addListener(listener);
    }

    void stop() {
        Wearable.getMessageClient(context).removeListener(listener);
        waiting.clear();
    }

    /**
     * Sends {@code body} to {@code path} and calls {@code onResult} once with the answer on
     * {@code replyPath} (matched by the body's "id", if it has one).
     */
    void request(String path, String replyPath, JSONObject body, long timeoutMs, Consumer<Result> onResult) {
        String key = replyPath + "#" + body.optString("id");
        waiting.put(key, onResult);
        main.postDelayed(() -> {
            Consumer<Result> cb = waiting.remove(key);
            if (cb != null) cb.accept(new Result(null, "timeout", null));
        }, timeoutMs);
        Wearable.getCapabilityClient(context).getCapability(CAPABILITY, CapabilityClient.FILTER_REACHABLE)
                .addOnSuccessListener((CapabilityInfo info) -> {
                    Node phone = pick(info);
                    if (phone == null) {
                        fail(key, info.getNodes().isEmpty() ? "no_relay" : "no_phone");
                        return;
                    }
                    Wearable.getMessageClient(context).sendMessage(phone.getId(), path, body.toString().getBytes(StandardCharsets.UTF_8))
                            .addOnFailureListener((e) -> fail(key, "no_phone"));
                })
                .addOnFailureListener((e) -> fail(key, "no_phone"));
    }

    private void fail(String key, String problem) {
        Consumer<Result> cb = waiting.remove(key);
        if (cb != null) main.post(() -> cb.accept(new Result(null, problem, null)));
    }

    /** The nearby phone with the relay (Bluetooth first), else any reachable one. */
    private static Node pick(CapabilityInfo info) {
        Node any = null;
        for (Node n : info.getNodes()) {
            if (n.isNearby()) return n;
            any = n;
        }
        return any;
    }
}
