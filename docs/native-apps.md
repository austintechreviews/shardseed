# Native Apps

Shardseed Desktop is packaged with Tauri for macOS, Linux, and Windows. The production build does not run a webserver; it compiles the React interface to static assets and bundles those assets inside the native app.

## Local Development

```bash
npm install
npm run desktop:dev
```

`desktop:dev` opens the native Tauri application. During development only, Tauri starts Vite on `127.0.0.1` as a local asset server so hot reload works.

## Local Native Build

```bash
npm run desktop:build
```

The native bundles are written under:

```text
target/release/bundle/
```

Tauri builds should be produced on the target operating system. Build macOS bundles on macOS, Windows bundles on Windows, and Linux bundles on Linux.

## Continuous Builds And Releases

The GitHub Actions workflow at `.github/workflows/native-builds.yml` builds Shardseed Desktop on:

- macOS
- Ubuntu Linux
- Windows

Pull requests upload native bundle output as temporary workflow artifacts. Tagged releases attach native app packages to the GitHub Release. App packages are never committed to the repository, so contributors can clone, compile, and run the repo without downloading prebuilt installers.

Release signing and notarization are intentionally left out until signing identities and certificates are available.
