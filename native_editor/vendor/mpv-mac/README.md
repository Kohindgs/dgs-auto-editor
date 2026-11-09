# Mac libmpv (optional)

Place `libmpv.2.dylib` (and any dependent `.dylib` files) here before `npm run dist:mac`.

If this folder is empty, the Mac DMG still builds. Preview then uses Homebrew `ffplay` / in-app fallbacks when those tools are installed.
