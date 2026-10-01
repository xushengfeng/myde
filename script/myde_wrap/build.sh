#!/usr/bin/env bash
# 下载 myde-wrap 源码并编译，把可执行文件输出到 resources/myde-wrap。
#
# electron-builder 打包（npm run pack / npm run dist）时会检测该文件，
# 存在则一起打进安装包（安装目录下的 myde-wrap），不存在则跳过，
# 所以普通开发（没有编译过 myde-wrap）不受影响。
#
# 环境变量（均有默认值，可按需覆盖）：
#   MYDE_WRAP_REPO     源码仓库地址，默认 https://github.com/xushengfeng/myde-wrap.git
#   MYDE_WRAP_REF      分支 / 标签 / 完整 commit hash（短 hash 不支持），
#                      默认固定在与当前 myde 兼容的 commit
#   MYDE_WRAP_DIR      源码下载目录（target 也在这里），默认 ${TMPDIR:-/tmp/opencode}/myde-wrap
#   MYDE_WRAP_PROFILE  release（默认）或 debug
#   MYDE_WRAP_OUT      编译产物输出路径，默认 <repo>/resources/myde-wrap
#
# 依赖：git、cargo（rustup: https://rustup.rs）以及 myde-wrap 的系统库，
# Ubuntu/Debian 上为：
#   pkg-config libdrm-dev libgbm-dev libudev-dev libinput-dev \
#   libseat-dev libpixman-1-dev libxkbcommon-dev
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
root_dir="$(cd -- "$script_dir/../.." && pwd)"

# myde-wrap 当前固定版本（更新时同步改 .github/workflows/build.yml 与 README）
default_ref="983fbc7f0157bc8e3af1a1a522230605c273a3b6"

repo="${MYDE_WRAP_REPO:-https://github.com/xushengfeng/myde-wrap.git}"
ref="${MYDE_WRAP_REF:-$default_ref}"
work_dir="${MYDE_WRAP_DIR:-${TMPDIR:-/tmp/opencode}/myde-wrap}"
profile="${MYDE_WRAP_PROFILE:-release}"
out="${MYDE_WRAP_OUT:-$root_dir/resources/myde-wrap}"

if ! command -v git >/dev/null 2>&1; then
    echo "myde-wrap: 未找到 git" >&2
    exit 1
fi
if ! command -v cargo >/dev/null 2>&1; then
    echo "myde-wrap: 未找到 cargo，请先安装 rust（https://rustup.rs）" >&2
    exit 1
fi

echo "myde-wrap: $repo @ $ref -> $out"

# 浅克隆指定 ref（分支 / 标签 / 完整 commit hash），目录可复用
if [ ! -d "$work_dir/.git" ]; then
    mkdir -p "$work_dir"
    git -C "$work_dir" init -q
fi
if git -C "$work_dir" remote get-url origin >/dev/null 2>&1; then
    git -C "$work_dir" remote set-url origin "$repo"
else
    git -C "$work_dir" remote add origin "$repo"
fi
git -C "$work_dir" fetch -q --depth 1 origin "$ref"
git -C "$work_dir" checkout -q --force FETCH_HEAD
echo "myde-wrap: 源码就绪 $(git -C "$work_dir" rev-parse --short HEAD)"

if [ ! -f "$work_dir/Cargo.toml" ]; then
    echo "myde-wrap: 源码缺少 Cargo.toml: $work_dir" >&2
    exit 1
fi

cargo_args=(build --manifest-path "$work_dir/Cargo.toml" --target-dir "$work_dir/target")
if [ "$profile" = "release" ]; then
    cargo_args+=(--release)
fi
cargo "${cargo_args[@]}"

bin="$work_dir/target/$profile/myde-wrap"
if [ ! -f "$bin" ]; then
    echo "myde-wrap: 编译产物不存在: $bin" >&2
    exit 1
fi

mkdir -p "$(dirname "$out")"
install -m 755 "$bin" "$out"
echo "myde-wrap: 已输出 $out ($(du -h "$out" | cut -f1))"
