package com.nexusagent.android.wear;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.Rect;
import android.os.Handler;
import android.os.Looper;
import android.view.View;

import org.json.JSONObject;

import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * The persona's face on the watch: the desktop records it (built-in or custom, in its theme) as a short
 * loop per agent state (main/facecapture.js, a "SRF1" pack); this view plays the loop of the current
 * state in a circle. Only the current state's frames are decoded (a few MB); the rest stay as JPEG.
 */
public class FacePlayer extends View {
    private final Map<String, List<byte[]>> packed = new HashMap<>();
    private final ExecutorService decoder = Executors.newSingleThreadExecutor();
    private final Handler main = new Handler(Looper.getMainLooper());
    private final Paint paint = new Paint(Paint.FILTER_BITMAP_FLAG | Paint.ANTI_ALIAS_FLAG);
    private final Path clip = new Path();
    private final Rect dst = new Rect();
    private Bitmap[] frames = new Bitmap[0];
    private String state = "idle";
    private int fps = 12;
    private long start = System.currentTimeMillis();
    private int generation;

    public FacePlayer(Context c) {
        super(c);
    }

    boolean hasFace() {
        return !packed.isEmpty();
    }

    /** Reads a pack; false if it isn't one (then the view keeps what it had). */
    boolean load(byte[] pack) {
        try {
            ByteBuffer b = ByteBuffer.wrap(pack);
            byte[] magic = new byte[4];
            b.get(magic);
            if (!"SRF1".equals(new String(magic, StandardCharsets.US_ASCII))) return false;
            byte[] head = new byte[b.getInt()];
            b.get(head);
            JSONObject header = new JSONObject(new String(head, StandardCharsets.UTF_8));
            JSONObject states = header.getJSONObject("states");
            Map<String, List<byte[]>> out = new HashMap<>();
            for (Iterator<String> it = states.keys(); it.hasNext(); ) {
                String s = it.next();
                int n = Math.min(states.getInt(s), 120);
                List<byte[]> list = new ArrayList<>(n);
                for (int i = 0; i < n; i++) {
                    byte[] f = new byte[b.getInt()];
                    b.get(f);
                    list.add(f);
                }
                out.put(s, list);
            }
            packed.clear();
            packed.putAll(out);
            fps = Math.max(4, Math.min(30, header.optInt("fps", 12)));
            decode(state);
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    /** idle | listening | thinking | working | speaking | happy | sleeping */
    void setState(String s) {
        if (s.equals(state) && frames.length > 0) return;
        state = s;
        decode(s);
    }

    private void decode(String s) {
        List<byte[]> list = packed.containsKey(s) ? packed.get(s) : packed.get("idle");
        if (list == null) return;
        int gen = ++generation;
        decoder.execute(() -> {
            BitmapFactory.Options o = new BitmapFactory.Options();
            o.inPreferredConfig = Bitmap.Config.RGB_565; // half the memory; the frames are JPEG anyway
            Bitmap[] out = new Bitmap[list.size()];
            for (int i = 0; i < out.length; i++) out[i] = BitmapFactory.decodeByteArray(list.get(i), 0, list.get(i).length, o);
            main.post(() -> {
                if (gen != generation) return;
                frames = out;
                start = System.currentTimeMillis();
                invalidate();
            });
        });
    }

    @Override
    protected void onDraw(Canvas c) {
        if (frames.length == 0) return;
        int i = (int) (((System.currentTimeMillis() - start) * fps / 1000) % frames.length);
        Bitmap f = frames[i];
        int w = getWidth();
        int h = getHeight();
        int size = Math.min(w, h);
        dst.set((w - size) / 2, (h - size) / 2, (w + size) / 2, (h + size) / 2);
        clip.reset();
        clip.addCircle(w / 2f, h / 2f, size / 2f, Path.Direction.CW);
        c.save();
        c.clipPath(clip);
        if (f != null) c.drawBitmap(f, null, dst, paint);
        c.restore();
        postInvalidateDelayed(1000 / fps);
    }

    @Override
    protected void onDetachedFromWindow() {
        decoder.shutdownNow();
        super.onDetachedFromWindow();
    }
}
