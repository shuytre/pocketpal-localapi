package com.pocketpal

import com.facebook.react.TurboReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.module.model.ReactModuleInfo
import com.facebook.react.module.model.ReactModuleInfoProvider
import com.pocketpal.specs.NativeTwinCorePerfSpec

class TwinCorePerfPackage : TurboReactPackage() {
  override fun getModule(name: String, reactContext: ReactApplicationContext): NativeModule? {
    return if (name == NativeTwinCorePerfSpec.NAME) {
      TwinCorePerfModule(reactContext)
    } else {
      null
    }
  }

  override fun getReactModuleInfoProvider(): ReactModuleInfoProvider {
    return ReactModuleInfoProvider {
      mapOf(
        NativeTwinCorePerfSpec.NAME to ReactModuleInfo(
          NativeTwinCorePerfSpec.NAME,
          NativeTwinCorePerfSpec.NAME,
          false, // canOverrideExistingModule
          false, // needsEagerInit
          false, // hasConstants
          false, // isCxxModule
          true   // isTurboModule
        )
      )
    }
  }
}
