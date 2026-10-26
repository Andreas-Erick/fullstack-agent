package com.nexusagent.android.wear;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.Typeface;
import android.os.Bundle;
import android.speech.RecognizerIntent;
import android.speech.tts.TextToSpeech;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.HapticFeedbackConstants;
import android.view.View;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Locale;
import java.util.UUID;

/**
 * Siren on the wrist: tap her to ask by voice; the question goes through the phone to the computer and
 * the answer is spoken (with the watch's voice) and shown. Below: Today (schedule and habits) and a
 * new chat. Turn the bezel or swipe to scroll a long answer. Laid out for round screens: content stays
 * inside the middle of the circle.
 */
public class WatchActivity extends Activity {
    private static final int ASK = 1;
    private static final long REPLY_TIMEOUT_MS = 200_000; // the phone waits up to 180 s for the computer

    private Link link;
    private SirenRing ring;
    private TextView status;
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
        tts = new TextToSpeech(this, (code) -> {
            ttsReady = code == TextToSpeech.SUCCESS;
            if (ttsReady) tts.setLanguage(Locale.getDefault());
        });
        setContentView(build());
    }

    private View build() {
        int pad = (int) (getResources().getDisplayMetrics().widthPixels * 0.13f); // stay inside the circle
        LinearLayout col = new LinearLayout(this);
        col.setOrientation(LinearLayout.VERTICAL);
        col.setGravity(Gravity.CENTER_HORIZONTAL);
        col.setPadding(pad, pad / 2, pad, pad);

        ring = new SirenRing(this);
        int size = (int) (getResources().getDisplayMetrics().widthPixels * 0.42f);
        ring.setLayoutParams(new LinearLayout.LayoutParams(size, size));
        ring.setClickable(true);
        ring.setOnClickListener((v) -> ask());
        col.addView(ring);

        status = text(getString(R.string.tap_to_ask), 13, getColor(R.color.accent));
        status.setTypeface(Typeface.DEFAULT_BOLD);
        status.setLetterSpacing(0.08f);
        col.addView(status);
        question = text("", 13, getColor(R.color.muted));
        col.addView(question);
        answer = text("", 15, getColor(R.color.text));
        answer.setLineSpacing(0, 1.15f);
        col.addView(answer);

        LinearLayout row = new LinearLayout(this);
        row.setGravity(Gravity.CENTER);
        row.setPadding(0, dp(10), 0, 0);
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
        scroll.setBackgroundColor(getColor(R.color.bg));
        scroll.addView(col, new ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        scroll.setFocusable(true); // the rotating bezel scrolls the focused view
        return scroll;
    }

    @Override
    protected void onResume() {
        super.onResume();
        link.start();
        scroll.requestFocus();
    }

    @Override
    protected void onPause() {
        link.stop();
        if (busy) {
            busy = false;
            ring.setState(SirenRing.State.IDLE);
            status.setText(getString(R.string.tap_to_ask));
        }
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        tts.shutdown();
        super.onDestroy();
    }

    // ------------------------------------------------------------ asking
    private void ask() {
        if (busy) return;
        ring.performHapticFeedback(HapticFeedbackConstants.CONFIRM);
        if (tts.isSpeaking()) tts.stop();
        Intent i = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
                .putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
                .putExtra(RecognizerIntent.EXTRA_PROMPT, getString(R.string.ask_prompt));
        try {
            ring.setState(SirenRing.State.LISTENING);
            status.setText(getString(R.string.listening));
            startActivityForResult(i, ASK);
        } catch (ActivityNotFoundException e) {
            ring.setState(SirenRing.State.IDLE);
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
            ring.setState(SirenRing.State.IDLE);
            status.setText(getString(R.string.tap_to_ask));
            return;
        }
        send(heard.get(0).trim());
    }

    private void send(String text) {
        busy = true;
        question.setText("“" + text + "”");
        answer.setText("");
        ring.setState(SirenRing.State.THINKING);
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
                ring.setState(SirenRing.State.IDLE);
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

    private void speak(String text) {
        if (!ttsReady || text.isEmpty()) {
            ring.setState(SirenRing.State.IDLE);
            status.setText(getString(R.string.tap_to_ask));
            return;
        }
        ring.setState(SirenRing.State.SPEAKING);
        status.setText(getString(R.string.app_name).toUpperCase(Locale.ROOT));
        tts.setOnUtteranceProgressListener(new android.speech.tts.UtteranceProgressListener() {
            @Override
            public void onStart(String id) {}

            @Override
            public void onDone(String id) {
                runOnUiThread(() -> {
                    ring.setState(SirenRing.State.IDLE);
                    status.setText(getString(R.string.tap_to_ask));
                });
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
        b.setTextColor(getColor(R.color.text));
        b.setBackgroundColor(Color.argb(40, 45, 212, 191));
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, dp(40));
        lp.setMargins(dp(3), 0, dp(3), 0);
        b.setLayoutParams(lp);
        b.setMinWidth(0);
        b.setPadding(dp(12), 0, dp(12), 0);
        return b;
    }

    private int dp(int v) {
        return (int) (v * getResources().getDisplayMetrics().density);
    }
}
