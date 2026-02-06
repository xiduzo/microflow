# Release Setup Guide

This guide explains how to configure GitHub Actions for building and releasing Microflow with code signing, notarization, and auto-updates.

## Required GitHub Secrets

Go to your repository → Settings → Secrets and variables → Actions → New repository secret

### macOS Code Signing & Notarization

| Secret | Description |
|--------|-------------|
| `APPLE_CERTIFICATE` | Base64-encoded .p12 certificate |
| `APPLE_CERTIFICATE_PASSWORD` | Password for the .p12 file |
| `APPLE_SIGNING_IDENTITY` | e.g., `Developer ID Application: Your Name (TEAMID)` |
| `APPLE_ID` | Your Apple ID email |
| `APPLE_PASSWORD` | App-specific password (not your Apple ID password) |
| `APPLE_TEAM_ID` | Your 10-character Team ID |
| `KEYCHAIN_PASSWORD` | Any secure password for the CI keychain |

### Tauri Updater (Required for auto-updates)

| Secret | Description |
|--------|-------------|
| `TAURI_SIGNING_PRIVATE_KEY` | Private key for update signatures |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Password for the private key |

## Step-by-Step Setup

### 1. Generate Tauri Updater Keys

```bash
# Generate a keypair for signing updates
bun tauri signer generate -w ~/.tauri/microflow.key

# This outputs:
# - Private key saved to ~/.tauri/microflow.key
# - Public key printed to console
```

Copy the public key and update `apps/web/src-tauri/tauri.conf.json`:
```json
{
  "plugins": {
    "updater": {
      "pubkey": "YOUR_PUBLIC_KEY_HERE",
      "endpoints": [
        "https://github.com/YOUR_USERNAME/YOUR_REPO/releases/latest/download/latest.json"
      ]
    }
  }
}
```

Set the private key as GitHub secrets:
- `TAURI_SIGNING_PRIVATE_KEY`: Contents of `~/.tauri/microflow.key`
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`: Password you used when generating

### 2. Create a Developer ID Certificate

1. Open **Keychain Access** on your Mac
2. Go to **Keychain Access → Certificate Assistant → Request a Certificate from a Certificate Authority**
3. Enter your email, select "Saved to disk", save the `.certSigningRequest` file
4. Go to [Apple Developer Certificates](https://developer.apple.com/account/resources/certificates/list)
5. Click **+** to create a new certificate
6. Select **Developer ID Application** (for distribution outside App Store)
7. Upload your `.certSigningRequest` file
8. Download the certificate and double-click to install it

### 3. Export Certificate for CI

```bash
# Find your signing identity
security find-identity -v -p codesigning

# Export from Keychain Access:
# 1. Open Keychain Access
# 2. Find your certificate under "My Certificates"
# 3. Expand it, right-click the private key, select "Export"
# 4. Save as .p12 with a strong password

# Convert to base64
base64 -i certificate.p12 -o certificate-base64.txt

# Copy contents of certificate-base64.txt to APPLE_CERTIFICATE secret
```

### 4. Create App-Specific Password

1. Go to [appleid.apple.com](https://appleid.apple.com)
2. Sign in → Security → App-Specific Passwords
3. Generate a new password named "Microflow Notarization"
4. Save this as `APPLE_PASSWORD` secret

### 5. Find Your Team ID

1. Go to [Apple Developer Membership](https://developer.apple.com/account/#/membership)
2. Your Team ID is displayed there (10 characters)

### 6. Get Your Signing Identity

```bash
security find-identity -v -p codesigning
```

Look for: `Developer ID Application: Your Name (TEAMID123)`

## Triggering a Release

### Via Git Tag

```bash
# Update version in apps/web/src-tauri/tauri.conf.json
git add .
git commit -m "chore: bump version to 1.0.0"
git tag v1.0.0
git push origin main --tags
```

### Via Manual Dispatch

1. Go to Actions → Release workflow
2. Click "Run workflow"
3. Optionally specify a version

## Workflow Overview

The release workflow:

1. Creates a draft GitHub release
2. Builds for all platforms in parallel:
   - macOS Intel (x86_64)
   - macOS Apple Silicon (aarch64)
   - Windows (x86_64)
   - Linux (x86_64)
3. Signs and notarizes macOS builds
4. Signs update bundles with Tauri updater key
5. Uploads all artifacts + `latest.json` to the release
6. Publishes the release

## Auto-Update Flow

Once configured, the app will:
1. Check for updates on startup (production only)
2. Download the `latest.json` from your GitHub releases
3. Compare versions and prompt user if update available
4. Download, verify signature, and install the update

## Troubleshooting

### "Team is not yet configured for notarization"

Contact Apple Developer Support. New accounts sometimes need manual activation.

### Certificate import fails

Ensure the certificate was exported with the private key included (expand the certificate in Keychain Access and export the key).

### Notarization timeout

Apple's notarization service can be slow. The workflow will wait up to 30 minutes.

### "Resource not accessible by integration"

Go to repository Settings → Actions → Workflow permissions → Enable "Read and write permissions"

### Update signature verification fails

Ensure `TAURI_SIGNING_PRIVATE_KEY` matches the public key in `tauri.conf.json`.
