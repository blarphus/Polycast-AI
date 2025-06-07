load("//gdm/showcase/applets/build_defs:build_defs.bzl", "applet")
load("//javascript/typescript:build_defs.bzl", "disable_taze")

package(default_visibility = [
    "//gdm/showcase/applets:__subpackages__",
])

disable_taze(reason = "b/398254100: Applets use external libraries and are not blaze compatible")

applet(
    name = "live_audio",
    srcs = glob(["**"]),
)
