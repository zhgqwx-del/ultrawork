#!/bin/bash
# Ultrawork 快速启动脚本（委托给 setup.sh）
exec "$(dirname "$0")/setup.sh" --dev "$@"
