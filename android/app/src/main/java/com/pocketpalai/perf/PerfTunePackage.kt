package com.pocketpal.perf

import com.facebook.react.TurboReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.module.model.ReactModuleInfo
import com.facebook.react.module.model.ReactModuleInfoProvider
import com.pocketpal.specs.NativePerfTuneSpec

class PerfTunePackage : TurboReactPackage() {
  override fun getModule(
      name: String,
      reactContext: ReactApplicationContext,
  ): NativeModule? {
    return if (name == NativePerfTuneSpec.NAME) {
      PerfTuneModule(reactContext)
    } else {
      null
    }
  }

  override fun getReactModuleInfoProvider(): ReactModuleInfoProvider {
    return ReactModuleInfoProvider {
      mapOf(
          NativePerfTuneSpec.NAME to
              ReactModuleInfo(
                  NativePerfTuneSpec.NAME,
                  NativePerfTuneSpec.NAME,
                  false, // canOverrideExistingModule
                  false, // needsEagerInit
                  true, // hasConstants
                  false, // isCxxModule
                  true, // isTurboModule
              ),
      )
    }
  }
}
