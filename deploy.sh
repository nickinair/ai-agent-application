#!/usr/bin/env bash
# ==============================================================================
# a3 体系容器化一体化部署器 (Deploy Runner) 快捷入口
# ==============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "${SCRIPT_DIR}/scripts/deploy.sh" "$@"
