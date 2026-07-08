#!/usr/bin/env bash
#
# Push helper for pi-nvidia-rate-limit-retry.
#
# 1. Create the empty GitHub repo first:
#      gh repo create <owner>/pi-nvidia-rate-limit-retry --public --description \
#        "pi extension: transparent retries for NVIDIA NIM rate-limit errors"
#    (or do it manually at https://github.com/new)
#
# 2. Run this script from the repo root to push main + v1.0.0 tag.
#
# Usage: ./scripts/push.sh <owner>
#   <owner> = your GitHub user or org

set -euo pipefail

OWNER="${1:?Usage: $0 <github-owner>}"
REPO="pi-nvidia-rate-limit-retry"
URL="git@github.com:${OWNER}/${REPO}.git"

echo "Adding remote: ${URL}"
git remote remove origin 2>/dev/null || true
git remote add origin "${URL}"

echo "Pushing main..."
git push -u origin main

echo "Pushing tags..."
git push --tags

echo
echo "Done. Repo is live at: https://github.com/${OWNER}/${REPO}"
echo
echo "Test install from another machine:"
echo "  pi install git:github.com/${OWNER}/${REPO}@v1"
