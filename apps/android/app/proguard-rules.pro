# JNA binds native symbols and marshals Structure/Callback types by
# reflection over class, method and field names, so R8 must not rename or
# strip any of it.
-keep class com.sun.jna.** { *; }
-keep class * implements com.sun.jna.** { *; }
-dontwarn java.awt.**

# The uniffi-bindgen output (packages uniffi.*) declares its FFI structs,
# callback vtables and the Library interface JNA proxies. Their shape is
# looked up reflectively at load time; renaming a field breaks the ABI
# without any compile-time error.
-keep class uniffi.** { *; }
