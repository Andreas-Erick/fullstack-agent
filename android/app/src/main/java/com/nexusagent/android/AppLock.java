package com.nexusagent.android;

import android.app.Activity;
import android.app.KeyguardManager;
import android.content.Context;
import android.content.Intent;
import android.hardware.biometrics.BiometricManager;
import android.hardware.biometrics.BiometricPrompt;
import android.os.Build;
import android.os.CancellationSignal;

/**
 * The app lock (menu → "Lock Siren with fingerprint, face or screen lock"): the phone's own unlock
 * (biometrics or the screen PIN / pattern / password) before the conversations show. Uses only the
 * Android framework: BiometricPrompt on Android 9+, the screen-lock confirmation before that. Without a
 * screen lock on the phone there is nothing to check against, so the lock can't be turned on.
 */
final class AppLock {
    static final int REQ_CONFIRM = 7;
    /** Away from the app longer than this, it locks again. */
    static final long RELOCK_MS = 30_000;

    private AppLock() {}

    static boolean available(Context c) {
        KeyguardManager km = c.getSystemService(KeyguardManager.class);
        return km != null && km.isDeviceSecure();
    }

    interface Result {
        void done(boolean ok);
    }

    /**
     * Asks for the phone's unlock. On Android 8 the answer arrives in the activity's onActivityResult
     * (request REQ_CONFIRM); the caller forwards it to {@code result}.
     */
    @SuppressWarnings("deprecation")
    static void authenticate(Activity a, String title, Result result) {
        if (!available(a)) {
            result.done(false);
            return;
        }
        if (Build.VERSION.SDK_INT >= 28) {
            BiometricPrompt.Builder b = new BiometricPrompt.Builder(a).setTitle(title).setSubtitle(a.getString(R.string.lock_subtitle));
            if (Build.VERSION.SDK_INT >= 30) b.setAllowedAuthenticators(BiometricManager.Authenticators.BIOMETRIC_STRONG | BiometricManager.Authenticators.DEVICE_CREDENTIAL);
            else b.setDeviceCredentialAllowed(true);
            b.build().authenticate(new CancellationSignal(), a.getMainExecutor(), new BiometricPrompt.AuthenticationCallback() {
                @Override
                public void onAuthenticationSucceeded(BiometricPrompt.AuthenticationResult r) {
                    result.done(true);
                }

                @Override
                public void onAuthenticationError(int code, CharSequence msg) {
                    result.done(false);
                }
            });
            return;
        }
        Intent i = a.getSystemService(KeyguardManager.class).createConfirmDeviceCredentialIntent(title, a.getString(R.string.lock_subtitle));
        if (i == null) result.done(false);
        else a.startActivityForResult(i, REQ_CONFIRM);
    }
}
