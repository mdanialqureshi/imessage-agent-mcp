# Releasing

Releases are built on the maintainer's Mac, because that's where the Developer ID certificate, the notarization credentials and the update signing key are. None of them are in the repo or in GitHub.

You need:

- a **Developer ID Application** certificate and its private key in your login keychain (`security find-identity -v -p codesigning` lists it);
- a **notarytool Keychain profile** (`xcrun notarytool store-credentials <profile>`), so no password is ever typed into a command;
- the **update signing key**, an Ed25519 private key kept outside the repo whose public half is `UPDATE_PUBLIC_KEY` in `src/update.ts`.

## Steps

1. Bump `version` in `package.json`, commit, and push `master`. Wait for CI to pass.
2. Build, sign and notarize from that commit (with a clean working tree):
   ```sh
   node scripts/build-app.mjs --identity "Developer ID Application: <Name> (<TEAMID>)" --notarize <profile>
   ```
   It refuses to run with uncommitted changes or a commit that isn't on `origin/master`. It signs everything with the hardened runtime and a secure timestamp, notarizes and staples the app, then the disk image, and writes `dist/Messages-Agent-<version>.dmg`, `.zip` and `SHA256SUMS.txt`.
3. Sign the checksums for the in-app updater, and check the signature against the key the app ships with:
   ```sh
   openssl pkeyutl -sign -rawin -inkey <key.pem> -in dist/SHA256SUMS.txt -out sig.bin
   base64 -i sig.bin > dist/SHA256SUMS.txt.sig && rm sig.bin
   grep -o "UPDATE_PUBLIC_KEY = '[^']*'" src/update.ts | cut -d"'" -f2 | base64 -d > pub.der
   base64 -d -i dist/SHA256SUMS.txt.sig > sig.bin
   openssl pkeyutl -verify -pubin -keyform DER -inkey pub.der -rawin -in dist/SHA256SUMS.txt -sigfile sig.bin && rm pub.der sig.bin
   ```
4. Check the build: `spctl -a -vv "dist/Messages Agent.app"` says `source=Notarized Developer ID`, `xcrun stapler validate` passes on the app and the disk image, and `IMESSAGE_AGENT_APP="dist/Messages Agent.app" node --test test/app.test.ts` passes.
5. Publish it with its tag on that commit:
   ```sh
   gh release create v<version> --target <commit> --title "Messages Agent v<version>" --notes-file <notes> \
     dist/Messages-Agent-<version>.dmg dist/Messages-Agent-<version>.zip dist/SHA256SUMS.txt dist/SHA256SUMS.txt.sig
   ```
   The new tag runs `.github/workflows/release.yml`, which builds and tests the tagged source and checks what was published: the tag is on `master` and matches `package.json`, the files are exactly the listed ones and match their checksums, the signature verifies with the app's key, and the app is that version, signed with a Developer ID, notarized, and passes the app tests.

If the `check` job fails, delete the release (or mark it a pre-release) right away: installed apps look at the latest release, and they check it themselves, but nothing broken should stay there.

Installed apps take an update only if it carries the release key's signature, and, when they were signed with a Developer ID themselves, only if Apple's certificate says it's the same team and it's notarized. So a release must always be signed by the same Apple team: a different one would stop every installed copy from updating.

If the update key is ever exposed, generate a new pair, put the new public half in `src/update.ts` and ship that release by hand: apps with the old key won't accept updates signed with the new one.
