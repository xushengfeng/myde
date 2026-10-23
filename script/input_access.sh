#!/usr/bin/env bash
# 给输入设备加 uaccess 规则，让“当前活动会话的用户”能读 /dev/input/event*。
#
# myde 优先通过 systemd-logind 打开输入设备（TakeDevice），从 TTY/登录会话
# 启动时不需要本脚本。只有回退到直接读 evdev（非 systemd、没有 seat 的会话，
# 或 logind 不可用）时才需要授权：系统默认只把输入设备给 root:input。
# 这条规则把设备标成 uaccess，由 systemd-logind 给活动会话的用户加 ACL，
# 不需要把用户永久加入 input 组，也不需要 root 常驻。
#
# 用法：
#   script/input_access.sh          安装规则并立即生效（自动 sudo）
#   script/input_access.sh status   查看规则是否存在、设备当前是否可读
#   script/input_access.sh remove   移除规则并清理 ACL
#
# 说明：uaccess 只对设备所属 seat 上“当前活动会话”的用户授权。切到别的 TTY
# 后由那边的会话接管（这也正是 logind 的语义）；需要跨会话/后台读取时才用
# input 组。
set -euo pipefail

rule=/etc/udev/rules.d/70-myde-input.rules
rule_body='# myde: 允许活动会话的用户读取输入设备（uaccess 由 systemd-logind 授权）
SUBSYSTEM=="input", KERNEL=="event*", TAG+="uaccess"'

# 发起调用的用户（sudo 后 $USER 变成 root）
invoking_user="${SUDO_USER:-$(id -un)}"

# 活动会话用户：uaccess 的 ACL 只加给这个用户
active_session_user() {
    local sid
    sid="$(loginctl show-seat seat0 -p ActiveSession --value 2>/dev/null || true)"
    [ -n "$sid" ] || return 0
    loginctl show-session "$sid" -p Name --value 2>/dev/null || true
}

need_root() {
    if [ "$(id -u)" -ne 0 ]; then
        exec sudo -- "$0" "$@"
    fi
}

reload_udev() {
    udevadm control --reload
    udevadm trigger --subsystem-match=input --action=change
    udevadm settle
}

first_event_node() {
    ls /dev/input/event* 2>/dev/null | head -n 1
}

# 以目标用户的身份判断某个设备节点是否可读
can_read_as() {
    local user="$1" node="$2"
    if [ "$(id -u)" -eq 0 ]; then
        runuser -u "$user" -- test -r "$node" 2>/dev/null
    elif [ "$(id -un)" = "$user" ]; then
        test -r "$node"
    else
        return 1
    fi
}

report() {
    local node user
    user="${SUDO_USER:-}"
    if [ -z "$user" ] || [ "$user" = root ]; then
        user="$(active_session_user)"
    fi
    node="$(first_event_node)"
    echo
    if [ -f "$rule" ]; then
        echo "规则：$rule（已安装）"
    else
        echo "规则：$rule（未安装）"
    fi
    if [ -z "$node" ]; then
        echo "未找到 /dev/input/event*"
        return 0
    fi
    echo "活动会话用户：${user:-未知}"
    if [ -n "$user" ] && can_read_as "$user" "$node"; then
        echo "输入设备：可读（$node）"
        echo "现在重新运行 ./myde-wrap myde 即可使用鼠标键盘"
    else
        echo "输入设备：不可读（$node）"
        if [ -n "$user" ] && [ "$user" != "$(active_session_user)" ]; then
            echo "注意：$user 不是当前活动会话的用户，uaccess 不会给它授权；切到该用户的前台 TTY 后再试"
        else
            echo "如果规则已安装仍不可读：确认系统使用 systemd-logind（而非纯 seatd），或改用 input 组："
            echo "  sudo usermod -aG input $user   # 重新登录后生效"
        fi
    fi
}

cmd="${1:-install}"
case "$cmd" in
install)
    need_root "$@"
    printf '%s\n' "$rule_body" >"$rule"
    echo "已写入 $rule"
    reload_udev
    report
    ;;
status)
    report
    ;;
remove)
    need_root "$@"
    rm -f "$rule"
    echo "已删除 $rule"
    reload_udev
    # udev 不会因为标签消失而主动撤销已经加上的 ACL，这里清掉
    if command -v setfacl >/dev/null 2>&1; then
        for node in /dev/input/event*; do
            [ -e "$node" ] && setfacl -b "$node"
        done
    fi
    report
    ;;
*)
    echo "用法: $0 [install|status|remove]" >&2
    exit 2
    ;;
esac
