#!/bin/bash

# Ultrawork 快速启动脚本

echo "🚀 Ultrawork Desktop - 快速启动"
echo "================================"
echo ""

# 设置环境
export BUN_INSTALL="$HOME/.bun"
export PATH="$HOME/.cargo/bin:$BUN_INSTALL/bin:$PATH"

# 检查 bun
if ! command -v bun &> /dev/null; then
    echo "❌ 错误: 未找到 Bun"
    echo "请先安装 Bun: curl -fsSL https://bun.sh/install | bash"
    exit 1
fi

echo "✅ Bun 版本: $(bun --version)"

# 检查依赖
if [ ! -d "node_modules" ]; then
    echo "📦 安装依赖..."
    bun install
fi

echo ""
echo "🔧 运行类型检查..."
bun run --bun turbo run typecheck

if [ $? -ne 0 ]; then
    echo "❌ 类型检查失败"
    exit 1
fi

echo "✅ 类型检查通过"
echo ""

echo "🏗️  构建应用..."
bun run --bun turbo run build

if [ $? -ne 0 ]; then
    echo "❌ 构建失败"
    exit 1
fi

echo "✅ 构建成功"
echo ""

echo "📋 启动前检查清单:"
echo "  1. OpenCode 服务器是否运行? (http://localhost:4096)"
echo "  2. OpenCode 密码是否已在设置中配置?"
echo ""

read -p "按 Enter 继续启动开发服务器..."

echo ""
echo "🎉 启动开发服务器..."
echo "================================"
echo ""
echo "访问: http://localhost:1420"
echo ""
echo "按 Ctrl+C 停止服务器"
echo ""

cd packages/client/desktop && bun run --bun vite dev
