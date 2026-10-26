package com.nexusagent.android.wear;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.Typeface;
import android.media.MediaPlayer;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.speech.RecognizerIntent;
import android.speech.tts.TextToSpeech;
import android.util.Log;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.HapticFeedbackConstants;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import com.google.android.gms.wearable.Asset;
import com.google.android.gms.wearable.ChannelClient;
import com.google.android.gms.wearable.DataClient;
import com.google.android.gms.wearable.DataEvent;
import com.google.android.gms.wearable.DataItem;
import com.google.android.gms.wearable.DataMap;
import com.google.android.gms.wearable.DataMapItem;
import com.google.android.gms.wearable.Wearable;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.Locale;
import java.util.UUID;

/**
 * Siren on the wrist: tap her to ask by voice; the question goes through the phone to the computer and
 * the answer is spoken and shown. Below: Today (schedule and habits) and a new chat. Turn the bezel or
 * swipe to scroll a long answer. Laid out for round screens: content stays inside the middle of the
 * circle.
 * The active persona comes from the desktop through the phone: its name and colors (data item
 * /siren/look), its face as recorded loops (/siren/face, FacePlayer; until one arrives, SirenRing) and
 * its voice (/siren/speak, the audio over a channel; the watch's own voice when the computer has none).
 */
public class WatchActivity extends Activity {
    private static final int ASK = 1;
    private static final long REPLY_TIMEOUT_MS = 200_000; // the phone waits up to 180 s for the computer
    private static final long VOICE_TIMEOUT_MS = 60_000;
    private static final int MAX_AUDIO = 12 * 1024 * 1024;

