#!/usr/bin/env bash
# 同步上游 huggingface/speech-to-speech 到本 fork 并推送
#
# 用法:
#   ./sync-upstream.sh              # 拉取上游 + 合并到 main + 推送 origin
#   ./sync-upstream.sh --continue   # 手动解决完冲突后，完成合并并推送
#   ./sync-upstream.sh --no-push    # 只合并到本地 main，不推送
#   ./sync-upstream.sh --help       # 显示帮助
#
# 首次使用会自动添加 upstream remote；发生冲突时脚本会列出冲突文件并退出，
# 你手动解决后（git add <文件>）再运行 `./sync-upstream.sh --continue` 即可。
set -euo pipefail

cd "$(dirname "$0")"

UPSTREAM_URL="https://github.com/huggingface/speech-to-speech.git"
BRANCH="main"
REMOTE="upstream"

# ---------- 输出辅助 ----------
log()  { printf '\033[1;34m[sync]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[sync]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[sync]\033[0m %s\n' "$*" >&2; exit 1; }

usage() {
    cat <<'EOF'
用法:
  ./sync-upstream.sh              # 拉取上游 + 合并到 main + 推送 origin
  ./sync-upstream.sh --continue   # 解决完冲突后，完成合并并推送
  ./sync-upstream.sh --no-push    # 只合并到本地 main，不推送
  ./sync-upstream.sh --help       # 显示帮助
EOF
}

# ---------- 解析参数 ----------
PUSH=1
CONTINUE=0
for arg in "$@"; do
    case "$arg" in
        --no-push)     PUSH=0 ;;
        --continue|-c) CONTINUE=1 ;;
        -h|--help)     usage; exit 0 ;;
        *) die "未知参数: $arg（可用 --no-push / --continue / --help）" ;;
    esac
done

# ---------- 前置检查 ----------
[ -d .git ] || die "当前目录不是 git 仓库"
current_branch="$(git rev-parse --abbrev-ref HEAD)"
[ "$current_branch" = "$BRANCH" ] || die "请先切换到 $BRANCH 分支（当前: $current_branch）"

# 确保 upstream remote 存在
if ! git remote get-url "$REMOTE" >/dev/null 2>&1; then
    log "首次使用，添加 $REMOTE remote"
    git remote add "$REMOTE" "$UPSTREAM_URL"
fi

# ---------- 继续模式：完成冲突合并 ----------
if [ "$CONTINUE" = 1 ]; then
    # 还有未解决的冲突吗？
    if git diff --name-only --diff-filter=U | grep -q .; then
        warn "仍有未解决的冲突文件："
        git diff --name-only --diff-filter=U | sed 's/^/  /'
        die "请先解决上述冲突（git add <文件>）再运行 --continue"
    fi

    # 合并尚未完成？
    if [ -f .git/MERGE_HEAD ]; then
        log "完成合并提交"
        git commit --no-edit
    else
        log "没有待完成的合并，直接推送"
    fi

    if [ "$PUSH" = 1 ]; then
        log "推送到 origin/$BRANCH"
        git push origin "$BRANCH"
    fi
    log "完成 ✅"
    exit 0
fi

# ---------- 普通模式 ----------
# 有未提交的 tracked 改动则中止（untracked 文件不影响合并）
if ! git diff --quiet || ! git diff --cached --quiet; then
    die "有未提交的改动，请先 git commit 或 git stash"
fi

log "拉取 $REMOTE/$BRANCH"
git fetch "$REMOTE" "$BRANCH"

# 已经是最新？
if git merge-base --is-ancestor "$REMOTE/$BRANCH" HEAD; then
    log "已是最新，无需同步"
    exit 0
fi

log "合并 $REMOTE/$BRANCH 到 $BRANCH"
if ! git merge "$REMOTE/$BRANCH" --no-edit; then
    if git diff --name-only --diff-filter=U | grep -q .; then
        warn "合并产生冲突，请手动解决以下文件："
        git diff --name-only --diff-filter=U | sed 's/^/  /'
        echo
        warn "解决步骤："
        echo "  1) 编辑冲突文件，删除 <<<<<<< / ======= / >>>>>>> 标记"
        echo "  2) git add <已解决的文件>"
        echo "  3) 运行: ./sync-upstream.sh --continue"
        exit 1
    fi
    die "合并失败（非冲突原因），请检查上面的 git 输出"
fi

log "合并完成"

if [ "$PUSH" = 1 ]; then
    log "推送到 origin/$BRANCH"
    git push origin "$BRANCH"
fi

log "同步完成 ✅"
