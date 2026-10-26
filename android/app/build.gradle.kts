// The Android app for Nexus Agent (docs/ROADMAP-mobile.md, step 4): a locked-down WebView around the
// phone client the desktop serves, plus notifications, a push-to-talk tile and the share sheet.
// Only the Android framework, plus Google's Wear Data Layer (play-services-wearable) so the Galaxy
// Watch app (android/wear) can ask through this phone.
plugins {
    id("com.android.application")
}

// Release signing comes from the environment (the release workflow sets these from repository
// secrets); without NEXUS_KEYSTORE the release APK is left unsigned. Never commit a keystore.
val keystore: String? = System.getenv("NEXUS_KEYSTORE")

android {
    namespace = "com.nexusagent.android"
    compileSdk = 37

    defaultConfig {
        applicationId = "com.nexusagent.android"
        minSdk = 26
        targetSdk = 36
        versionCode = System.getenv("NEXUS_VERSION_CODE")?.toIntOrNull() ?: 1
        versionName = System.getenv("NEXUS_VERSION") ?: "0.1.0"
    }

    signingConfigs {
        if (keystore != null) {
            create("release") {
                storeFile = file(keystore)
                storePassword = System.getenv("NEXUS_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("NEXUS_KEY_ALIAS")
                keyPassword = System.getenv("NEXUS_KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            if (keystore != null) signingConfig = signingConfigs.getByName("release")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

dependencies {
    implementation("com.google.android.gms:play-services-wearable:20.0.1")
}