    private Link link;
    private SirenRing ring;
    private FacePlayer face;
    private LinearLayout col;
    private final java.util.List<Button> buttons = new ArrayList<>();
    private final Handler main = new Handler(Looper.getMainLooper());
    private String name = "";
    private int accent;
    private int textColor;
    private int muted;
    private int bg;
    private String voiceId; // the reply waiting for the persona's voice
    private String voiceText;
    private MediaPlayer player;
    private TextView status;
    private TextView faceNote; // while her face is on its way, or why it isn't (small, under the face)
    private boolean faceRequested;
    private static final String TAG = "SirenWatch";
    private TextView question;
    private TextView answer;
    private ScrollView scroll;
    private TextToSpeech tts;
    private boolean ttsReady;
    private boolean busy;

    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        link = new Link(this);
        Look look = Look.of(this);
        accent = look.accent;
        textColor = look.text;
        muted = look.muted;
        bg = look.bg;
        tts = new TextToSpeech(this, (code) -> {
            ttsReady = code == TextToSpeech.SUCCESS;
            if (ttsReady) tts.setLanguage(Locale.getDefault());
        });
        setContentView(build());
    }

    private View build() {
        int pad = (int) (getResources().getDisplayMetrics().widthPixels * 0.13f); // stay inside the circle
        col = new LinearLayout(this);
        col.setOrientation(LinearLayout.VERTICAL);
        col.setGravity(Gravity.CENTER_HORIZONTAL);
        col.setPadding(pad, pad / 2, pad, pad);

        // The persona's face (once the phone has brought it) over the built-in ring.
        int size = (int) (getResources().getDisplayMetrics().widthPixels * 0.56f);
        FrameLayout stage = new FrameLayout(this);
        stage.setLayoutParams(new LinearLayout.LayoutParams(size, size));
        ring = new SirenRing(this);
        face = new FacePlayer(this);
        face.setVisibility(View.GONE);
        stage.addView(ring, new FrameLayout.LayoutParams(size, size));
        stage.addView(face, new FrameLayout.LayoutParams(size, size));
        stage.setClickable(true);
        stage.setDefaultFocusHighlightEnabled(false); // no square around the round face
        stage.setOnClickListener((v) -> ask());
        stage.setContentDescription(getString(R.string.tap_to_ask));
        col.addView(stage);

        faceNote = text("", 11, muted);
        faceNote.setVisibility(View.GONE);
        col.addView(faceNote);
        status = text(getString(R.string.tap_to_ask), 13, accent);
        status.setTypeface(Typeface.DEFAULT_BOLD);
        status.setLetterSpacing(0.08f);
        col.addView(status);
        question = text("", 13, muted);
        col.addView(question);
        answer = text("", 15, textColor);
        answer.setLineSpacing(0, 1.15f);
        col.addView(answer);

        // One under the other: side by side they would reach the round edge.
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.VERTICAL);
        row.setGravity(Gravity.CENTER_HORIZONTAL);
        row.setPadding(0, dp(10), 0, dp(24));
        Button today = button(getString(R.string.today));
        today.setOnClickListener((v) -> startActivity(new Intent(this, TodayActivity.class)));
        Button fresh = button(getString(R.string.new_chat));
        fresh.setOnClickListener((v) -> link.request("/siren/new", "/siren/new", new JSONObject(), 10_000, (r) -> {
            if (r.body != null) {
                question.setText("");
                answer.setText(getString(R.string.new_chat_done));
            }
        }));
        row.addView(today);
        row.addView(fresh);
        col.addView(row);

        scroll = new ScrollView(this);
        scroll.setFillViewport(true);
        scroll.setBackgroundColor(bg);
        scroll.addView(col, new ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        scroll.setFocusable(true); // the rotating bezel scrolls the focused view
        return scroll;
    }

    @Override
    protected void onResume() {
        super.onResume();
        link.start();
        scroll.requestFocus();
        Wearable.getDataClient(this).addListener(dataListener);
        Wearable.getChannelClient(this).registerChannelCallback(voiceChannel);
        // What the watch already has, at once; then ask the phone for anything newer.
        Wearable.getDataClient(this).getDataItems(Uri.parse("wear://*/siren/look")).addOnSuccessListener((items) -> {
            for (DataItem i : items) applyLook(DataMapItem.fromDataItem(i).getDataMap());
            items.release();
        });
        readFaceItem();
        // Ask the phone for anything newer. The first time, the computer records her face (it usually has
        // it ready); the screen stays on meanwhile, since the watch loads it only while Siren is open.
        if (!face.hasFace()) {
            setFaceNote(getString(R.string.face_coming));
            getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        }
        faceRequested = true;
        link.request("/siren/face", "/siren/face", new JSONObject(), 120_000, (r) -> {
            faceRequested = false;
            getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            Log.i(TAG, "face request answered: " + (r.body != null ? r.body.toString() : r.problem + " " + r.error));
            if (r.body != null) {
                readFaceItem(); // in case the change arrived before the listener saw it
                if (!face.hasFace()) main.postDelayed(this::readFaceItem, 4000);
            } else if (!face.hasFace()) {
                setFaceNote(getString(R.string.face_failed) + " " + problem(r));
            }
        });
    }

    private void readFaceItem() {
        Wearable.getDataClient(this).getDataItems(Uri.parse("wear://*/siren/face")).addOnSuccessListener((items) -> {
            Log.i(TAG, "face items on the watch: " + items.getCount());
            for (DataItem i : items) loadFace(DataMapItem.fromDataItem(i).getDataMap());
            items.release();
        }).addOnFailureListener((e) -> Log.w(TAG, "reading the face item failed", e));
    }

    private void setFaceNote(String s) {
        faceNote.setText(s);
        faceNote.setVisibility(s.isEmpty() ? View.GONE : View.VISIBLE);
    }

    private final DataClient.OnDataChangedListener dataListener = (events) -> {
        for (DataEvent e : events) {
            if (e.getType() != DataEvent.TYPE_CHANGED) continue;
            String path = e.getDataItem().getUri().getPath();
            DataMap map = DataMapItem.fromDataItem(e.getDataItem()).getDataMap();
            if ("/siren/look".equals(path)) applyLook(map);
            else if ("/siren/face".equals(path)) loadFace(map);
        }
    };

    /** The persona's name and colors (the desktop theme), on this screen and remembered for Today. */
    private void applyLook(DataMap map) {
        name = map.getString("name", "");
        try {
            JSONObject c = new JSONObject(map.getString("colors", "{}"));
            bg = color(c, "bg", getColor(R.color.bg));
            accent = color(c, "accent", getColor(R.color.accent));
            textColor = color(c, "text", getColor(R.color.text));
            muted = color(c, "muted", getColor(R.color.muted));
            scroll.setBackgroundColor(bg);
            Look.save(this, bg, accent, textColor, muted);
        } catch (Exception ignored) {
            // keep the built-in colors
        }
        status.setTextColor(accent);
        question.setTextColor(muted);
        answer.setTextColor(textColor);
        for (Button b : buttons) styleButton(b);
        if (!busy) status.setText(idleLabel());
    }

    private static int color(JSONObject c, String key, int fallback) {
        String v = c.optString(key);
        if (!v.matches("#[0-9a-fA-F]{6}")) return fallback;
        return Color.parseColor(v);
    }

    private void loadFace(DataMap map) {
        Asset pack = map.getAsset("pack");
        if (pack == null) {
            Log.w(TAG, "face item without a pack");
            return;
        }
        Wearable.getDataClient(this).getFdForAsset(pack).addOnSuccessListener((fd) -> new Thread(() -> {
            byte[] bytes;
            try (InputStream in = fd.getInputStream()) {
                bytes = readAll(in, 8 * 1024 * 1024);
            } catch (Exception e) {
                Log.w(TAG, "reading the face pack failed", e);
                main.post(() -> setFaceNote(getString(R.string.face_failed)));
                return;
            }
            main.post(() -> {
                boolean ok = face.load(bytes);
                Log.i(TAG, "face pack " + bytes.length + " bytes, " + (ok ? "playing" : "not a face pack"));
                if (ok) {
                    face.setVisibility(View.VISIBLE);
                    ring.setVisibility(View.INVISIBLE);
                    setFaceNote("");
                } else {
                    setFaceNote(getString(R.string.face_failed));
                }
            });
        }, "siren-face").start()).addOnFailureListener((e) -> {
            Log.w(TAG, "getting the face pack from the phone failed", e);
            setFaceNote(getString(R.string.face_failed));
        });
    }

    private String idleLabel() {
        return getString(R.string.tap_to_ask);
    }

    /** Both faces follow the agent's state (the ring knows four of them). */
    private void setState(String s) {
        face.setState(s);
        switch (s) {
            case "listening":
                ring.setState(SirenRing.State.LISTENING);
                break;
            case "thinking":
            case "working":
                ring.setState(SirenRing.State.THINKING);
                break;
            case "speaking":
                ring.setState(SirenRing.State.SPEAKING);
                break;
            default:
                ring.setState(SirenRing.State.IDLE);
        }
    }

    // A reply in the persona's voice arrives as a channel from the phone (WearRelayService.speak).
    private final ChannelClient.ChannelCallback voiceChannel = new ChannelClient.ChannelCallback() {
        @Override
        public void onChannelOpened(ChannelClient.Channel ch) {
            String id = voiceId;
            if (id == null || !ch.getPath().equals("/siren/voice/" + id)) {
                Wearable.getChannelClient(WatchActivity.this).close(ch);
                return;
            }
            Wearable.getChannelClient(WatchActivity.this).getInputStream(ch).addOnSuccessListener((in) -> new Thread(() -> {
                try {
                    byte[] audio = readAll(in, MAX_AUDIO);
                    File f = new File(getCacheDir(), "reply.audio");
                    try (FileOutputStream o = new FileOutputStream(f)) {
                        o.write(audio);
                    }
                    main.post(() -> play(id, f));
                } catch (Exception e) {
                    main.post(() -> fallbackVoice(id));
                } finally {
                    Wearable.getChannelClient(WatchActivity.this).close(ch);
                }
            }, "siren-voice").start());
        }
    };

    private static byte[] readAll(InputStream in, int max) throws Exception {
        try (InputStream s = in) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[16 * 1024];
            int n;
            while ((n = s.read(buf)) > 0) {
                out.write(buf, 0, n);
                if (out.size() > max) throw new Exception("Too large");
            }
            return out.toByteArray();
        }
    }

    @Override
    protected void onPause() {
        link.stop();
        Wearable.getDataClient(this).removeListener(dataListener);
        getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        Wearable.getChannelClient(this).unregisterChannelCallback(voiceChannel);
        voiceId = null;
        stopPlayer();
        if (busy) {
            busy = false;
            setState("idle");
            status.setText(idleLabel());
        }
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        tts.shutdown();
        stopPlayer();
        super.onDestroy();
    }

    // ------------------------------------------------------------ asking
    private void ask() {
        if (busy) return;
        ring.performHapticFeedback(HapticFeedbackConstants.CONFIRM);
        if (tts.isSpeaking()) tts.stop();
        voiceId = null;
        stopPlayer();
        Intent i = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
                .putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
                .putExtra(RecognizerIntent.EXTRA_PROMPT, getString(R.string.ask_prompt));
        try {
            setState("listening");
            status.setText(getString(R.string.listening));
            startActivityForResult(i, ASK);
        } catch (ActivityNotFoundException e) {
            setState("idle");
            status.setText(getString(R.string.tap_to_ask));
            answer.setText(getString(R.string.no_speech));
        }
    }

    @Override
    protected void onActivityResult(int request, int result, Intent data) {
        super.onActivityResult(request, result, data);
        if (request != ASK) return;
        ArrayList<String> heard = data == null ? null : data.getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS);
        if (result != RESULT_OK || heard == null || heard.isEmpty() || heard.get(0).trim().isEmpty()) {
            setState("idle");
            status.setText(getString(R.string.tap_to_ask));
            return;
        }
        send(heard.get(0).trim());
    }

    private void send(String text) {
        busy = true;
        question.setText("“" + text + "”");
        answer.setText("");
        setState("thinking");
        status.setText(getString(R.string.thinking));
        JSONObject body = new JSONObject();
        try {
            body.put("id", UUID.randomUUID().toString()).put("text", text);
        } catch (Exception ignored) {
            // fixed keys
        }
        link.request("/siren/ask", "/siren/reply", body, REPLY_TIMEOUT_MS, (r) -> {
            busy = false;
            if (r.body == null) {
                setState("idle");
                status.setText(getString(R.string.tap_to_ask));
                answer.setText(problem(r));
                ring.performHapticFeedback(HapticFeedbackConstants.REJECT);
                return;
            }
            String reply = r.body.optString("text");
            answer.setText(reply);
            scroll.post(() -> scroll.smoothScrollTo(0, question.getTop()));
            speak(reply);
        });
    }

    /** The persona's voice from the computer; the watch's own if it has none or doesn't answer in time. */
    private void speak(String text) {
        if (text.isEmpty()) {
            done();
            return;
        }
        String id = UUID.randomUUID().toString();
        voiceId = id;
        voiceText = text;
        setState("speaking");
        status.setText(speakingLabel());
        JSONObject body = new JSONObject();
        try {
            body.put("id", id).put("text", text);
        } catch (Exception ignored) {
            // fixed keys
        }
        link.request("/siren/speak", "/siren/speak", body, VOICE_TIMEOUT_MS, (r) -> {
            if (r.body == null) fallbackVoice(id); // no voice on the computer, or no answer in time
        });
    }

    private void play(String id, File f) {
        if (!id.equals(voiceId)) return;
        voiceId = null;
        stopPlayer();
        try {
            player = new MediaPlayer();
            player.setDataSource(f.getPath());
            player.setOnCompletionListener((mp) -> done());
            player.setOnErrorListener((mp, what, extra) -> {
                speakOnWatch(voiceText);
                return true;
            });
            player.prepare();
            player.start();
        } catch (Exception e) {
            speakOnWatch(voiceText);
        }
    }

    private void stopPlayer() {
        if (player == null) return;
        try {
            player.release();
        } catch (Exception ignored) {
            // already released
        }
        player = null;
    }

    private void fallbackVoice(String id) {
        if (!id.equals(voiceId)) return;
        voiceId = null;
        speakOnWatch(voiceText);
    }

    /** A moment of "happy" after a reply, then idle (as on the desktop). */
    private void done() {
        setState("happy");
        status.setText(idleLabel());
        main.postDelayed(() -> {
            if (!busy && voiceId == null && (player == null || !player.isPlaying())) setState("idle");
        }, 2200);
    }

    private String speakingLabel() {
        return (name.isEmpty() ? getString(R.string.app_name) : name).toUpperCase(Locale.ROOT);
    }

    private void speakOnWatch(String text) {
        if (!ttsReady || text == null || text.isEmpty()) {
            done();
            return;
        }
        setState("speaking");
        status.setText(speakingLabel());
        tts.setOnUtteranceProgressListener(new android.speech.tts.UtteranceProgressListener() {
            @Override
            public void onStart(String id) {}

            @Override
            public void onDone(String id) {
                runOnUiThread(() -> done());
            }

            @Override
            public void onError(String id) {
                onDone(id);
            }
        });
        tts.speak(text, TextToSpeech.QUEUE_FLUSH, null, "reply");
    }

    private String problem(Link.Result r) {
        switch (r.problem == null ? "" : r.problem) {
            case "no_relay":
                return getString(R.string.no_relay);
            case "unpaired":
                return getString(R.string.unpaired);
            case "timeout":
                return getString(R.string.timeout);
            case "offline":
                return r.error != null ? r.error : getString(R.string.timeout);
            default:
                return getString(R.string.no_phone);
        }
    }

    // ------------------------------------------------------------ views
    private TextView text(String s, int sp, int color) {
        TextView t = new TextView(this);
        t.setText(s);
        t.setTextSize(TypedValue.COMPLEX_UNIT_SP, sp);
        t.setTextColor(color);
        t.setGravity(Gravity.CENTER);
        t.setPadding(0, dp(4), 0, 0);
        return t;
    }

    private Button button(String s) {
        Button b = new Button(this);
        b.setText(s);
        b.setAllCaps(false);
        b.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
        buttons.add(b);
        styleButton(b);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams((int) (getResources().getDisplayMetrics().widthPixels * 0.5f), dp(40));
        lp.setMargins(0, dp(4), 0, 0);
        b.setLayoutParams(lp);
        b.setMinWidth(0);
        b.setPadding(dp(12), 0, dp(12), 0);
        return b;
    }

    private void styleButton(Button b) {
        b.setTextColor(textColor);
        android.graphics.drawable.GradientDrawable pill = new android.graphics.drawable.GradientDrawable();
        pill.setCornerRadius(dp(20));
        pill.setColor(Color.argb(46, Color.red(accent), Color.green(accent), Color.blue(accent)));
        b.setBackground(pill);
    }

    private int dp(int v) {
        return (int) (v * getResources().getDisplayMetrics().density);
    }
}
