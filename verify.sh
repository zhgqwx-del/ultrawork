#!/usr/bin/env bash
set -uo pipefail

# Ultrawork 自动化验证脚本
# 用于验证代码质量和构建状态

echo "🧪 Ultrawork 自动化验证"
echo "================================"
echo ""

# 颜色定义
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

# 测试计数
TOTAL_TESTS=0
PASSED_TESTS=0
FAILED_TESTS=0

run_test() {
    local test_name=$1
    local test_command=$2

    TOTAL_TESTS=$((TOTAL_TESTS + 1))
    echo -n "[$TOTAL_TESTS] $test_name... "

    if eval "$test_command" > /dev/null 2>&1; then
        echo -e "${GREEN}✅ PASS${NC}"
        PASSED_TESTS=$((PASSED_TESTS + 1))
        return 0
    else
        echo -e "${RED}❌ FAIL${NC}"
        FAILED_TESTS=$((FAILED_TESTS + 1))
        return 1
    fi
}

# ── Phase 1: 依赖检查 ─────────────────────────

echo "📦 Phase 1: 依赖检查"
echo "--------------------------------"

run_test "bun 已安装" "command -v bun"
run_test "cargo 已安装" "command -v cargo"
run_test "node_modules 存在" "test -d node_modules"
run_test "vendor/opencode 子模块已初始化" "test -d vendor/opencode/packages"

# ── Phase 2: 文件结构验证 ──────────────────────

echo ""
echo "📁 Phase 2: 文件结构验证"
echo "--------------------------------"

run_test "user-message.tsx 存在" "test -f packages/client/desktop/src/components/chat/user-message.tsx"
run_test "assistant-message.tsx 存在" "test -f packages/client/desktop/src/components/chat/assistant-message.tsx"
run_test "sse-client.ts 存在" "test -f packages/client/desktop/src/lib/sse-client.ts"
run_test "tabs.tsx 存在" "test -f packages/client/desktop/src/components/ui/tabs.tsx"
run_test "theme-context.tsx 存在" "test -f packages/client/desktop/src/lib/theme-context.tsx"
run_test "i18n-context.tsx 存在" "test -f packages/client/desktop/src/lib/i18n-context.tsx"
run_test "use-favorites.ts 存在" "test -f packages/client/desktop/src/lib/use-favorites.ts"

# ── Phase 3: 代码特性验证 ──────────────────────

echo ""
echo "🔍 Phase 3: 代码特性验证"
echo "--------------------------------"

run_test "用户消息右对齐" "grep -q 'justify-end' packages/client/desktop/src/components/chat/user-message.tsx"
run_test "智能滚动实现" "grep -q 'isAtBottom' packages/client/desktop/src/pages/Session.tsx"
run_test "SSE 重连标志" "grep -q 'shouldReconnect' packages/client/desktop/src/lib/sse-client.ts"
run_test "主题切换实现" "grep -q 'ThemeProvider' packages/client/desktop/src/lib/theme-context.tsx"
run_test "国际化实现" "grep -q 'translations' packages/client/desktop/src/lib/i18n-context.tsx"
run_test "标签页组件" "grep -q 'TabsList' packages/client/desktop/src/components/ui/tabs.tsx"
run_test "日期分组实现" "grep -q 'groupSessionsByDate' packages/client/desktop/src/components/layout/left-sidebar.tsx"
run_test "搜索功能实现" "grep -q 'searchQuery' packages/client/desktop/src/components/layout/left-sidebar.tsx"
run_test "收藏功能实现" "grep -q 'toggleFavorite' packages/client/desktop/src/lib/use-favorites.ts"

# ── Phase 4: TypeScript 类型检查 ───────────────

echo ""
echo "🔧 Phase 4: TypeScript 类型检查"
echo "--------------------------------"

echo -n "[$((TOTAL_TESTS + 1))] TypeScript 类型检查... "
TOTAL_TESTS=$((TOTAL_TESTS + 1))

if bun run --bun turbo run typecheck 2>&1 | grep -q "Tasks:.*successful"; then
    echo -e "${GREEN}✅ PASS${NC}"
    PASSED_TESTS=$((PASSED_TESTS + 1))
else
    echo -e "${RED}❌ FAIL${NC}"
    FAILED_TESTS=$((FAILED_TESTS + 1))
fi

# ── Phase 5: 构建测试 ─────────────────────────

echo ""
echo "🏗️  Phase 5: 构建测试"
echo "--------------------------------"

echo -n "[$((TOTAL_TESTS + 1))] Vite 构建... "
TOTAL_TESTS=$((TOTAL_TESTS + 1))

if bun run --bun turbo run build 2>&1 | grep -q "Tasks:.*successful"; then
    echo -e "${GREEN}✅ PASS${NC}"
    PASSED_TESTS=$((PASSED_TESTS + 1))
else
    echo -e "${RED}❌ FAIL${NC}"
    FAILED_TESTS=$((FAILED_TESTS + 1))
fi

# ── Phase 6: 构建产物检查 ──────────────────────

echo ""
echo "📊 Phase 6: 构建产物检查"
echo "--------------------------------"

run_test "dist 目录存在" "test -d packages/client/desktop/dist"
run_test "index.html 存在" "test -f packages/client/desktop/dist/index.html"
run_test "CSS 文件存在" "find packages/client/desktop/dist/assets -name '*.css' | grep -q ."
run_test "JS 文件存在" "find packages/client/desktop/dist/assets -name '*.js' | grep -q ."

# ── Phase 7: 文档与脚本完整性 ─────────────────

echo ""
echo "📝 Phase 7: 文档与脚本完整性"
echo "--------------------------------"

run_test "README.md 存在" "test -f README.md"
run_test "CHANGELOG.md 存在" "test -f CHANGELOG.md"
run_test "docs/conventions.md 存在" "test -f docs/conventions.md"
run_test "docs/architecture-phase1.md 存在" "test -f docs/architecture-phase1.md"
run_test "setup.sh 可执行" "test -x setup.sh"
run_test "start.sh 可执行" "test -x start.sh"

# ── 结果汇总 ──────────────────────────────────

echo ""
echo "================================"
echo "📊 测试结果汇总"
echo "================================"
echo ""
echo "总测试数: $TOTAL_TESTS"
echo -e "${GREEN}通过: $PASSED_TESTS${NC}"
echo -e "${RED}失败: $FAILED_TESTS${NC}"
echo ""

PASS_RATE=$((PASSED_TESTS * 100 / TOTAL_TESTS))

if [ $FAILED_TESTS -eq 0 ]; then
    echo -e "${GREEN}🎉 所有测试通过！(100%)${NC}"
    exit 0
else
    echo -e "${YELLOW}⚠️  部分测试失败 (通过率: $PASS_RATE%)${NC}"
    echo "请检查失败的测试项"
    exit 1
fi
