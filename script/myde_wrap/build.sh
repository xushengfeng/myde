#!/usr/bin/env bash
# 编译仓库内的 myde-wrap（Rust 合成器），把可执行文件输出到 resources/myde-wrap。
#
# electron-builder 打包（npm run pack / npm run dist）时会检测该文件，
# 存在则一起打进安装包（安装目录下的 myde-wrap），不存在则跳过，
# 所以普通开发（没有编译过 myde-wrap）不受影响。
#
# 环境变量（均有默认值，可按需覆盖）：
#   MYDE_WRAP_DIR      源码目录，默认 <repo>/myde-wrap
#   MYDE_WRAP_PROFILE  release（默认）或 debug
#   MYDE_WRAP_OUT      编译产物输出路径，默认 <repo>/resources/myde-wrap
#
# 依赖：cargo（rustup: https://rustup.rs）以及 myde-wrap 的系统库，
# Ubuntu/Debian 上为：
#   pkg-config libdrm-dev libgbm-dev libudev-dev libinput-dev \
#   libseat-dev libpixman-1-dev libxkbcommon-dev
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
root_dir="$(cd -- "$script_dir/../.." && pwd)"

src_dir="${MYDE_WRAP_DIR:-$root_dir/myde-wrap}"
profile="${MYDE_WRAP_PROFILE:-release}"
out="${MYDE_WRAP_OUT:-$root_dir/resources/myde-wrap}"

if ! command -v cargo >/dev/null 2>&1; then
    echo "myde-wrap: 未找到 cargo，请先安装 rust（https://rustup.rs）" >&2
    exit 1
fi
if [ ! -f "$src_dir/Cargo.toml" ]; then
    echo "myde-wrap: 源码缺少 Cargo.toml: $src_dir" >&2
    exit 1
fi

echo "myde-wrap: $src_dir -> $out"

cargo_args=(build --manifest-path "$src_dir/Cargo.toml" --target-dir "$src_dir/target")
if [ "$profile" = "release" ]; then
    cargo_args+=(--release)
fi
cargo "${cargo_args[@]}"

bin="$src_dir/target/$profile/myde-wrap"
if [ ! -f "$bin" ]; then
    echo "myde-wrap: 编译产物不存在: $bin" >&2
    exit 1
fi

mkdir -p "$(dirname "$out")"
install -m 755 "$bin" "$out"
echo "myde-wrap: 已输出 $out ($(du -h "$out" | cut -f1))"
