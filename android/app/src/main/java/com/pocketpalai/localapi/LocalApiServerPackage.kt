package com.pocketpal.localapi

import com.facebook.react.TurboReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.module.model.ReactModuleInfo
import com.facebook.react.module.model.ReactModuleInfoProvider
import com.pocketpal.specs.NativeLocalApiServerSpec

class LocalApiServerPackage : TurboReactPackage() {
  override fun getModule(
      name: String,
      reactContext: ReactApplicationContext,
  ): NativeModule? {
    return if (name == NativeLocalApiServerSpec.NAME) {
      LocalApiServerModule(reactContext)
    } else {
      null
    }
  }

  override fun getReactModuleInfoProvider(): ReactModuleInfoProvider {
    return ReactModuleInfoProvider {
      mapOf(
          NativeLocalApiServerSpec.NAME to
              ReactModuleInfo(
                  NativeLocalApiServerSpec.NAME,
                  NativeLocalApiServerSpec.NAME,
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
